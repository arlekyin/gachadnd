// Навыки, закрывшие пустые редкости тегов, в настоящей Foundry: node tools/foundry/knack.mjs [--headed] [--slow[=мс]]
// Хлопушка (без реакций вне боя и до начала хода в бою), Чутьё мясника (капля над раненым у того, кто
// ведёт персонажа), Навылет (лишний урон из лотка dnd5e — кнопкой соседу), Рандомная хрень (окно выбора,
// штатные атаки dnd5e, оружие у цели с пометкой, «Подобрать», пропажа в конце боя), Переливание (обмен долями ПЗ, свой спасбросок
// врага, союзник согласен, истощение), Медленный яд (счёт урона за 3 раунда и возврат ядом), Сверхновая
// (накопление урона в бою, взрыв со спасбросками, ошеломление, сброс в конце боя).
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const settle = () => page.evaluate(() => gdt.settle());
const chats = () => ev(() => gdt.chats().map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
const lastChat = async () => (await chats()).at(-1) ?? '';
const hp = id => ev(id => game.actors.get(id).system.attributes.hp.value, id);
const setHp = (id, v) => ev(({ id, v }) => game.actors.get(id).update({ 'system.attributes.hp.value': v }), { id, v });
const turn = () => ev(() => `${game.combat.round}:${game.combat.combatant?.name?.replace('GD-тест: ', '')}`);
const next = async () => { await ev(() => game.combat.nextTurn()); await settle(); return turn(); };
const target = (...actors) => ev(actors => canvas.tokens.setTargets(actors.map(a => game.actors.get(a).getActiveTokens()[0].id)), actors);
const spent = (actor, id) => ev(({ actor, id }) => game.actors.get(actor).items.get(id).system.uses.spent, { actor, id });
const resetUses = (actor, id) => ev(({ actor, id }) => game.actors.get(actor).items.get(id).update({ 'system.uses.spent': 0 }), { actor, id });
const effects = id => ev(id => game.actors.get(id).effects.map(e => e.name), id);
const useNow = async (actor, item) => {
    await ev(async ({ actor, item }) => { gdt.warnings.length = 0; gdt.mark(); await game.actors.get(actor).items.get(item).system.activities.contents[0].use({}, { configure: false }); }, { actor, item });
    await settle();
    await wait(400);
};
const chatButton = async (flag, sel) => {
    await ev(async () => { await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary'); });
    await wait(400);
    const id = await ev(flag => game.messages.contents.findLast(m => m.flags?.gachadnd?.[flag])?.id, flag);
    await page.$eval(`#chat [data-message-id="${id}"] ${sel}`, el => el.click());
    await settle();
    await wait(800);
};

await install(page);
const ids = await scene(page, {
    hero: { x: 5, y: 5, level: 5 },
    enemies: [{ name: 'Один', x: 6, y: 5 }, { name: 'Два', x: 7, y: 5 }, { name: 'Три', x: 12, y: 5 }, { name: 'Союзник', x: 4, y: 5, disposition: 1 }]
});
const [A, B, C, ALLY] = ids.enemies;
const hero = ids.hero;
const NAMES = ['Хлопушка', 'Чутьё мясника', 'Навылет', 'Рандомная хрень, вперёд!', 'Переливание', 'Медленный яд', 'Сверхновая'];

// ---------- Компендиум
const pack = await ev(async names => {
    const docs = await game.packs.get('gachadnd.gacha-skills').getDocuments();
    return names.map(n => { const d = docs.find(x => x.name === n); return d ? `${n}:${d.flags.gachadnd.rarity}:${d.flags.gachadnd.knack}:${d.flags.gachadnd.tags.join('+')}` : `${n}:нет`; });
}, NAMES);
check('компендиум: семь навыков knack с редкостями и тегами', pack.every(p => !p.endsWith(':нет')) && pack.join(' ').includes('Хлопушка:gray:firecracker:огонь+взрыв') && pack.join(' ').includes('Сверхновая:red:supernova:взрыв+щит'), pack.join(' | '));
const S = await skills(page, hero, NAMES);
// Меч для лотка урона dnd5e
await ev(hero => game.actors.get(hero).createEmbeddedDocuments('Item', [{ name: 'Меч', type: 'weapon', system: { type: { value: 'martialM' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } }]), hero);

// ---------- Хлопушка вне боя: в 10 футах без реакций, сам — нет
await useNow(hero, S['Хлопушка']);
let fx = await ev(ids => ids.map(id => game.actors.get(id).effects.some(e => e.name === 'Хлопушка: без реакций')), [A, B, C, ALLY, hero]);
check('Хлопушка: Один, Два (10 футов) и Союзник без реакций; Три (далеко) и сам — нет', fx.join() === 'true,true,false,true,false', fx.join());
check('Хлопушка: карточка и заряд', /Хлопок!/.test(await lastChat()) && (await spent(hero, S['Хлопушка'])) === 1, await lastChat());
await ev(ids => Promise.all(ids.map(id => { const a = game.actors.get(id); return a.deleteEmbeddedDocuments('ActiveEffect', a.effects.filter(e => e.name.startsWith('Хлопушка')).map(e => e.id)); })), [A, B, ALLY]);

// ---------- Чутьё мясника: капля над раненым — у того, кто ведёт персонажа (Мастер — выделив токен)
await setHp(A, 10); await setHp(C, 5);
await ev(hero => game.actors.get(hero).getActiveTokens()[0].control({ releaseOthers: true }), hero);
await wait(400);
const drops = () => ev(() => canvas.tokens.placeables.filter(t => t.children.some(c => c.name === 'gdButcherDrop')).map(t => t.document.name.replace('GD-тест: ', '')).sort().join(','));
check('Чутьё мясника: капля над Один (10/30), не над Два (целый) и не над Три (5/30, но в 35 футах)', (await drops()) === 'Один', await drops());
await ev(() => canvas.tokens.releaseAll());
await wait(400);
check('Чутьё мясника: токен не выделен — Мастер каплю не видит', (await drops()) === '', await drops());
await setHp(A, 30); await setHp(C, 30);

// ---------- Навылет: лишний урон из лотка dnd5e — кнопкой соседу убитого
await setHp(A, 5);
const killed = await ev(async ({ hero, A }) => {
    await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary');
    canvas.tokens.setTargets([game.actors.get(A).getActiveTokens()[0].id]);
    const act = game.actors.get(hero).items.find(i => i.type === 'weapon').system.activities.find(x => x.type === 'attack');
    gdt.dice(8, 8);
    const count = game.messages.size;
    await act.rollDamage({}, { configure: false }, {});
    await gdt.until(() => game.messages.size > count, 3000);
    return game.messages.contents.at(-1).id;
}, { hero, A });
// «Применить» в лотке dnd5e: урон сообщения броска с этим сообщением в origin (так зовёт его лоток v14)
await ev(async ({ id, A }) => {
    const message = game.messages.get(id);
    const damages = message.rolls.map(r => ({ value: r.total, type: r.options.type }));
    await game.actors.get(A).applyDamage(damages, { isDelta: true, origin: message, originatingMessage: message });
}, { id: killed, A });
await settle();
await wait(800);
let card = await lastChat();
// Урон меча с синергиями героя (пороги казни и стали прибавляют к атакам оружием) — лишнее сверх 5 ПЗ
const over = await ev(id => game.messages.get(id).rolls.reduce((s, r) => s + r.total, 0), killed) - 5;
check(`Навылет: Один убит (5 ПЗ) — карточка: лишний урон ${over}, кнопка — Два`, (await hp(A)) === 0 && new RegExp(`лишний урон: ${over}`).test(card) && await ev(() => !!game.messages.contents.at(-1).flags.gachadnd?.through), `${card}; ПЗ Одного ${await hp(A)}`);
const twoBefore = await hp(B);
await chatButton('through', '[data-gd-through]');
check('Навылет: остаток ушёл в Два, кнопки погасли', twoBefore - (await hp(B)) === over && await ev(() => game.messages.contents.findLast(m => m.flags.gachadnd?.through).flags.gachadnd.through.done), `${twoBefore} → ${await hp(B)}`);
await setHp(A, 30); await setHp(B, 30);

// ---------- Карточка навыка dnd5e в чате: как у любой способности
const usageCard = name => ev(name => game.messages.contents.some(m => (m.system?.item?.name ?? m.flags?.dnd5e?.item?.name ?? m.item?.name) === name
    || (m.type === 'usage' && m.content.includes(name)) || (m.flags?.dnd5e?.messageType === 'usage' && m.content.includes(name))), name);
// Кнопка броска из карточки модуля (помощник dnd5e [[/damage ...]]) — как нажал бы игрок
const pressDamage = async flag => {
    await ev(async () => { await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary'); });
    await wait(400);
    const id = await ev(flag => game.messages.contents.findLast(m => m.flags?.gachadnd?.[flag])?.id, flag);
    const count = await ev(() => game.messages.size);
    await page.$eval(`#chat [data-message-id="${id}"] a.roll-link-group[data-type="damage"] .roll-link`, el => el.click());
    // Окно настройки броска dnd5e — «Бросить», как сделает игрок
    await ev(() => gdt.until(() => [...foundry.applications.instances.values()].some(a => a.rendered && a.constructor.name === 'DamageRollConfigurationDialog'), 4000));
    await ev(() => {
        const app = [...foundry.applications.instances.values()].find(a => a.rendered && a.constructor.name === 'DamageRollConfigurationDialog');
        const buttons = [...app.element.querySelectorAll('button')];
        (buttons.find(b => /normal|roll/i.test(`${b.dataset.action} ${b.value}`)) ?? buttons.at(-1)).click();
    });
    await ev(count => gdt.until(() => game.messages.size > count, 4000), count);
    await settle();
    return ev(() => { const m = game.messages.contents.at(-1); return { type: m.type, total: m.rolls.reduce((s, r) => s + r.total, 0), dmg: m.rolls.map(r => r.options?.type).join(',') }; });
};
check('Хлопушка: карточка навыка dnd5e в чате', await usageCard('Хлопушка'));

// ---------- Переливание: враг бросает спасбросок сам; провал — обмен долями, истощение
await setHp(hero, 6); await setHp(A, 27);
await target(A);
await useNow(hero, S['Переливание']);
check('Переливание: карточка навыка в чате, враг ждёт спасброска — ПЗ ещё не тронуты', await usageCard('Переливание') && (await hp(hero)) === 6 && await ev(a => !!game.actors.get(a).getFlag('gachadnd', 'transfusionPending'), A), await lastChat());
// Один бросает спасбросок Телосложения (кнопкой из карточки) — к20 = 1
await ev(() => gdt.dice(20, 1));
await ev(a => game.actors.get(a).rollSavingThrow({ ability: 'con' }, { configure: false }), A);
await settle(); await wait(600);
let ex = await ev(hero => game.actors.get(hero).system.attributes.exhaustion, hero);
check('Переливание: провал спасброска — герой 10 % ↔ Один 90 %: герой 54/60, Один 3/30, истощение 1', (await hp(hero)) === 54 && (await hp(A)) === 3 && ex === 1, `${await hp(hero)}, ${await hp(A)}, истощение ${ex}`);
await resetUses(hero, S['Переливание']);
await target(A);
await useNow(hero, S['Переливание']);
await ev(() => gdt.dice(20, 20));
await ev(a => game.actors.get(a).rollSavingThrow({ ability: 'con' }, { configure: false }), A);
await settle(); await wait(600);
check('Переливание: враг выдержал спасбросок — обмена нет', (await hp(hero)) === 54 && (await hp(A)) === 3 && /не отдаёт/.test(await lastChat()) && !(await ev(a => game.actors.get(a).getFlag('gachadnd', 'transfusionPending'), A)), await lastChat());
await resetUses(hero, S['Переливание']);
await setHp(ALLY, 15);
await target(ALLY);
await useNow(hero, S['Переливание']);
ex = await ev(hero => game.actors.get(hero).system.attributes.exhaustion, hero);
check('Переливание: союзник согласен без спасброска — герой 90 % → 50 %, союзник 50 % → 90 %, истощение 2', (await hp(hero)) === 30 && (await hp(ALLY)) === 27 && ex === 2, `${await hp(hero)}, ${await hp(ALLY)}, истощение ${ex}`);
await ev(hero => game.actors.get(hero).update({ 'system.attributes.exhaustion': 0, 'system.attributes.hp.value': 60 }), hero);
await setHp(A, 30); await setHp(ALLY, 30);

// ---------- Бой: герой, Один, Два, Союзник
await combat(page, ids.scene, [hero, A, B, ALLY]);
await settle();

// Хлопушка в бою: эффект снимается в начале хода существа
await resetUses(hero, S['Хлопушка']);
await useNow(hero, S['Хлопушка']);
check('Хлопушка в бою: Один без реакций', (await effects(A)).includes('Хлопушка: без реакций'), (await effects(A)).join(', '));
await next();
check('Хлопушка: начался ход Одного — реакции вернулись', !(await effects(A)).includes('Хлопушка: без реакций') && (await effects(B)).includes('Хлопушка: без реакций'), `${await turn()}: ${(await effects(A)).join(', ')}`);
while (!(await turn()).endsWith('Герой')) await next();

// Сверхновая: копит урон в бою; взрыв — карточка с кнопкой урона на накопленное, ошеломление
await useNow(hero, S['Сверхновая']);
check('Сверхновая: копить нечего — отказ, заряд цел', (await spent(hero, S['Сверхновая'])) === 0 && await ev(() => gdt.warnings.some(w => /копить пока нечего/.test(w))));
await ev(hero => game.actors.get(hero).applyDamage(10), hero); await settle();
await ev(hero => game.actors.get(hero).applyDamage(5), hero); await settle();
check('Сверхновая: накоплено 15 (эффект «Сверхновая: 15»)', (await effects(hero)).includes('Сверхновая: 15'), (await effects(hero)).join(', '));
const nova = await ev(ids => ids.map(id => game.actors.get(id).system.attributes.hp.value), [A, B, ALLY]);
await useNow(hero, S['Сверхновая']);
card = await lastChat();
check('Сверхновая: карточка навыка и карточка взрыва — накопленное 15, в радиусе трое; урон модуль сам не применил',
    await usageCard('Сверхновая') && /накопленное: 15/.test(card) && /Один/.test(card) && /Два/.test(card) && /Союзник/.test(card) && !/Три/.test(card)
    && (await ev(ids => ids.map(id => game.actors.get(id).system.attributes.hp.value), [A, B, ALLY])).join() === nova.join(), card);
check('Сверхновая: накопление сброшено, герой ошеломлён', !(await effects(hero)).some(e => e.startsWith('Сверхновая: 1')) && await ev(hero => game.actors.get(hero).statuses.has('stunned'), hero), (await effects(hero)).join(', '));
let rolled = await pressDamage('supernova');
check('Сверхновая: кнопка урона в карточке — бросок урона dnd5e на 15 Силовым полем', rolled.total === 15 && /force/.test(rolled.dmg), JSON.stringify(rolled));

// Медленный яд: считает урон 3 раунда; в начале третьего — карточка с кнопкой урона Ядом на сумму
await target(B);
const round0 = await ev(() => game.combat.round);
await useNow(hero, S['Медленный яд']);
check('Медленный яд: карточка навыка, Два отмечен', await usageCard('Медленный яд') && (await effects(B)).includes('Медленный яд: 0'), (await effects(B)).join(', '));
await ev(b => game.actors.get(b).applyDamage(5), B); await settle();
await ev(b => game.actors.get(b).applyDamage(-3), B); await settle();
await ev(b => game.actors.get(b).applyDamage(7), B); await settle();
check('Медленный яд: урон 5 и 7 посчитан, лечение 3 — нет: «Медленный яд: 12»', (await effects(B)).includes('Медленный яд: 12'), (await effects(B)).join(', '));
const twoHp = await hp(B);
while ((await ev(() => game.combat.round)) < round0 + 3) await next();
await wait(800);
check('Медленный яд: в начале третьего раунда — карточка срабатывания, отметка снята, урон модуль сам не применил', /Яд сработал/.test(await lastChat()) && (await hp(B)) === twoHp && !(await effects(B)).some(e => e.startsWith('Медленный яд')), await lastChat());
rolled = await pressDamage('slowPoisonRelease');
check('Медленный яд: кнопка урона — бросок урона dnd5e на 12 Ядом', rolled.total === 12 && /poison/.test(rolled.dmg), JSON.stringify(rolled));

// Рандомная хрень: окно, штатные атаки dnd5e, оружие у цели с пометкой, «Подобрать», пропажа в конце боя
await ev(hero => game.actors.get(hero).createEmbeddedDocuments('Item', [
    { name: 'Кинжал', type: 'weapon', img: 'icons/weapons/daggers/dagger-straight-blue.webp', system: { type: { value: 'simpleM' }, damage: { base: { number: 1, denomination: 4, types: ['piercing'] } }, equipped: false } },
    { name: 'Молот', type: 'weapon', img: 'icons/weapons/hammers/hammer-war-spiked.webp', system: { type: { value: 'martialM' }, damage: { base: { number: 1, denomination: 8, types: ['bludgeoning'] } }, equipped: false } }
]), hero);
await setHp(A, 30); await setHp(B, 30);
await target(A, B);
const before = await ev(() => game.messages.size);
await ev(({ hero, id }) => { gdt.warnings.length = 0; gdt.p = game.actors.get(hero).items.get(id).system.activities.contents[0].use({}, { configure: false }); }, { hero, id: S['Рандомная хрень, вперёд!'] });
await page.waitForSelector('.application.dialog select[name="t0"]', { timeout: 8000 });
const plan = await ev(({ A, B }) => {
    const ta = game.actors.get(A).getActiveTokens()[0].id, tb = game.actors.get(B).getActiveTokens()[0].id;
    const rows = [...document.querySelectorAll('.application.dialog .gd-junk-row')];
    const names = rows.map(r => r.querySelector('span').textContent);
    rows.forEach(r => { r.querySelector('input').checked = false; });
    const set = (name, token) => { const r = rows[names.indexOf(name)]; r.querySelector('input').checked = true; r.querySelector('select').value = token; };
    set('Кинжал', ta); set('Молот', tb);
    return names.join(', ');
}, { A, B });
await ev(() => document.querySelector('.application.dialog button[data-action="ok"]').click());
await ev(() => gdt.p);
await settle();
await wait(1500);
const attacks = await ev(({ before, A, B }) => game.messages.contents.slice(before).filter(m => m.rolls.some(r => r.constructor.name === 'D20Roll' || /d20/.test(r.formula)))
    .map(m => `${m.system?.item?.name ?? m.flags?.dnd5e?.item?.name ?? m.item?.name ?? '?'}→${(m.system?.targets ?? m.flags?.dnd5e?.targets ?? []).map(t => t.name?.replace('GD-тест: ', '')).join('+')}`), { before, A, B });
const junk = await ev(({ hero, scene }) => ({
    thrown: game.actors.get(hero).items.filter(i => i.flags.gachadnd?.thrown).map(i => i.name).sort().join(','),
    tiles: game.scenes.get(scene).tiles.filter(t => t.flags.gachadnd?.junk).map(t => t.flags.gachadnd.junk.name).sort().join(',')
}), { hero, scene: ids.scene });
check('Рандомная хрень: окно предлагает неэкипированное оружие', /Кинжал/.test(plan) && /Молот/.test(plan) && !/Меч/.test(plan), plan);
check('Рандомная хрень: две штатные атаки dnd5e — Кинжал по Одному, Молот по Двум', attacks.length === 2 && attacks.some(a => /Кинжал.*Один/.test(a)) && attacks.some(a => /Молот.*Два/.test(a)), attacks.join(' | '));
check('Рандомная хрень: урон модуль сам не применил', (await hp(A)) === 30 && (await hp(B)) === 30, `${await hp(A)}, ${await hp(B)}`);
check('Рандомная хрень: оружие помечено брошенным и лежит у целей', junk.thrown === 'Кинжал,Молот' && junk.tiles === 'Кинжал,Молот', JSON.stringify(junk));
await chatButton('junk', '[data-gd-junk]');
const picked = await ev(({ hero, scene }) => ({ thrown: game.actors.get(hero).items.filter(i => i.flags.gachadnd?.thrown).length, items: game.actors.get(hero).items.filter(i => ['Кинжал', 'Молот'].includes(i.name)).length, tiles: game.scenes.get(scene).tiles.filter(t => t.flags.gachadnd?.junk).length }), { hero, scene: ids.scene });
check('Рандомная хрень: «Подобрать» снял пометку и плитку', picked.thrown === 1 && picked.items === 2 && picked.tiles === 1, JSON.stringify(picked));
await ev(() => game.combat.delete());
await settle();
await wait(800);
const gone = await ev(({ hero, scene }) => ({ tiles: game.scenes.get(scene).tiles.filter(t => t.flags.gachadnd?.junk).length, items: game.actors.get(hero).items.filter(i => ['Кинжал', 'Молот'].includes(i.name)).length }), { hero, scene: ids.scene });
check('конец боя: неподобранное пропало из сумки, карточка', gone.tiles === 0 && gone.items === 1 && /пропало навсегда/.test(await lastChat()), `${JSON.stringify(gone)} ${await lastChat()}`);
check('конец боя: Сверхновая сброшена', !(await ev(hero => game.actors.get(hero).getFlag('gachadnd', 'supernova'), hero)));

check('ошибок модуля в консоли нет', !moduleErrors(f.log).length, moduleErrors(f.log).slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
