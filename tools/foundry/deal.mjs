// Сделка луны в настоящей Foundry: node tools/foundry/deal.mjs [--headed] [--slow[=мс]]
// Карта этажа на тестовой сцене, отряд на узле Босса. Окно у Мастера: три лота, жертвы кладутся щелчком
// по карте навыка и жетонам тела, вес и фаза луны, забрать жертву, печать с выбором получателя.
// Проверяется списание (навык сгорел, Кость Хитов, максимум ПЗ, слот Памяти, кристалл Хранилища, золото)
// и лоты: Чужая память, Сплав (один слот, сгорают вместе), Отголосок Босса (отметка), отказ без потерь.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, PREFIX } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const settle = () => ev(() => gdt.settle());

await install(page);
const ids = await scene(page, { hero: { level: 5 } });

// Отряд: герой и союзник — персонажи «игрока» (в тестовом мире игроков нет: свойство подменяется на время проверки)
const party = await ev(async ({ hero, PREFIX }) => {
    const ally = await Actor.create({
        name: `${PREFIX}: Союзник`, type: 'character',
        // Максимум ПЗ союзника считается по классу — луна забирает его эффектом
        system: { attributes: { hp: { value: 40, bonuses: { overall: '40' } } } }, prototypeToken: { actorLink: true, disposition: 1 }
    });
    await ally.createEmbeddedDocuments('Item', [{ name: 'Плут', type: 'class', system: { identifier: 'rogue', levels: 5, hd: { denomination: 'd8' } } }]);
    for (const a of [game.actors.get(hero), ally]) Object.defineProperty(a, 'hasPlayerOwner', { get: () => true, configurable: true });
    // Обычные навыки компендиума: по два серых, зелёных и синих
    const index = await game.packs.get('gachadnd.gacha-skills').getIndex({ fields: ['flags.gachadnd.rarity', 'flags.gachadnd.undeletable'] });
    // Неудаляемые не сжигаются и не сплавляются — для проверки берутся обычные
    const by = r => index.filter(i => i.flags?.gachadnd?.rarity === r && !i.flags.gachadnd.undeletable).map(i => i.name).sort();
    const pickN = (r, n, skip = 0) => by(r).slice(skip, skip + n);
    const inv = await gdt.mod('memory/inventory.js');
    const syn = await gdt.mod('memory/synergy/synergy.js');
    const give = async (actor, names) => {
        for (const name of names) {
            await inv.addSkillToMemory(actor, name, { forced: true });
            const item = actor.items.find(i => i.name === name || i.flags.gachadnd?.skill_name === name);
            if (item) await syn.setSkillEquipped(item, true);
        }
        await syn.updateActorSynergies(actor);
    };
    const heroSkills = [...pickN('gray', 2), ...pickN('green', 1), ...pickN('blue', 1)];
    const allySkills = [...pickN('green', 1, 1), ...pickN('blue', 1, 1)];
    await give(game.actors.get(hero), heroSkills);
    await give(ally, allySkills);
    // Кристалл в Хранилище героя и золото
    const crystals = await gdt.mod('memory/crystals.js');
    const stash = await gdt.mod('memory/stash.js');
    const [crystal] = await game.actors.get(hero).createEmbeddedDocuments('Item', [await crystals.randomCrystal('blue')]);
    await stash.depositCrystal(game.actors.get(hero), crystal);
    await game.actors.get(hero).update({ 'system.currency.gp': 1000 });
    return { ally: ally.id, heroSkills, allySkills };
}, { hero: ids.hero, PREFIX });

// Карта этажа на тестовой сцене, отряд — на узле Босса
const floorBefore = await ev(() => game.settings.get('gachadnd', 'runFloor'));
// Карта рядами на этой сцене: режим и запомненная сцена этажа (песочница бывает с паутиной) — свои на время проверки
const mapBefore = await ev(async () => {
    const before = { mode: game.settings.get('gachadnd', 'mapMode'), scene: game.settings.get('gachadnd', 'floorSceneId') };
    await game.settings.set('gachadnd', 'mapMode', 'rows');
    await game.settings.set('gachadnd', 'floorSceneId', canvas.scene.id);
    return before;
});
// Цены жертв считаются от этажа: проверка — на первом (прошлая проверка могла оставить другой)
await ev(() => game.settings.set('gachadnd', 'runFloor', 1));
await ev(() => game.gachadnd.openMapTerminal());
await wait(800);
await ev(() => { document.querySelector('[name="length"]').value = '6'; document.querySelector('[data-action="generate"]')?.click(); });
await wait(1200);
await ev(async () => {
    for (const a of foundry.applications.instances.values()) if (a.constructor.name === 'GachaMapTerminal') await a.close();
    const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    map.currentNodeId = map.nodes.find(n => n.type === 'boss').id;
    await canvas.scene.setFlag('gachadnd', 'floorMap', map);
});
const deal = () => ev(() => { const m = canvas.scene.getFlag('gachadnd', 'floorMap'); return m.nodes.find(n => n.id === m.currentNodeId).deal ?? null; });
// Лоты сделки: проверка задаёт нужные (в игре — три случайных из пула)
const forceLots = (lots, lot) => ev(async ({ lots, lot }) => {
    const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    const node = map.nodes.find(n => n.id === map.currentNodeId);
    node.deal = { floor: 1, lots, lot, offers: [], status: 'open' };
    await canvas.scene.setFlag('gachadnd', 'floorMap', map);
}, { lots, lot });
const stage = '#gachadnd-moon-deal .gd-deal-stage';
const snapshot = () => ev(({ hero, ally }) => {
    const h = game.actors.get(hero), a = game.actors.get(ally);
    const syn = window._gdSyn;
    return {
        skills: h.items.filter(i => i.flags.gachadnd?.skill_name).map(i => i.name),
        allySkills: a.items.filter(i => i.flags.gachadnd?.skill_name).map(i => i.name),
        hd: h.system.attributes.hd.max, hp: h.system.attributes.hp.max,
        slots: syn?.naturalSlotCap(h), stash: (h.getFlag('gachadnd', 'stash') ?? []).reduce((s, d) => s + (d.system?.quantity || 1), 0),
        gold: h.system.currency.gp
    };
}, { hero: ids.hero, ally: party.ally });
await ev(async () => { window._gdSyn = await gdt.mod('memory/synergy/synergy.js'); });

// ---------- 1. Окно: три лота, луна-серп, рука героя
await ev(() => game.gachadnd.openDeal());
await page.waitForSelector(stage, { timeout: 10000 });
await wait(1200);
let d = await deal();
check('сделка создана на узле Босса: три лота из пула, открыта', d?.lots?.length === 3 && d.status === 'open', JSON.stringify(d?.lots));
const visible = await ev(() => [...document.querySelectorAll('#gachadnd-moon-deal .gd-lot:not([hidden])')].map(l => l.dataset.lot));
check('в окне видны три лота, выбранный — в центре', visible.length === 3 && await ev(() => document.querySelector('#gachadnd-moon-deal .gd-lot.on')?.style.left === '485px'), visible.join(', '));
const hand = await ev(() => ({ cards: document.querySelectorAll('#gachadnd-moon-deal .gd-card').length, tokens: [...document.querySelectorAll('#gachadnd-moon-deal .gd-token:not(.gone)')].length }));
check('в руке — четыре навыка героя и жетоны: кристалл, Кость Хитов, ПЗ, слот, золото', hand.cards === 4 && hand.tokens === 5, JSON.stringify(hand));
await f.shot('deal-open');

// ---------- 2. Жертвы и Чужая память
await forceLots(['copy', 'devour', 'echo'], 'copy');
await settle();
await wait(500);
const before = await snapshot();
// Серый навык, Кость Хитов, −5 ПЗ, слот, кристалл, золото — щелчками по руке
const click = async sel => { await page.$eval(sel, el => el.click()); await settle(); await wait(250); };
await ev(name => [...document.querySelectorAll('#gachadnd-moon-deal .gd-card')].find(c => c.querySelector('.nm').textContent === name).click(), party.heroSkills[0]);
await settle();
await wait(250);
for (const kind of ['hd', 'hp', 'slot', 'gold', 'stash']) await click(`${stage} .gd-token[data-kind="${kind}"]`);
d = await deal();
const weight = d.offers.reduce((s, o) => s + o.w, 0);
check('жертвы легли на весы: навык, Кость Хитов, ПЗ, слот, золото, кристалл', d.offers.length === 6, d.offers.map(o => `${o.kind}:${o.w}`).join(' '));
check('вес — сумма: серый 1 + 2 + 2 + 6 + 1 + синий кристалл 1,5', weight === 13.5, String(weight));
const moon = await ev(() => ({ full: document.querySelector('#gachadnd-moon-deal .gd-md-moon').classList.contains('full'), seal: document.querySelector('#gachadnd-moon-deal .gd-seal').classList.contains('ready'), text: document.querySelector('#gachadnd-moon-deal .gd-weight').textContent }));
check('полнолуние и печать готова (13,5 из 5)', moon.full && moon.seal, JSON.stringify(moon));
const shards = await ev(hero => document.querySelectorAll(`#gachadnd-moon-deal .gd-member[data-actor="${hero}"] .gd-shard.on`).length, ids.hero);
check('портрет героя — три скола', shards === 3, String(shards));
// Забрать слот обратно щелчком по своей гирьке на весах
const slotOffer = d.offers.find(o => o.kind === 'slot').id;
await click(`${stage} .gd-offer[data-offer="${slotOffer}"]`);
d = await deal();
check('жертву можно забрать с весов до печати', !d.offers.some(o => o.kind === 'slot') && d.offers.length === 5, d.offers.map(o => o.kind).join(' '));
await f.shot('deal-weights');

// Печать: окно выбора получателя — союзник получает копию синего навыка героя
const sealing = ev(() => document.querySelector('#gachadnd-moon-deal .gd-seal').click());
await page.waitForSelector('dialog select[name="pick"], .application.dialog select[name="pick"]', { timeout: 8000 });
const pick = await ev(name => {
    const select = document.querySelector('select[name="pick"]');
    const option = [...select.options].find(o => o.textContent.includes(`«${name}»`) && o.textContent.startsWith('GD-тест: Союзник'));
    if (option) select.value = option.value;
    return option?.textContent ?? null;
}, party.heroSkills[3]);
await ev(() => document.querySelector('.application.dialog button[data-action="ok"]').click());
await sealing;
await settle();
await wait(1500);
const after = await snapshot();
d = await deal();
check('печать: сделка скреплена', d.status === 'sealed' && d.result?.lot === 'copy', JSON.stringify(d.result));
check('серый навык сгорел', before.skills.length - after.skills.length === 1 && !after.skills.includes(party.heroSkills[0]), `${before.skills.join(', ')} → ${after.skills.join(', ')}`);
check('Кость Хитов забрана навсегда (класс: hd.additional)', after.hd === before.hd - 1, `${before.hd} → ${after.hd}`);
check('максимум ПЗ −5 (максимум задан вручную — уменьшен он сам)', after.hp === before.hp - 5, `${before.hp} → ${after.hp}`);
check('слот Памяти забран обратно — не списан', after.slots === before.slots, `${before.slots} → ${after.slots}`);
check('кристалл из Хранилища и золото списаны', after.stash === before.stash - 1 && after.gold < before.gold, `кристаллов ${before.stash} → ${after.stash}, золото ${before.gold} → ${after.gold}`);
check('Чужая память: союзник получил копию синего навыка героя', pick && after.allySkills.includes(party.heroSkills[3]) && after.skills.includes(party.heroSkills[3]), `${pick}; у союзника: ${after.allySkills.join(', ')}`);
const card = await ev(() => game.messages.contents.at(-1)?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
check('карточка в чате: что забрала луна и что дала', /Сделка луны — Чужая память/.test(card ?? '') && /Луна забрала/.test(card ?? ''), card?.slice(0, 160));
await wait(3500);
check('после печати окно закрылось', !(await ev(() => !!foundry.applications.instances.get('gachadnd-moon-deal')?.rendered)));

// ---------- 3. Сплав: один слот, сгорают вместе
await forceLots(['copy', 'echo', 'fuse'], 'fuse');
await ev(() => game.gachadnd.openDeal());
await page.waitForSelector(stage, { timeout: 10000 });
await wait(800);
for (let i = 0; i < 9; i++) await click(`${stage} .gd-token[data-kind="gold"]`);
const sealing2 = ev(() => document.querySelector('#gachadnd-moon-deal .gd-seal').click());
await page.waitForSelector('select[name="pick"]', { timeout: 8000 });
const pair = await ev(names => {
    const select = document.querySelector('select[name="pick"]');
    const option = [...select.options].find(o => o.textContent.includes(`«${names[0]}»`) && o.textContent.includes(`«${names[1]}»`));
    if (option) select.value = option.value;
    return option?.textContent ?? null;
}, [party.heroSkills[1], party.heroSkills[2]]);
await ev(() => document.querySelector('.application.dialog button[data-action="ok"]').click());
await sealing2;
await settle();
await wait(1500);
const fused = await ev(async ({ hero, names }) => {
    const h = game.actors.get(hero);
    const syn = await gdt.mod('memory/synergy/synergy.js');
    const [a, b] = names.map(n => h.items.find(i => i.name === n));
    return { a: a?.flags.gachadnd.fused, b: b?.flags.gachadnd.fused, slotA: syn.occupiesSlot(a), slotB: syn.occupiesSlot(b) };
}, { hero: ids.hero, names: [party.heroSkills[1], party.heroSkills[2]] });
check('Сплав: пара связана, второй навык слот не занимает', pair && fused.a?.partner && fused.b?.secondary && fused.slotA && !fused.slotB, `${pair}; ${JSON.stringify(fused)}`);
await wait(3500);
const burned = await ev(async ({ hero, name }) => {
    const h = game.actors.get(hero);
    await h.items.find(i => i.name === name).delete();
    await new Promise(r => setTimeout(r, 800));
    return h.items.filter(i => i.flags.gachadnd?.skill_name).map(i => i.name);
}, { hero: ids.hero, name: party.heroSkills[1] });
check('Сплав: одна половина сгорела — сгорела и вторая', !burned.includes(party.heroSkills[1]) && !burned.includes(party.heroSkills[2]), burned.join(', '));

// ---------- 4. Отголосок Босса: отметка у отряда на следующий этаж
await ev(() => game.settings.set('gachadnd', 'moonBoons', []));
await forceLots(['copy', 'echo', 'fuse'], 'echo');
await ev(() => game.gachadnd.openDeal());
await page.waitForSelector(stage, { timeout: 10000 });
await wait(800);
for (let i = 0; i < 5; i++) await click(`${stage} .gd-token[data-kind="gold"]`);
// Союзник кладёт −5 ПЗ: портрет союзника выбирает его руку
const allyHp = await ev(ally => game.actors.get(ally).system.attributes.hp.max, party.ally);
await click(`${stage} .gd-member[data-actor="${party.ally}"]`);
await click(`${stage} .gd-token[data-kind="hp"]`);
await ev(() => document.querySelector('#gachadnd-moon-deal .gd-seal').click());
await settle();
await wait(1500);
const boons = await ev(() => game.settings.get('gachadnd', 'moonBoons'));
const allyAfter = await ev(ally => ({ hp: game.actors.get(ally).system.attributes.hp.max, effect: game.actors.get(ally).effects.some(e => e.name === 'Луна: забранная плоть') }), party.ally);
check('максимум ПЗ по классам: −5 эффектом «Луна: забранная плоть»', allyAfter.effect && allyAfter.hp === allyHp - 5, `${allyHp} → ${allyAfter.hp}`);
check('Отголосок Босса: отметка на следующий этаж', boons.length === 1 && boons[0].type === 'echo' && boons[0].floor === 2 && !boons[0].used, JSON.stringify(boons));
await wait(3500);

// ---------- 5. Отказ: жертвы остаются при отряде
await forceLots(['copy', 'echo', 'fuse'], 'copy');
await ev(() => game.gachadnd.openDeal());
await page.waitForSelector(stage, { timeout: 10000 });
await wait(800);
const goldBefore = await ev(hero => game.actors.get(hero).system.currency.gp, ids.hero);
await click(`${stage} .gd-token[data-kind="gold"]`);
const refusing = ev(() => document.querySelector('#gachadnd-moon-deal .gd-refuse').click());
await page.waitForSelector('.application.dialog button[data-action="yes"]', { timeout: 8000 });
await ev(() => document.querySelector('.application.dialog button[data-action="yes"]').click());
await refusing;
await settle();
await wait(1000);
d = await deal();
check('отказ: сделка отвергнута, золото на месте, окно закрыто', d.status === 'refused' && await ev(hero => game.actors.get(hero).system.currency.gp, ids.hero) === goldBefore
    && !(await ev(() => !!foundry.applications.instances.get('gachadnd-moon-deal')?.rendered)), `${d.status}, золото ${goldBefore}`);
await ev(() => game.gachadnd.openDeal());
await wait(500);
check('повторно открыть сделку на этом этаже нельзя', await ev(() => gdt.warnings.some(w => /уже предлагала/.test(w))));

// Уборка: карта этажа и номер этажа как были
await ev(async ({ floor, map }) => {
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
    await game.settings.set('gachadnd', 'runFloor', floor);
    await game.settings.set('gachadnd', 'moonBoons', []);
    await game.settings.set('gachadnd', 'mapMode', map.mode);
    await game.settings.set('gachadnd', 'floorSceneId', map.scene);
}, { floor: floorBefore, map: mapBefore });
check('ошибок модуля в консоли нет', !moduleErrors(f.log).length, moduleErrors(f.log).slice(0, 3).join(' | '));

const failed = summary();
await f.close();
done(failed);
