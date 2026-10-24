// Огранка: свет, движение, сталь в настоящей Foundry: node tools/foundry/facet-tags.mjs [--headed]
// Свобода сборки — в Терминале при выбранной строке камни не гаснут, любой встаёт в любое гнездо; Луч — урон
// мечом достаётся всем врагам на линии от героя к цели, мимо линии — нет; Выверено — урон средний, без броска;
// Разбег — прошёл 20 фт к цели: атака с преимуществом, стоял — без; Рокировка — кнопка в карточке, герой и
// союзник меняются местами; На бегу — цель сама: первый враг, мимо которого герой пробежал; Вспышка — цель дальше
// 10 фт, камень молчит; Вплетение, Проводник — строкой с правилом в карточке (docs/ogranka-stones.md).
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, classKit } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
// Герой в (5,5); враги А, Б, Г — на линии вправо, В — в стороне; союзник рядом с героем
const ids = await scene(page, { hero: { level: 5 }, enemies: [
    { name: 'Враг А', x: 7, y: 5 }, { name: 'Враг Б', x: 9, y: 5 }, { name: 'Враг В', x: 8, y: 8 }, { name: 'Враг Г', x: 11, y: 5 },
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
check('Луч: урон Мечом по Врагу А — карточка тем же уроном Врагу Б и Врагу Г на линии, Врагу В в стороне — нет',
    /Враг Б/.test(card) && /Враг Г/.test(card) && !/Враг В/.test(card) && card.includes(String(beam.total)), JSON.stringify({ total: beam.total, cards: beam.cards }));
check('Выверено: кости не бросаются — 1к8 стал 5 (среднее), в броске нет костей', beam.dice === 0 && /^5\b/.test(String(beam.formula)), JSON.stringify({ formula: beam.formula, dice: beam.dice, total: beam.total }));

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
    // Враг А в (7,5): уходим на 4 клетки назад, ход заново (начало хода — от новой клетки), разбег к цели
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
    const before = { me: [me.x, me.y], friend: [friend.x, friend.y] };
    const n = game.messages.size;
    await game.actors.get(hero).items.get(axe).system.activities.find(a => a.type === 'attack').use({}, { configure: false }, {});
    await sleep(1200);
    const msg = game.messages.contents.slice(n).find(m => m.type === 'usage' || m.getFlag('dnd5e', 'messageType') === 'usage');
    const el = document.querySelector(`[data-message-id="${msg?.id}"]`);
    const button = !!el?.querySelector('.gd-stone-swap');
    const tip = el?.querySelector('.gd-facet-line [data-tooltip]')?.dataset.tooltip ?? '';
    // Выбор союзника — окно; здесь — сразу просьба Мастеру, как после выбора
    const { requestGM } = await gdt.mod('core/socket.js');
    await requestGM('facetSwap', { sceneId: scene.id, a: me.id, b: friend.id, actorId: hero });
    await sleep(1200);
    return { button, tip, before, after: { me: [me.x, me.y], friend: [friend.x, friend.y] } };
}, { hero: ids.hero, axe: W['Топор'], ally: ALLY });
check('Рокировка: в карточке Топора кнопка и правило камня в подсказке; герой и союзник поменялись местами',
    swap.button && /местами/.test(swap.tip) && swap.after.me.join() === swap.before.friend.join() && swap.after.friend.join() === swap.before.me.join(), JSON.stringify(swap));

// ---------- На бегу: в Топоре вместо Рокировки; герой пробегает мимо Врага А — цель сама переходит на него
await unplace(W['Топор'], 'swap');
await place(W['Топор'], 'run');
await target(G);
const run = await ev(async ({ hero, axe }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const me = canvas.scene.tokens.find(t => t.actorId === hero);
    // На (5, 4) переносом, потом бегом вправо по ряду 4: Враг А в (7, 5) — по диагонали от клетки (6, 4)
    await me.move([{ x: 500, y: 400, action: 'displace' }], { animate: false }); await sleep(500);
    await me.update({ x: 1000, y: 400 }); await sleep(1200);
    const n = game.messages.size;
    await game.actors.get(hero).items.get(axe).system.activities.find(a => a.type === 'attack').use({}, { configure: false }, {});
    await sleep(1200);
    const msg = game.messages.contents.slice(n).find(m => m.type === 'usage' || m.getFlag('dnd5e', 'messageType') === 'usage');
    const line = document.querySelector(`[data-message-id="${msg?.id}"] .gd-facet-line`)?.textContent.replace(/\s+/g, ' ') ?? '';
    return { target: [...game.user.targets][0]?.name ?? null, line };
}, { hero: ids.hero, axe: W['Топор'] });
check('На бегу: прицел на Враге Г, герой пробежал мимо Врага А — цель сама стала Врагом А, в карточке «пробежали»',
    /Враг А/.test(run.target ?? '') && /На бегу: цель — .*Враг А/.test(run.line), JSON.stringify(run));

// ---------- Вспышка: в Мече вместо Луча; цель Враг Г далеко — форма молчит
await unplace(W['Меч'], 'beam');
await place(W['Меч'], 'flash');
await target(G);
const flash = await ev(async ({ hero, sword }) => {
    // Герой — в (5, 4), рядом Враг А; Враг Г в (11, 5) — дальше 10 фт
    await canvas.scene.tokens.find(t => t.actorId === hero).move([{ x: 500, y: 400, action: 'displace' }], { animate: false });
    await new Promise(r => setTimeout(r, 600));
    const n = game.messages.size;
    await game.actors.get(hero).items.get(sword).system.activities.find(a => a.type === 'attack').rollDamage({}, { configure: false }, {});
    await new Promise(r => setTimeout(r, 1500));
    return game.messages.contents.slice(n).map(m => m.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}, { hero: ids.hero, sword: W['Меч'] });
check('Вспышка: цель дальше 10 фт — «Вспышка не сработала», и Врагу А рядом с героем урона нет',
    flash.some(t => /дальше 10 футов/.test(t) && /не сработала/.test(t)) && !flash.some(t => /Вспышка —.*попадание|Без спасброска/.test(t)), JSON.stringify(flash));

await f.shot('facet-tags');
await ev(hero => { const a = game.actors.get(hero); return a.deleteEmbeddedDocuments('Item', a.items.filter(i => ['Меч', 'Топор'].includes(i.name)).map(i => i.id)); }, ids.hero);
for (const c of await ev(() => game.combats.map(c => c.id))) await ev(id => game.combats.get(id)?.delete(), c);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
