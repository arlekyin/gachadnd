// Живые навыки, двойные, шрамы и правила Боссов в настоящей Foundry: node tools/foundry/living.mjs [--headed]
// Набить руку: 4 зарубки — пятый удар критический; Третий раз: два провала — преимущество; Обратный отсчёт:
// 3 → взрыв с прибавкой за попадания; Тлеющий уголь: убийство огнём раздувает радиус; Чумной костёр, Реактивная
// тяга, Кровавый бастион; добыча: шрамы не выпадают, двойные — только с обоими тегами в Памяти отряда;
// шрамы: слот, нельзя снять, Ожог, Чужой голос, Трещина, событие, снятие не считается сожжением;
// правила Боссов: Глушитель и Крайний спит (просыпается на половине ПЗ Босса).
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, use, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
const ids = await scene(page, {
    hero: { level: 5 },
    enemies: [{ name: 'Босс', x: 8, y: 5 }, { name: 'Прихвостень', x: 12, y: 9 }, { name: 'Союзник', x: 5, y: 6, disposition: 1 }]
});
const [bossId, minionId, allyId] = ids.enemies;
const since = f.log.length;
const settle = () => ev(() => gdt.settle(300, 5000));
// Отряд — персонажи с владельцем-игроком; в тестовом мире игроков нет: герой помечается на время проверки
await ev(hero => Object.defineProperty(game.actors.get(hero), 'hasPlayerOwner', { get: () => true, configurable: true }), ids.hero);
// Босс — самый опасный враг на сцене (так его ищут правила Боссов)
await ev(boss => game.actors.get(boss).update({ 'system.details.cr': 5 }), bossId);
const item = (name) => ev(({ hero, name }) => {
    const i = game.actors.get(hero).items.find(x => x.name === name);
    return i ? { id: i.id, counter: i.flags.gachadnd.counter ?? 0, active: !!i.flags.gachadnd.is_active, asleep: i.flags.gachadnd.asleep ?? null, spent: i.system.uses?.spent ?? 0 } : null;
}, { hero: ids.hero, name });

// ---------- Добыча: шрамы и двойные навыки (связки) не выпадают
const loot = await ev(async () => {
    const c = await gdt.mod('memory/crystals.js');
    const index = await c.getSkillPack().getIndex({ fields: ['flags.gachadnd.rarity', 'flags.gachadnd.tags', 'flags.gachadnd.duo', 'flags.gachadnd.scar'] });
    const names = list => list.map(e => e.name);
    return { all: index.size, scars: names([...index].filter(e => e.flags?.gachadnd?.scar)), lootable: names(c.lootable(index)) };
});
check('компендиум: 3 шрама, ни один не в добыче', loot.scars.length === 3 && !loot.scars.some(n => loot.lootable.includes(n)), JSON.stringify(loot.scars));
check('двойные навыки — связки: кристаллом не выпадают', !['Чумной костёр', 'Реактивная тяга', 'Кровавый бастион'].some(n => loot.lootable.includes(n)));

// ---------- Связка синергий: 2 огня + 2 яда — Чумной костёр способностью; снял один — пропал
const tagSkills = await skills(page, ids.hero, ['Пироман', 'Прикурить?', 'Сомелье', 'Глубокий вдох']);
const link = await ev(async ({ hero, off }) => {
    const actor = game.actors.get(hero);
    const syn = await gdt.mod('memory/synergy/synergy.js');
    const has = () => actor.items.find(i => i.name === 'Чумной костёр' && i.flags.gachadnd?.is_synergy_item);
    const on = !!has();
    const memory = actor.items.some(i => i.name === 'Чумной костёр' && syn.isMemorySkill(i));
    await syn.setSkillEquipped(actor.items.get(off), false);
    await syn.updateActorSynergies(actor);
    await gdt.settle();
    const offNow = !has();
    await syn.setSkillEquipped(actor.items.get(off), true);
    await syn.updateActorSynergies(actor);
    await gdt.settle();
    return { on, memory, offNow, back: !!has(), card: game.messages.contents.some(m => /Связка синергий/.test(m.content)) };
}, { hero: ids.hero, off: tagSkills['Сомелье'] });
check('связка: 2 огня + 2 яда — «Чумной костёр» среди способностей синергий, не в Памяти', link.on && !link.memory && link.card, JSON.stringify(link));
check('связка: снял навык яда — пропала, вернул — снова на месте', link.offNow && link.back, JSON.stringify(link));
await ev(async ({ hero, list }) => {
    const actor = game.actors.get(hero);
    const syn = await gdt.mod('memory/synergy/synergy.js');
    for (const id of list) await syn.setSkillEquipped(actor.items.get(id), false);
    await syn.updateActorSynergies(actor);
}, { hero: ids.hero, list: Object.values(tagSkills) });

// ---------- Набить руку
await skills(page, ids.hero, ['Набить руку']);
const hone = await ev(async hero => {
    const actor = game.actors.get(hero);
    const pack = game.packs.get('dnd5e.items');
    const index = await pack.getIndex({ fields: ['type'] });
    const entry = index.find(e => e.type === 'weapon' && /longsword|длинный меч/i.test(e.name)) ?? index.find(e => e.type === 'weapon');
    const [weapon] = await actor.createEmbeddedDocuments('Item', [(await pack.getDocument(entry._id)).toObject()]);
    const attack = weapon.system.activities.find(a => a.type === 'attack');
    const crits = [];
    for (let i = 0; i < 5; i++) {
        const rolls = await attack.rollDamage({}, { configure: false }, { create: false });
        crits.push(!!rolls?.[0]?.isCritical);
        await gdt.settle();
    }
    return { crits, counter: actor.items.find(x => x.name === 'Набить руку').flags.gachadnd.counter };
}, ids.hero);
check('Набить руку: 4 удара — зарубки, пятый — критический, счёт обнулён', hone.crits.join() === 'false,false,false,false,true' && hone.counter === 0, JSON.stringify(hone));

// ---------- Счётчики понятны: точки на значке, «+1 зарубка» над токеном, строка на пороге; правило — в карточке
// навыка на панели Памяти, а не подсказкой у токена (она закрывала клетки)
const ui = await ev(async hero => {
    const actor = game.actors.get(hero);
    const skill = actor.items.find(x => x.name === 'Набить руку');
    const token = canvas.tokens.placeables.find(t => t.actor?.id === hero);
    if (game.paused) game.togglePause(false, { broadcast: true });
    const floats = [];
    const orig = canvas.interface.createScrollingText.bind(canvas.interface);
    canvas.interface.createScrollingText = (p, text, o) => { floats.push(text); return orig(p, text, o); };
    const badge = () => token.children.find(c => c.name === 'gdLivingBadge')?.children.map(c => c.text).join('|') ?? '';
    const empty = badge();
    const before = game.messages.size;
    await skill.setFlag('gachadnd', 'counter', 3); await gdt.settle(); await new Promise(r => setTimeout(r, 200));
    const three = badge();
    await skill.setFlag('gachadnd', 'counter', 4); await gdt.settle(); await new Promise(r => setTimeout(r, 1100));
    const msg = game.messages.contents.slice(before).find(m => /рука набита/i.test(m.content));
    Hooks.callAll('hoverToken', token, true);
    const tip = !!document.querySelector('.gd-counter-tip');
    // Терминал: на пластине навыка — точки, при наведении в панели подробностей — правило целиком
    await game.gachadnd.openTerminal(actor); await new Promise(r => setTimeout(r, 1500));
    const dock = foundry.applications.instances.get('gachadnd-dock')?.element;
    const card = dock?.querySelector(`.gd-plate[data-item-id="${skill.id}"]`);
    card?.dispatchEvent(new PointerEvent('pointerenter')); await new Promise(r => setTimeout(r, 600));
    const cardState = card?.querySelector('.gd-cnt')?.textContent ?? null;
    const popText = dock?.querySelector('.gd-t-detail .gd-t-meta .cnt')?.textContent.replace(/\s+/g, ' ').trim() ?? null;
    card?.dispatchEvent(new PointerEvent('pointerleave'));
    canvas.interface.createScrollingText = orig;
    return { empty, three, floats, whisper: !!msg && msg.whisper.length > 0, tip, cardState, popText };
}, ids.hero);
check('счётчик: пустой не висит, 3 из 4 — точки ●●●○, над токеном «+1 зарубка»', ui.empty === '' && /⚒ ●●●○/.test(ui.three) && ui.floats.some(t => /\+1 ⚒ зарубка/.test(t)), JSON.stringify(ui));
check('порог: шёпот «рука набита» владельцу и Мастеру, над токеном — та же строка', ui.whisper && ui.floats.some(t => /рука набита/.test(t)), JSON.stringify(ui));
check('наведение на токен: подсказки нет — клетки вокруг свободны', !ui.tip, JSON.stringify(ui.tip));
check('Терминал: на пластине «⚒ ●●●●», при наведении — правило целиком в панели подробностей', ui.cardState === '⚒ ●●●●' && /каждое попадание оружием/.test(ui.popText ?? ''), JSON.stringify({ card: ui.cardState, pop: ui.popText }));
await page.waitForTimeout(400);
await f.shot('living-counters-dock');
await ev(() => foundry.applications.instances.get('gachadnd-dock')?.close());
await ev(async hero => {
    Hooks.callAll('hoverToken', canvas.tokens.placeables.find(t => t.actor?.id === hero), false);
    await game.actors.get(hero).items.find(x => x.name === 'Набить руку').setFlag('gachadnd', 'counter', 0);
}, ids.hero);

// ---------- Третий раз — за правду
await skills(page, ids.hero, ['Третий раз — за правду']);
const third = await ev(async hero => {
    const actor = game.actors.get(hero);
    const save = async d20 => { gdt.dice(20, d20); const [r] = await actor.rollSavingThrow({ ability: 'dex', target: 25 }, { configure: false }, { create: false }); await gdt.settle(); return r; };
    await save(2); await save(3);
    const ready = actor.items.find(x => x.name === 'Третий раз — за правду').flags.gachadnd.counter;
    gdt.dice(20, 4, 15);
    const [r] = await actor.rollSavingThrow({ ability: 'dex', target: 25 }, { configure: false }, { create: false });
    await gdt.settle();
    return { ready, advantage: r.hasAdvantage ?? /kh/.test(r.formula), after: actor.items.find(x => x.name === 'Третий раз — за правду').flags.gachadnd.counter };
}, ids.hero);
check('Третий раз: два провала — счёт 2, следующий спасбросок с преимуществом, счёт обнулён', third.ready === 2 && third.advantage && third.after === 0, JSON.stringify(third));
const pair = await ev(async hero => {
    const actor = game.actors.get(hero), token = canvas.tokens.placeables.find(t => t.actor?.id === hero);
    await actor.items.find(x => x.name === 'Набить руку').setFlag('gachadnd', 'counter', 2);
    await actor.items.find(x => x.name === 'Третий раз — за правду').setFlag('gachadnd', 'counter', 1);
    await gdt.settle(); await new Promise(r => setTimeout(r, 300));
    const box = token.children.find(c => c.name === 'gdLivingBadge'), kids = box?.children ?? [];
    const out = { texts: kids.map(c => c.text), ys: kids.map(c => Math.round(c.y)), width: Math.round(box?.width ?? 0), tokenW: Math.round(token.w), bottom: Math.round((box?.y ?? 0) + (box?.height ?? 0)) };
    await canvas.animatePan({ x: token.center.x, y: token.center.y, scale: 1.4, duration: 0 });
    return out;
}, ids.hero);
check('два счётчика — одной строкой над токеном, не шире клетки', pair.texts.length === 2 && pair.ys[0] === pair.ys[1] && pair.width <= pair.tokenW && pair.bottom <= 8, JSON.stringify(pair));
await page.waitForTimeout(300);
await f.shot('living-counters-pair');
await ev(async hero => { const a = game.actors.get(hero); for (const n of ['Набить руку', 'Третий раз — за правду']) await a.items.find(x => x.name === n).setFlag('gachadnd', 'counter', 0); }, ids.hero);

// ---------- Обратный отсчёт и Тлеющий уголь (в бою)
const sk = await skills(page, ids.hero, ['Обратный отсчёт', 'Тлеющий уголь', 'Реактивная тяга', 'Кровавый бастион']);
const combatId = await combat(page, ids.scene, [ids.hero, bossId, minionId]);
await ev(boss => canvas.tokens.placeables.find(t => t.actor?.id === boss).setTarget(true, { releaseOthers: true }), bossId);
await use(page, ids.hero, sk['Обратный отсчёт']);
let cd = await ev(() => game.combat.getFlag('gachadnd', 'countdowns'));
check('Обратный отсчёт: на Боссе отсчёт 3', cd?.length === 1 && cd[0].value === 3 && cd[0].dice === 3, JSON.stringify(cd));
const badge = await ev(boss => canvas.tokens.placeables.find(t => t.actor?.id === boss).children.find(c => c.name === 'gdLivingBadge')?.children.map(c => c.text).join('|'), bossId);
check('Обратный отсчёт: число видно над носителем', /⏱ 3/.test(badge ?? ''), badge);
await ev(async ({ boss, hero }) => {
    await game.actors.get(boss).applyDamage([{ value: 3, type: 'slashing' }], { gachadndSource: hero });
    await gdt.settle();
    await game.combat.nextTurn(); await game.combat.nextTurn(); await game.combat.nextTurn();
    await gdt.settle();
}, { boss: bossId, hero: ids.hero });
cd = await ev(() => game.combat.getFlag('gachadnd', 'countdowns'));
check('ход героя: отсчёт 2, попадание по носителю засчитано', cd?.[0]?.value === 2 && cd[0].hits === 1, JSON.stringify(cd));
const boom = await ev(async boss => {
    await game.actors.get(boss).applyDamage([{ value: 100, type: 'slashing' }]);
    await gdt.settle();
    const m = game.messages.contents.findLast(m => m.flags?.gachadnd?.blastCard && /Обратный отсчёт: взрыв/.test(m.content));
    return { formula: m?.flags.gachadnd.blastCard.formula, left: game.combat.getFlag('gachadnd', 'countdowns')?.length ?? 0 };
}, bossId);
check('носитель пал — взрыв сразу: 3к6 + 1к6 за попадание', boom.formula === '4d6' && boom.left === 0, JSON.stringify(boom));
await ev(boss => game.actors.get(boss).update({ 'system.attributes.hp.value': 30 }), bossId);

const ember = await ev(async ({ minion, hero }) => {
    const actor = game.actors.get(hero);
    const skill = actor.items.find(x => x.name === 'Тлеющий уголь');
    await game.actors.get(minion).applyDamage([{ value: 100, type: 'fire' }], { gachadndSource: hero });
    await gdt.settle();
    const after = skill.flags.gachadnd.counter ?? 0;
    await skill.setFlag('gachadnd', 'counter', 6);
    const m = await gdt.mod('memory/skills/living/ember.js');
    await m.flare({ actorId: hero, sceneId: canvas.scene.id, cell: [8, 5], radius: m.emberRadius(skill), damage: { formula: '4d6', type: 'fire' }, dc: 13 });
    const card = game.messages.contents.findLast(x => /Тлеющий уголь/.test(x.content) && x.flags?.gachadnd?.blastCard);
    await game.actors.get(minion).update({ 'system.attributes.hp.value': 30 });
    return { after, radius: m.emberRadius(skill), card: card?.content.match(/Радиус пламени — (\d+)/)?.[1] };
}, { minion: minionId, hero: ids.hero });
check('Тлеющий уголь: убийство огнём +1; 6 убийств — радиус 15', ember.after === 1 && ember.radius === 15 && ember.card === '15', JSON.stringify(ember));

// ---------- Сводка в первом бою сессии
const sessionSummary = await ev(async () => {
    const m = await gdt.mod('memory/skills/living/badges.js');
    m.resetSummary();
    const before = game.messages.size;
    Hooks.callAll('combatStart', game.combat, {});
    await new Promise(r => setTimeout(r, 600));
    const msg = game.messages.contents.slice(before).find(x => /Копится/.test(x.content));
    return { text: msg?.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? null, whisper: msg?.whisper.length ?? 0 };
});
check('первый бой сессии: шёпот «Копится» — уголь с радиусом', /Копится/.test(sessionSummary.text ?? '') && /Тлеющий уголь — радиус 15/.test(sessionSummary.text ?? '') && sessionSummary.whisper > 0, JSON.stringify(sessionSummary));
await ev(() => { const el = [...document.querySelectorAll('#chat-log .chat-message, .chat-log .message')].findLast(x => /Копится/.test(x.textContent)); el?.scrollIntoView(); ui.chat?.renderPopout?.(); });
await f.shot('living-summary');

// ---------- Реактивная тяга: героя ход, отошёл на 15 футов
const jet = await ev(async ({ hero, boss }) => {
    while (game.combat.combatant?.actorId !== hero) await game.combat.nextTurn();
    await gdt.settle();
    const token = canvas.tokens.placeables.find(t => t.actor?.id === hero).document;
    await canvas.tokens.placeables.find(t => t.actor?.id === boss).document.update({ x: (token.x / 100 + 1) * 100, y: token.y });
    await gdt.mark();
    await token.update({ x: token.x - 300 }, { animate: false });
    await gdt.settle();
    const m = game.messages.contents.findLast(x => x.flags?.gachadnd?.blastCard && /Реактивная тяга/.test(x.content));
    const victims = (m?.flags.gachadnd.blastCard.victims ?? []).map(id => canvas.scene.tokens.get(id)?.actor?.id);
    return { card: !!m, boss: victims.includes(boss), formula: m?.flags.gachadnd.blastCard.formula };
}, { hero: ids.hero, boss: bossId });
check('Реактивная тяга: 15 футов за ход — взрыв там, откуда ушёл (Босс рядом задет)', jet.card && jet.boss && jet.formula === '2d6', JSON.stringify(jet));

// ---------- Кровавый бастион
const bastion = await ev(async ({ hero, ally }) => {
    const actor = game.actors.get(hero);
    const token = canvas.tokens.placeables.find(t => t.actor?.id === hero).document;
    await canvas.tokens.placeables.find(t => t.actor?.id === ally).document.update({ x: token.x, y: token.y + 100 }, { animate: false });
    await actor.applyDamage([{ value: 10, type: 'slashing' }]);
    await gdt.settle();
    const m = game.messages.contents.findLast(x => x.flags?.gachadnd?.bastion);
    const mod = await gdt.mod('memory/skills/living/duo.js');
    await mod.raise({ messageId: m.id });
    await gdt.settle();
    return { offered: !!m, temp: game.actors.get(ally).system.attributes.hp.temp, spent: actor.items.find(x => x.name === 'Кровавый бастион').system.uses.spent };
}, { hero: ids.hero, ally: allyId });
check('Кровавый бастион: кнопка в шёпоте, союзник рядом получил 5 временных ПЗ, заряд потрачен', bastion.offered && bastion.temp === 5 && bastion.spent === 1, JSON.stringify(bastion));

// ---------- Чумной костёр: Босс начинает ход в облаке
const pyre = await ev(async ({ hero, boss }) => {
    const bossToken = canvas.tokens.placeables.find(t => t.actor?.id === boss).document;
    const mod = await gdt.mod('memory/skills/living/duo.js');
    await mod.kindle({ actorId: hero, sceneId: canvas.scene.id, cell: [bossToken.x / 100, bossToken.y / 100], dc: 13 });
    while (game.combat.combatant?.actorId !== boss) await game.combat.nextTurn();
    await gdt.settle();
    const m = game.messages.contents.findLast(x => x.flags?.gachadnd?.blastCard && /Чумной костёр/.test(x.content));
    return { card: !!m, poison: /2d6 poison|2к6/.test(m?.content ?? '') || !!m?.content.includes('poison'), state: !!game.combat.getFlag('gachadnd', 'pyre') };
}, { hero: ids.hero, boss: bossId });
check('Чумной костёр: Босс в облаке — огонь и яд, спасбросок Телосложения', pyre.card && pyre.state, JSON.stringify(pyre));
await ev(() => game.combat.delete());
await settle();

// ---------- Шрамы
const scar = await ev(async hero => {
    const actor = game.actors.get(hero);
    const s = await gdt.mod('memory/skills/living/scars.js');
    const api = await gdt.mod('memory/memory-api.js');
    const before = actor.getFlag('gachadnd', 'counts') ?? {};
    const burnedBefore = actor.getFlag('gachadnd', 'burned_count') ?? 0;
    const item = await s.grantScar(actor, { kind: 'burn', reason: 'проверка' });
    await gdt.settle();
    const after = actor.getFlag('gachadnd', 'counts') ?? {};
    const canUnequip = api.allowSkillChange(actor, item, false);
    const topKey = Object.entries(before).sort((a, b) => b[1] - a[1])[0];
    const result = { name: item?.name, active: !!item?.flags.gachadnd.is_active, canUnequip, top: topKey, afterTop: topKey ? after[topKey[0]] : null };
    await item.delete({ gachadndScar: true });
    await gdt.settle();
    result.burned = (actor.getFlag('gachadnd', 'burned_count') ?? 0) - burnedBefore;
    return result;
}, ids.hero);
check('шрам «Ожог памяти»: экипирован, снять нельзя, самый частый тег на один меньше', scar.name === 'Ожог памяти' && scar.active && !scar.canUnequip && scar.afterTop === scar.top?.[1] - 1, JSON.stringify(scar));
check('снятый шрам — не сожжённый навык', scar.burned === 0, JSON.stringify(scar));

const voice = await ev(async ({ hero, scene, boss }) => {
    const actor = game.actors.get(hero);
    const s = await gdt.mod('memory/skills/living/scars.js');
    await s.grantScar(actor, { kind: 'voice' });
    const sc = game.scenes.get(scene);
    const combat = await Combat.create({ scene, active: true });
    await combat.createEmbeddedDocuments('Combatant', [hero, boss].map((id, i) => ({ tokenId: sc.tokens.find(t => t.actorId === id).id, sceneId: scene, actorId: id, initiative: 20 - i })));
    await combat.startCombat();
    await gdt.settle();
    const voiced = i => i.flags.gachadnd?.asleep?.until === 'round2';
    const asleep = actor.items.filter(voiced).map(i => i.name);
    const blocked = await actor.items.find(voiced)?.system.activities.contents[0]?.use?.().then(r => r ?? null).catch(() => 'error');
    await combat.nextTurn(); await combat.nextTurn();
    await gdt.settle();
    const later = actor.items.filter(voiced).map(i => i.name);
    await combat.delete();
    await gdt.settle();
    return { asleep, later, blocked: blocked === null || blocked === undefined || blocked === false };
}, { hero: ids.hero, scene: ids.scene, boss: bossId });
// Карта мира может стоять на узле Босса — тогда в начале боя спит и навык по правилу Босса; считается только сон шрама
check('Чужой голос: в начале боя один навык спит, во втором раунде проснулся', voice.asleep.length === 1 && voice.later.length === 0, JSON.stringify(voice));

const crack = await ev(async hero => {
    const actor = game.actors.get(hero);
    const s = await gdt.mod('memory/skills/living/scars.js');
    await s.grantScar(actor, { kind: 'crack' });
    const skill = actor.items.find(x => x.name === 'Обратный отсчёт');
    await skill.update({ 'system.uses.spent': 0 });
    gdt.dice(20, 1);
    const mod = await gdt.mod('memory/skills/living/duo.js');
    // Использование без боя отменяется отсчётом — трещина проверяется на заряде Кровавого бастиона напрямую
    const bastion = actor.items.find(x => x.name === 'Кровавый бастион');
    await bastion.update({ 'system.uses.spent': 0 });
    Hooks.callAll('dnd5e.postUseActivity', bastion.system.activities.contents[0], {}, {});
    await new Promise(r => setTimeout(r, 600));
    await gdt.settle();
    return { spent: actor.items.find(x => x.name === 'Кровавый бастион').system.uses.spent, roll: /Трещина/.test(game.messages.contents.at(-1)?.flavor ?? '') };
}, ids.hero);
check('Трещина: к20 = 1 — заряд сгорает ещё раз', crack.spent === 1 && crack.roll, JSON.stringify(crack));

const eventScar = await ev(async hero => {
    const actor = game.actors.get(hero);
    const e = await gdt.mod('labyrinth/events.js');
    const lines = await e.applyEffects([{ scar: true }], { one: actor, who: 'one', title: 'проверка' });
    return { lines: JSON.stringify(lines), scars: actor.items.filter(i => i.flags.gachadnd?.scar).map(i => i.name) };
}, ids.hero);
check('событие: исход scar — третий шрам (все три теперь у героя)', eventScar.scars.length === 3, JSON.stringify(eventScar));

// ---------- Правила Боссов
const rules = await ev(async ({ hero, scene, boss }) => {
    const actor = game.actors.get(hero);
    for (const i of actor.items.filter(i => i.flags.gachadnd?.scar)) await i.delete({ gachadndScar: true });
    const sc = game.scenes.get(scene);
    const combat = await Combat.create({ scene, active: true });
    await combat.createEmbeddedDocuments('Combatant', [hero, boss].map((id, i) => ({ tokenId: sc.tokens.find(t => t.actorId === id).id, sceneId: scene, actorId: id, initiative: 20 - i })));
    await combat.startCombat();
    await gdt.settle();
    const r = await gdt.mod('labyrinth/boss-rules.js');
    // Карта мира на узле Босса — правило выпадает само в начале боя: дождаться его, чтобы не гоняться с ним
    if (r.currentNodeType() === 'boss') for (let i = 0; i < 40 && !r.ruleOf(combat); i++) await gdt.sleep(100);
    await gdt.settle(400, 6000);
    const muffle = await r.setBossRule(combat, 'muffle');
    await gdt.settle();
    const counts = actor.getFlag('gachadnd', 'counts') ?? {};
    const syn = await gdt.mod('memory/synergy/synergy-data.js');
    const key = syn.TAG_KEYS?.[muffle?.tag];
    const announced = /Глушитель/.test(game.messages.contents.at(-1)?.content ?? '');
    await r.setBossRule(combat, 'sleepy');
    await gdt.settle();
    const asleep = actor.items.filter(i => i.flags.gachadnd?.asleep?.bossRule).map(i => i.name);
    const mutedAfter = key ? (actor.getFlag('gachadnd', 'counts') ?? {})[key] : null;
    await game.actors.get(boss).update({ 'system.attributes.hp.value': 14 });
    // Пробуждение — в хуке Мастера после обновления ПЗ: под нагрузкой полного прогона оно бывает дольше settle
    const sleeping = () => actor.items.filter(i => i.flags.gachadnd?.asleep?.bossRule).length;
    for (let i = 0; i < 50 && sleeping(); i++) await gdt.sleep(100);
    await gdt.settle();
    const woke = sleeping();
    await combat.delete();
    await gdt.settle();
    return { tag: muffle?.tag, muted: key ? counts[key] : 'нет ключа', announced, asleep, mutedAfter, woke };
}, { hero: ids.hero, scene: ids.scene, boss: bossId });
check('Глушитель: самый частый тег отряда — счёт 0, правило объявлено', rules.tag && rules.muted === 0 && rules.announced, JSON.stringify(rules));
check('Крайний спит: последний экипированный спит; Босс на половине ПЗ — проснулся', rules.asleep.length === 1 && rules.woke === 0, JSON.stringify(rules));
check('смена правила снимает Глушитель', rules.mutedAfter !== 0, JSON.stringify(rules));

const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
