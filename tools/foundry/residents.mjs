// Жильцы Якоря в настоящей Foundry: node tools/foundry/residents.mjs [--headed]
// После Босса у купола ждут двое-трое, отряд впускает одного; Мастер селит остальных. Окно: ниши и прилавки
// (снимки tools/foundry/out/residents-*.png). Услуги: Перековка (смена и перенос тега, раз за визит), Картограф
// (узел не начатой карты), ячейки Ростовщика (не пахнут, забрать вне Якоря, не в бою, остаток — в Хранилище),
// Знахарь (Очистка за полцены без роста, сброс перегрева), приманка (первый прорыв Охоты — на неё).
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const settle = () => ev(() => gdt.settle());

await install(page);
const ids = await scene(page, { hero: { level: 5 } });
const hero = ids.hero;
const since = f.log.length;
const saved = await ev(() => Object.fromEntries(['anchorResidents', 'residentsState', 'anchorOpen', 'runFloor', 'anchorSceneId', 'hintScent', 'hintAtmosphere', 'gmHints'].map(k => [k, game.settings.get('gachadnd', k)])));

const op = payload => ev(async payload => { await (await gdt.mod('labyrinth/residents.js')).request(payload); await gdt.settle(); }, payload);
const gold = () => ev(hero => game.actors.get(hero).system.currency.gp, hero);
const state = () => ev(() => game.settings.get('gachadnd', 'residentsState'));

// Отряд: герой — персонаж «игрока»; карта этажа: Вход → три узла → Застава → Босс, Босс пройден
await ev(async hero => {
    const actor = game.actors.get(hero);
    Object.defineProperty(actor, 'hasPlayerOwner', { get: () => true, configurable: true });
    await actor.update({ 'system.currency': { gp: 2000, sp: 0, cp: 0, ep: 0, pp: 0 } });
    for (const [k, v] of [['anchorResidents', []], ['residentsState', {}], ['anchorOpen', false], ['runFloor', 1], ['anchorSceneId', ''], ['hintScent', true], ['hintAtmosphere', true], ['gmHints', true]]) await game.settings.set('gachadnd', k, v);
    const { MAP_DATA } = await gdt.mod('labyrinth/map.js');
    const node = (id, row, type, next) => ({ id, row, col: 0, type, label: MAP_DATA.LABELS[type], icon: MAP_DATA.ICONS[type], color: MAP_DATA.COLORS[type], next });
    const nodes = [node('0-0', 0, 'start', ['1-0', '1-1']), node('1-0', 1, 'mob', ['2-0']), node('1-1', 1, 'event', ['2-0']), node('2-0', 2, 'outpost', ['3-0']), node('3-0', 3, 'boss', [])];
    const rows = [[nodes[0]], [nodes[1], nodes[2]], [nodes[3]], [nodes[4]]];
    await canvas.scene.setFlag('gachadnd', 'floorMap', { rows, nodes, currentNodeId: '3-0', visitedNodes: ['0-0', '1-0', '2-0', '3-0'] });
    await game.settings.set('gachadnd', 'floorSceneId', canvas.scene.id);
}, hero);

// ---------- После Босса: у купола ждут
await ev(async () => { await (await gdt.mod('labyrinth/anchor.js')).setAnchor(true, { travel: false }); await gdt.settle(); });
let st = await state();
check('после Босса у купола ждут двое-трое', [2, 3].includes(st.offer?.ids?.length) && st.offer.floor === 1, JSON.stringify(st.offer));
const first = st.offer?.ids?.[0];
await op({ op: 'choose', id: first });
let living = await ev(() => game.settings.get('gachadnd', 'anchorResidents'));
st = await state();
check('отряд впустил одного: он живёт в Якоре, остальные ушли', living.length === 1 && living[0].id === first && living[0].floor === 1 && !st.offer, JSON.stringify({ living, offer: st.offer }));
await ev(async () => { const a = await gdt.mod('labyrinth/anchor.js'); await a.setAnchor(false, { travel: false }); await a.setAnchor(true, { travel: false }); await gdt.settle(); });
check('за этаж — один: при новом входе в Якорь никто не ждёт', !(await state()).offer);
for (const id of ['smith', 'cartographer', 'broker', 'healer', 'lurer'].filter(id => id !== first)) await op({ op: 'settle', id });
living = await ev(() => game.settings.get('gachadnd', 'anchorResidents').map(r => r.id).sort().join());
check('Мастер поселил остальных — в Якоре все пятеро', living === 'broker,cartographer,healer,lurer,smith', living);
check('кнопка «Ячейки Ростовщика» на панели токенов', await ev(() => {
    const token = ui.controls.controls?.tokens ?? ui.controls.controls?.token;
    return !!Object.values(token?.tools ?? {}).find(t => t.name === 'gachadnd-cells');
}));

// ---------- Кузнец памяти
// Обычные навыки: первый — с двумя тегами и больше (для переноса), второй — без его тегов
const pickNames = await ev(async () => {
    const index = await game.packs.get('gachadnd.gacha-skills').getIndex({ fields: ['flags.gachadnd.rarity', 'flags.gachadnd.tags', 'flags.gachadnd.undeletable', 'flags.gachadnd.horseman'] });
    const common = [...index].filter(e => ['gray', 'green'].includes(e.flags?.gachadnd?.rarity) && !e.flags.gachadnd.undeletable && !e.flags.gachadnd.horseman).sort((x, y) => x.name.localeCompare(y.name));
    const two = common.find(e => (e.flags.gachadnd.tags ?? []).length >= 2);
    const other = common.find(e => e !== two && (e.flags.gachadnd.tags ?? []).length >= 1 && !(e.flags.gachadnd.tags ?? []).some(t => two.flags.gachadnd.tags.includes(t)));
    return [two.name, other.name];
});
const skillIds = await skills(page, hero, pickNames);
const tagsOf = id => ev(({ hero, id }) => game.actors.get(hero).items.get(id).flags.gachadnd.tags, { hero, id });
const [a, b] = Object.values(skillIds);
const tagsA = await tagsOf(a), tagsB = await tagsOf(b);
const all = await ev(async () => (await gdt.mod('labyrinth/residents.js')).allTags());
const fresh = all.find(t => !tagsA.includes(t) && !tagsB.includes(t));
let before = await gold();
await op({ op: 'forge', mode: 'change', actorId: hero, itemId: a, tag: tagsA[0], newTag: fresh });
const changed = await tagsOf(a);
check('Перековка: тег сменён, золото — 0,6 Базы', changed.includes(fresh) && !changed.includes(tagsA[0]) && before - await gold() === 60, `${tagsA} → ${changed}, ${before} → ${await gold()}`);
await op({ op: 'forge', mode: 'change', actorId: hero, itemId: b, tag: tagsB[0], newTag: all.find(t => !tagsB.includes(t)) });
check('Перековка — раз за визит', JSON.stringify(await tagsOf(b)) === JSON.stringify(tagsB), String(await tagsOf(b)));
await ev(async () => { const s = game.settings.get('gachadnd', 'residentsState'); await game.settings.set('gachadnd', 'residentsState', { ...s, visit: s.visit + 1 }); });
const movable = changed.find(t => !tagsB.includes(t));
await op({ op: 'forge', mode: 'move', actorId: hero, itemId: a, tag: movable, targetId: b });
const [afterA, afterB] = [await tagsOf(a), await tagsOf(b)];
check('новый визит: тег перенесён на другой навык', !afterA.includes(movable) && afterB.includes(movable), `${afterA} | ${afterB}`);

// ---------- Картограф: новая карта, отряд на неё не вышел
await ev(async () => {
    const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    Object.assign(map, { currentNodeId: null, visitedNodes: [], charted: 0 });
    await canvas.scene.setFlag('gachadnd', 'floorMap', map);
});
before = await gold();
await op({ op: 'chart', actorId: hero, nodeId: '1-0', type: 'shop' });
await op({ op: 'chart', actorId: hero, nodeId: '3-0', type: 'shop' });
const chart = await ev(() => { const m = canvas.scene.getFlag('gachadnd', 'floorMap'); return { a: m.nodes[1].type, label: m.nodes[1].label, boss: m.nodes[4].type, charted: m.charted }; });
check('Картограф: «Монстры» → «Магазин» за 0,4 Базы, Босс не трогается', chart.a === 'shop' && chart.label === 'Магазин' && chart.boss === 'boss' && chart.charted === 1 && before - await gold() === 40, JSON.stringify({ ...chart, paid: before - await gold() }));

// ---------- Ростовщик
const crystals = await ev(async hero => {
    const actor = game.actors.get(hero);
    const inv = await gdt.mod('memory/inventory.js');
    for (const n of ['Эльфийский выстрел', 'Не пройдёшь', 'Пули — это скучно']) await inv.giveCrystal(actor, { skillName: n });
    return actor.items.filter(i => i.flags.gachadnd?.is_crystal_item).map(i => ({ id: i.id, name: i.name, rarity: i.flags.gachadnd.rarity }));
}, hero);
const scent = () => ev(async hero => (await gdt.mod('labyrinth/anchor.js')).actorScent(game.actors.get(hero)).crystals, hero);
const scentBefore = await scent();
before = await gold();
await op({ op: 'cellOpen', actorId: hero });
await op({ op: 'cellOpen', actorId: hero });
st = await state();
check('ячейки: первая 0,3 Базы, вторая 0,6', st.cells.length === 2 && before - await gold() === 90, `${st.cells.length}, ${before - await gold()} зм`);
await op({ op: 'cellPut', actorId: hero, cellId: st.cells[0].id, itemId: crystals[0].id });
st = await state();
check('кристалл в ячейке — не в сумке и не пахнет', st.cells[0].data?.name === crystals[0].name && await scent() < scentBefore && !(await ev(({ hero, id }) => !!game.actors.get(hero).items.get(id), { hero, id: crystals[0].id })),
    `${st.cells[0].data?.name}; Запах ${scentBefore} → ${await scent()}`);
await ev(async () => { await (await gdt.mod('labyrinth/anchor.js')).setAnchor(false, { travel: false }); await gdt.settle(); });
const combatId = await combat(page, ids.scene, [hero, ids.enemies[0]]);
await op({ op: 'cellTake', actorId: hero, cellId: st.cells[0].id });
check('в бою ячейку не открыть', !!(await state()).cells[0].data);
await ev(id => game.combats.get(id).delete(), combatId);
await op({ op: 'cellTake', actorId: hero, cellId: st.cells[0].id });
check('вне Якоря, вне боя — кристалл забран из ячейки', !(await state()).cells[0].data && await ev(({ hero, name }) => game.actors.get(hero).items.some(i => i.name === name), { hero, name: crystals[0].name }));
await ev(async () => { await (await gdt.mod('labyrinth/anchor.js')).setAnchor(true, { travel: false }); await gdt.settle(); });
await op({ op: 'cellOpen', actorId: hero });
st = await state();
await op({ op: 'cellPut', actorId: hero, cellId: st.cells[0].id, itemId: crystals[1].id });
await ev(async () => { const a = await gdt.mod('labyrinth/anchor.js'); await a.setAnchor(false, { travel: false }); await a.setAnchor(true, { travel: false }); await gdt.settle(); });
const stash = await ev(hero => (game.actors.get(hero).getFlag('gachadnd', 'stash') ?? []).map(d => d.name), hero);
check('возвращение в Якорь: невзятое — в Хранилище, ячейки закрыты', stash.includes(crystals[1].name) && !(await state()).cells.length, stash.join(', '));

// ---------- Знахарь
await ev(({ hero, a }) => game.actors.get(hero).items.get(a).update({ 'flags.gachadnd.heat': { borrowed: 0, extra: 3, locked: true } }), { hero, a });
before = await gold();
await op({ op: 'cool', actorId: hero });
const heat = await ev(({ hero, a }) => game.actors.get(hero).items.get(a).flags.gachadnd.heat, { hero, a });
check('Знахарь: перегрев и блок сняты за 0,3 Базы', heat.extra === 0 && !heat.locked && before - await gold() === 30, JSON.stringify(heat));
before = await gold();
const cleanses = await ev(hero => game.actors.get(hero).getFlag('gachadnd', 'shop_cleanses') ?? 0, hero);
await op({ op: 'cleanse', actorId: hero, itemId: b });
check('Знахарь: Очистка за полцены, счётчик Очисток не растёт', !(await ev(({ hero, b }) => !!game.actors.get(hero).items.get(b), { hero, b }))
    && before - await gold() === 25 && (await ev(hero => game.actors.get(hero).getFlag('gachadnd', 'shop_cleanses') ?? 0, hero)) === cleanses, `${before - await gold()} зм`);

// ---------- Приманщик
// Кристаллы в сумке сейчас (взятый из ячейки создан заново — с новым id)
const bag = await ev(hero => game.actors.get(hero).items.filter(i => i.flags.gachadnd?.is_crystal_item).map(i => ({ id: i.id, name: i.name, rarity: i.flags.gachadnd.rarity })), hero);
const blue = bag.find(c => ['blue', 'purple', 'red'].includes(c.rarity));
const grayOne = bag.find(c => c.rarity === 'gray' || c.rarity === 'green');
if (grayOne) {
    await op({ op: 'bait', actorId: hero, itemId: grayOne.id });
    check('приманка из серого или зелёного — нельзя', !(await state()).bait);
}
await op({ op: 'bait', actorId: hero, itemId: blue?.id });
st = await state();
check('приманка спрятана: кристалл отдан', st.bait?.name === blue?.name, JSON.stringify(st.bait));
// Охота: отряду — гора красных кристаллов, вход на узел Монстров
const hunt = await ev(async hero => {
    const actor = game.actors.get(hero);
    const inv = await gdt.mod('memory/inventory.js');
    const pack = game.packs.get('gachadnd.gacha-skills');
    const index = await pack.getIndex({ fields: ['flags.gachadnd.rarity'] });
    const red = index.find(e => e.flags?.gachadnd?.rarity === 'red');
    for (let i = 0; i < 3; i++) await inv.giveCrystal(actor, { skillId: red._id, skillName: red.name });
    const anchor = await gdt.mod('labyrinth/anchor.js');
    const from = game.messages.size;
    await anchor.announceScent('mob');
    await gdt.settle();
    const fresh = game.messages.contents.slice(from).map(m => m.content);
    return { state: anchor.partyScent().state, gm: fresh.some(c => /Приманка/.test(c)), players: fresh.some(c => /хрустит кристалл/.test(c)), bait: game.settings.get('gachadnd', 'residentsState').bait };
}, hero);
check('Охота: первый прорыв — на приманку (шёпот Мастеру и строка игрокам), приманки больше нет', hunt.state === 'hunt' && hunt.gm && hunt.players && !hunt.bait, JSON.stringify(hunt));

// ---------- Окно
const shots = await ev(async () => {
    await game.gachadnd.openResidents();
    await new Promise(r => setTimeout(r, 600));
    const el = document.getElementById('gachadnd-residents');
    return { lit: el?.querySelectorAll('.gd-res-niche.lit').length, counter: !!el?.querySelector('.gd-res-host') };
});
check('окно: пять горящих ниш и прилавок', shots.lit === 5 && shots.counter, JSON.stringify(shots));
for (const id of ['smith', 'cartographer', 'broker', 'healer', 'lurer']) {
    await ev(async id => { const app = foundry.applications.instances.get('gachadnd-residents'); app.focusId = id; app.sync(); }, id);
    if (id === 'smith') await ev(a => { const app = foundry.applications.instances.get('gachadnd-residents'); app.pick = { skill: a }; app.sync(); const tag = app.element.querySelector('[data-action="pickTag"]')?.dataset.tag; app.pick.tag = tag; app.sync(); }, a);
    await wait(400);
    await f.shot(`residents-${id}`);
}
await ev(() => foundry.applications.instances.get('gachadnd-residents')?.close());

await ev(async s => {
    for (const [k, v] of Object.entries(s)) await game.settings.set('gachadnd', k, v);
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
}, saved);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
