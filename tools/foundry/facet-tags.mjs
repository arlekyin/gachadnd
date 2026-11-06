// Огранка: свет, движение, сталь в настоящей Foundry: node tools/foundry/facet-tags.mjs [--headed]
// Свобода сборки — в Терминале при выбранной строке камни не гаснут, любой встаёт в любое гнездо; Луч — урон
// мечом достаётся всем на линии от героя к цели, мимо линии — нет; Выверено — урон средний, без броска;
// Разбег — прошёл 20 фт к цели: атака с преимуществом, стоял — без; Рокировка — кнопка в карточке, герой и
// цель способности меняются местами; На бегу — движение после применения, до половины скорости: цели сами; Вспышка —
// цель в досягаемости, но вне фигуры, не задета, задеты все рядом с героем; цель дальше досягаемости способности — не срабатывает; Вплетение, Проводник — строкой с правилом в карточке.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, classKit } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
// Герой в (5,5); враги А (вплотную), Б, Г — на линии вправо, В — в стороне; союзник рядом с героем
const ids = await scene(page, { hero: { level: 5 }, enemies: [
    { name: 'Враг А', x: 6, y: 5 }, { name: 'Враг Б', x: 9, y: 5 }, { name: 'Враг В', x: 8, y: 8 }, { name: 'Враг Г', x: 11, y: 5 },
    { name: 'Союзник', x: 4, y: 7, disposition: 1 }
] });
const [A, B, V, G, ALLY] = ids.enemies;
const since = f.log.length;
// По два навыка света, движения и стали — по камню каждого
await skills(page, ids.hero, ['Фотосинтез', 'Ультрафиолет', 'Краб', 'Лунная походка', 'Крушитель мебели', 'Тюремная заточка']);
const W = await ev(async hero => {
    const actor = game.actors.get(hero);
    const mk = name => ({ name, type: 'weapon', system: { type: { value: 'martialM' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } });
    const items = await actor.createEmbeddedDocuments('Item', [mk('Меч'), mk('Топор')]);
    return Object.fromEntries(items.map(i => [i.name, i.id]));
}, ids.hero);
await classKit(page, ids.hero, { features: ['Second Wind'], spells: ['cure-wounds'], caster: { name: 'Жрец', identifier: 'cleric' } });
const place = (where, stone) => ev(async ({ hero, where, stone }) => (await gdt.mod('memory/facet/facet.js')).placeStone(game.actors.get(hero), where, stone), { hero: ids.hero, where, stone });
const unplace = (where, stone) => ev(async ({ hero, where, stone }) => (await gdt.mod('memory/facet/facet.js')).removeStone(game.actors.get(hero), where, stone), { hero: ids.hero, where, stone });
const target = id => ev(id => { canvas.tokens.placeables.find(t => t.actor?.id === id)?.setTarget(true, { releaseOthers: true }); }, id);

// ---------- Камни и свобода сборки
const grains = await ev(async hero => (await gdt.mod('memory/facet/facet.js')).grainsOf(game.actors.get(hero)), ids.hero);
check('камни: свет, движение, сталь — по одному (ступень I)', grains['свет'] === 1 && grains['движение'] === 1 && grains['сталь'] === 1, JSON.stringify(grains));
const free = await ev(async hero => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await game.gachadnd.openTerminal(game.actors.get(hero)); await sleep(1200);
    const el = () => foundry.applications.instances.get('gachadnd-dock').element;
    el().querySelector('[data-action="page"][data-page="facet"]').click(); await sleep(800);
    const stones = [...el().querySelectorAll('.gd-o-stone')];
    return { total: stones.length, names: stones.map(s => s.dataset.stone) };
}, ids.hero);
// Мышью, как игрок: строка Лечения, камень Вспышка — холст сцены под Терминалом щелчок не перехватывает
await page.locator('.gachadnd-dock .gd-o-row[data-where="heal"]').click({ timeout: 5000 });
await page.waitForTimeout(600);
const nofit = await page.locator('.gachadnd-dock .gd-o-stone.nofit').count();
const clicked = await page.locator('.gachadnd-dock .gd-o-stone[data-stone="flash"]').click({ timeout: 5000 }).then(() => true, e => e.message.split(String.fromCharCode(10))[0]);
await page.waitForTimeout(1000);
const healStones = await ev(async hero => (await gdt.mod('memory/facet/facet.js')).facetState(game.actors.get(hero)).placements.filter(p => p.where === 'heal').map(p => p.id), ids.hero);
await ev(() => foundry.applications.instances.get('gachadnd-dock')?.close());
check('свобода сборки: строка Лечения выбрана — ни один камень в шкатулке не погашен; есть Луч, Разбег, Выверено',
    free.total >= 3 && nofit === 0 && ['beam', 'charge', 'steady'].every(s => free.names.includes(s)), JSON.stringify({ ...free, nofit }));
check('Терминал мышью: щелчок по строке и по камню Вспышка — камень в гнезде Лечения', clicked === true && healStones.includes('flash'), JSON.stringify({ clicked, healStones }));
await unplace('heal', 'flash');

// ---------- Луч и Выверено: в Мече
await place(W['Меч'], 'beam');
await place(W['Меч'], 'steady');
await target(A);
const beam = await ev(async ({ hero, sword }) => {
    const activity = game.actors.get(hero).items.get(sword).system.activities.find(a => a.type === 'attack');
    const n = game.messages.size;
    const rolls = await activity.rollDamage({}, { configure: false }, {});
    await new Promise(r => setTimeout(r, 1800));
    const r = rolls?.[0];
    return { total: r?.total, dice: r?.dice?.length ?? 0, formula: r?.formula, cards: game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) };
}, { hero: ids.hero, sword: W['Меч'] });
const card = beam.cards.find(t => /Луч —/.test(t)) ?? '';
check('Луч: урон Мечом по Врагу А — карточка тем же уроном всем на линии (Враг Б, Враг Г), Врагу В в стороне — нет',
    /Враг Б/.test(card) && /Враг Г/.test(card) && !/Враг В/.test(card) && card.includes(String(beam.total)), JSON.stringify({ total: beam.total, cards: beam.cards }));
check('Выверено: кости не бросаются — 1к8 стал 5 (среднее), в броске нет костей', beam.dice === 0 && /^5\b/.test(String(beam.formula)), JSON.stringify({ formula: beam.formula, dice: beam.dice, total: beam.total }));

// Атака: у Меча кости урона есть — бросается как обычно; у оружия без костей — 10 на кости
const steadyAttack = await ev(async ({ hero, sword }) => {
    const actor = game.actors.get(hero);
    const [fist] = await actor.createEmbeddedDocuments('Item', [{ name: 'Кулак', type: 'weapon', system: { type: { value: 'simpleM' }, damage: { base: { number: 0, denomination: 0, bonus: '1', types: ['bludgeoning'] } }, equipped: true, proficient: 1 } }]);
    const { placeStone, removeStone } = await gdt.mod('memory/facet/facet.js');
    // Что выпало на к20: три броска, чтобы случайная 10 не сошла за фиксированную
    const once = async id => { const r = await actor.items.get(id).system.activities.find(a => a.type === 'attack').rollAttack({}, { configure: false }, { create: false }); return (Array.isArray(r) ? r[0] : r)?.dice?.[0]?.total ?? null; };
    const roll = async id => [await once(id), await once(id), await once(id)];
    const withDice = await roll(sword);
    await removeStone(actor, sword, 'steady');
    await placeStone(actor, fist.id, 'steady');
    const noDice = await roll(fist.id);    await removeStone(actor, fist.id, 'steady');
    await placeStone(actor, sword, 'steady');
    await fist.delete();
    return { withDice, noDice };
}, { hero: ids.hero, sword: W['Меч'] });
check('Выверено: атака оружием с костями бросается как обычно; оружие без костей — 10 на кости', steadyAttack.withDice.some(n => n !== 10) && steadyAttack.noDice.every(n => n === 10), JSON.stringify(steadyAttack));

// ---------- Разбег: в Топоре; бой, ход героя
await place(W['Топор'], 'charge');
const charge = await ev(async ({ hero, axe, A, ids }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const c of game.combats.contents) await c.delete();
    const scene = canvas.scene;
    const combat = await Combat.create({ scene: scene.id, active: true });
    const toks = scene.tokens.filter(t => [hero, A].includes(t.actorId));
    await combat.createEmbeddedDocuments('Combatant', toks.map(t => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, initiative: t.actorId === hero ? 20 : 5 })));
    await combat.startCombat();
    await gdt.settle(400, 4000);
    const token = scene.tokens.find(t => t.actorId === hero);
    const activity = game.actors.get(hero).items.get(axe).system.activities.find(a => a.type === 'attack');
    const roll = async () => { const r = await activity.rollAttack({}, { configure: false }, { create: false }); const x = Array.isArray(r) ? r[0] : r; return x?.options?.advantageMode ?? null; };
    const still = await roll();
    // Враг А в (6,5): уходим на 4 клетки назад, ход заново (начало хода — от новой клетки), разбег к цели
    await token.update({ x: 1 * 100 }, { animate: false });
    await combat.nextTurn(); await combat.nextTurn(); await gdt.settle(400, 4000);
    await token.update({ x: 5 * 100 }, { animate: false });
    await sleep(500);
    const run = await roll();
    return { still, run, start: token.getFlag('gachadnd', 'turnStart'), mode: CONFIG.Dice.D20Roll.ADV_MODE.ADVANTAGE, combat: combat.id };
}, { hero: ids.hero, axe: W['Топор'], A, ids });
check('Разбег: стоял — атака Топором без преимущества; прошёл 20 фт к цели — с преимуществом',
    charge.still !== charge.mode && charge.run === charge.mode, JSON.stringify(charge));

// ---------- Рокировка: в Топоре вместо Разбега; кнопка в карточке, обмен местами
await ev(async id => game.combats.get(id)?.delete(), charge.combat);
await unplace(W['Топор'], 'charge');
await place(W['Топор'], 'swap');
const swap = await ev(async ({ hero, axe, ally }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const scene = canvas.scene;
    const me = scene.tokens.find(t => t.actorId === hero), friend = scene.tokens.find(t => t.actorId === ally);
    await me.update({ x: 4 * 100, y: 5 * 100 }, { animate: false });
    friend.object?.setTarget(true, { releaseOthers: true });
    const before = { me: [me.x, me.y], friend: [friend.x, friend.y] };
    const n = game.messages.size;
    await game.actors.get(hero).items.get(axe).system.activities.find(a => a.type === 'attack').use({}, { configure: false }, {});
    await sleep(1200);
    const msg = game.messages.contents.slice(n).find(m => m.type === 'usage' || m.getFlag('dnd5e', 'messageType') === 'usage');
    const el = document.querySelector(`[data-message-id="${msg?.id}"]`);
    const button = !!el?.querySelector('.gd-stone-swap');
    const tip = el?.querySelector('.gd-facet-line [data-tooltip]')?.dataset.tooltip ?? '';
    // Выбор цели — окно; здесь — сразу просьба Мастеру, как после выбора
    const { requestGM } = await gdt.mod('core/socket.js');
    await requestGM('facetSwap', { sceneId: scene.id, a: me.id, b: friend.id, actorId: hero });
    await sleep(1200);
    return { button, tip, before, after: { me: [me.x, me.y], friend: [friend.x, friend.y] } };
}, { hero: ids.hero, axe: W['Топор'], ally: ALLY });
check('Рокировка: в карточке Топора кнопка и правило камня в подсказке; герой и цель способности поменялись местами',
    swap.button && /местами/.test(swap.tip) && swap.after.me.join() === swap.before.friend.join() && swap.after.friend.join() === swap.before.me.join(), JSON.stringify(swap));

// ---------- На бегу: в Топоре вместо Рокировки; считается только движение после применения, до половины скорости
await unplace(W['Топор'], 'swap');
await place(W['Топор'], 'run');
const run = await ev(async ({ hero, axe, G, V }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const actor = game.actors.get(hero), me = canvas.scene.tokens.find(t => t.actorId === hero);
    const names = () => [...game.user.targets].map(tok => tok.name);
    const activity = actor.items.get(axe).system.activities.find(a => a.type === 'attack');
    // Основа скорости — 30, навык движения добавляет 10: половина — 4 клетки
    await actor.update({ 'system.attributes.movement.walk': 30 });
    const speed = actor.system.attributes.movement.walk;
    // До применения: герой проходит вплотную мимо Врага В в (8, 8) — это не в счёт
    await me.move([{ x: 800, y: 700, action: 'displace' }], { animate: false }); await sleep(400);
    await me.update({ x: 700, y: 700 }); await sleep(800);
    await me.move([{ x: 500, y: 400, action: 'displace' }], { animate: false }); await sleep(500);
    canvas.tokens.placeables.find(t => t.actor?.id === G)?.setTarget(true, { releaseOthers: true });
    const n = game.messages.size;
    await activity.use({}, { configure: false }, {});
    await sleep(1200);
    const msg = game.messages.contents.slice(n).find(m => m.type === 'usage' || m.getFlag('dnd5e', 'messageType') === 'usage');
    const line = () => document.querySelector(`[data-message-id="${msg?.id}"] .gd-facet-line`)?.textContent.replace(/\s+/g, ' ') ?? '';
    const before = { targets: names(), line: line() };
    // После применения — бегом вправо по ряду 4 на 5 клеток: половина скорости кончается раньше, чем Враг Г в (11, 5) рядом
    await me.update({ x: 1000, y: 400 }); await sleep(1400);
    const after = { targets: names(), line: line() };
    // Бросок заканчивает забег: дальше движение прицел не меняет
    await activity.rollDamage({}, { configure: false }, {}); await sleep(800);
    await me.move([{ x: 700, y: 700, action: 'displace' }], { animate: false }); await sleep(300);
    await me.update({ x: 800, y: 700 }); await sleep(800);
    return { speed, before, after, afterRoll: names() };
}, { hero: ids.hero, axe: W['Топор'], G, V });
check('На бегу: движение до применения не в счёт — прицел прежний, в карточке правило про атаки по возможности',
    run.before.targets.length === 1 && /Враг Г/.test(run.before.targets[0]) && /всегда провоцирует атаки по возможности/.test(run.before.line), JSON.stringify(run.before));
check('На бегу: после применения прицел сам на всех, мимо кого прошёл (Враг А, Враг Б); Враг Г — дальше половины скорости',
    run.after.targets.some(n => /Враг А/.test(n)) && run.after.targets.some(n => /Враг Б/.test(n)) && !run.after.targets.some(n => /Враг Г|Враг В/.test(n)) && /цели — все, мимо кого вы прошли: .*Враг А/.test(run.after.line), JSON.stringify({ speed: run.speed, after: run.after }));
check('На бегу: бросок заканчивает забег — дальше прицел не меняется', !run.afterRoll.some(n => /Враг В/.test(n)), JSON.stringify(run.afterRoll));

// ---------- Вспышка: в Мече вместо Луча; Враг Г дальше досягаемости меча — способность не срабатывает
await unplace(W['Меч'], 'beam');
await place(W['Меч'], 'flash');
await target(G);
const flash = await ev(async ({ hero, sword }) => {
    // Герой — в (6, 4), рядом Враг А (6, 5); Враг Г в (11, 5) — дальше 5 фт
    await canvas.scene.tokens.find(t => t.actorId === hero).move([{ x: 600, y: 400, action: 'displace' }], { animate: false });
    await new Promise(r => setTimeout(r, 600));
    const activity = game.actors.get(hero).items.get(sword).system.activities.find(a => a.type === 'attack');
    const n = game.messages.size;
    const used = await activity.use({}, { configure: false }, {});
    const blocked = !used && game.messages.size === n;
    await activity.rollDamage({}, { configure: false }, {});
    await new Promise(r => setTimeout(r, 1500));
    return { blocked, cards: game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) };
}, { hero: ids.hero, sword: W['Меч'] });
check('Вспышка в Мече: цель дальше досягаемости — применить нельзя; при броске — «вне досягаемости», урона рядом нет',
    flash.blocked && flash.cards.some(t => /Враг Г/.test(t) && /вне досягаемости способности \(5 футов\)/.test(t)) && !flash.cards.some(t => /Вспышка:/.test(t)), JSON.stringify(flash));

// ---------- Вспышка в Луке: Враг Г в дальности лука, но вне фигуры — не задет, задеты те, кто рядом с героем
await unplace(W['Меч'], 'flash');
const bow = await ev(async hero => {
    const [item] = await game.actors.get(hero).createEmbeddedDocuments('Item', [{ name: 'Лук', type: 'weapon', system: { type: { value: 'martialR' }, range: { value: 150, long: 600, units: 'ft' }, damage: { base: { number: 1, denomination: 8, types: ['piercing'] } }, equipped: true, proficient: 1 } }]);
    return item.id;
}, ids.hero);
await place(bow, 'flash');
await target(G);
const bowFlash = await ev(async ({ hero, bow }) => {
    const n = game.messages.size;
    await game.actors.get(hero).items.get(bow).system.activities.find(a => a.type === 'attack').rollDamage({}, { configure: false }, {});
    await new Promise(r => setTimeout(r, 1500));
    return game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}, { hero: ids.hero, bow });
check('Вспышка в Луке: цель в дальности, но вне фигуры — «вне фигуры», а Враг А рядом с героем получает урон',
    bowFlash.some(t => /Враг Г/.test(t) && /вне фигуры/.test(t)) && bowFlash.some(t => /Вспышка —/.test(t) && /Враг А/.test(t) && /все в 10 футах/.test(t)), JSON.stringify(bowFlash));
await ev(async ({ hero, bow }) => game.actors.get(hero).items.get(bow)?.delete(), { hero: ids.hero, bow });

await f.shot('facet-tags');
await ev(hero => { const a = game.actors.get(hero); return a.deleteEmbeddedDocuments('Item', a.items.filter(i => ['Меч', 'Топор'].includes(i.name)).map(i => i.id)); }, ids.hero);
for (const c of await ev(() => game.combats.map(c => c.id))) await ev(id => game.combats.get(id)?.delete(), c);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
