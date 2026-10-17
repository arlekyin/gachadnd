// Летопись этажа в настоящей Foundry: node tools/foundry/chronicle.mjs [--headed]
// Карта прошлого этажа с пройденным путём и событиями (сгоревший навык, прорыв, павший, сделка луны, жилец),
// Мастер чертит следующий этаж кнопкой окна карты — у всех сцена. Снимки по ходу сцены —
// tools/foundry/out/chronicle-*.png. Пропуск щелчком; эффекты выключены — сцены нет.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, { hero: { level: 5 } });
const hero = ids.hero;
const since = f.log.length;
// Надгробие проверки из оборванного прогона — убрать до того, как запомнить настройки
await ev(() => game.settings.set('gachadnd', 'graveyard', (game.settings.get('gachadnd', 'graveyard') ?? []).filter(g => g.id !== 'gdtest')));
const saved = await ev(() => Object.fromEntries(['runFloor', 'graveyard', 'anchorResidents', 'effects', 'floorSceneId', 'impactSlow'].map(k => [k, game.settings.get('gachadnd', k)])));

// Прошлый этаж: Вход → Монстры → Событие → Застава → Привал → Босс; Элита и Магазин — в стороне
await ev(async hero => {
    const actor = game.actors.get(hero);
    Object.defineProperty(actor, 'hasPlayerOwner', { get: () => true, configurable: true });
    await game.settings.set('gachadnd', 'effects', 'full');
    await game.settings.set('gachadnd', 'impactSlow', 6);
    await game.settings.set('gachadnd', 'runFloor', 2);
    const { MAP_DATA } = await gdt.mod('labyrinth/map.js');
    const node = (id, row, col, type, next) => ({ id, row, col, type, label: MAP_DATA.LABELS[type], icon: MAP_DATA.ICONS[type], color: MAP_DATA.COLORS[type], next });
    const nodes = [
        node('0-0', 0, 0, 'start', ['1-0', '1-1', '1-2']),
        node('1-0', 1, 0, 'mob', ['2-0']), node('1-1', 1, 1, 'elite', ['2-0', '2-1']), node('1-2', 1, 2, 'shop', ['2-1']),
        node('2-0', 2, 0, 'event', ['3-0']), node('2-1', 2, 1, 'risk', ['3-0']),
        node('3-0', 3, 0, 'outpost', ['4-0', '4-1']),
        node('4-0', 4, 0, 'rest', ['5-0']), node('4-1', 4, 1, 'mob', ['5-0']),
        node('5-0', 5, 0, 'boss', [])
    ];
    const rows = [0, 1, 2, 3, 4, 5].map(r => nodes.filter(n => n.row === r));
    nodes.find(n => n.id === '5-0').deal = { status: 'sealed', lot: 'echo', result: { lot: 'echo', text: '' } };
    await canvas.scene.setFlag('gachadnd', 'floorMap', { rows, nodes, currentNodeId: '2-0', visitedNodes: ['0-0', '1-0', '2-0'] });
    await game.settings.set('gachadnd', 'floorSceneId', canvas.scene.id);
}, hero);

// События по пути: на Событии сгорел навык, на Заставе — прорыв, на Привале осталось тело
const [skillId] = Object.values(await skills(page, hero, ['Берсерк']));
await ev(async ({ hero, skillId }) => {
    await game.actors.get(hero).items.get(skillId).delete();
    const log = await gdt.mod('labyrinth/chronicle-log.js');
    await log.logChronicle('breach', 'Прорыв Пожирателя', '3-0');
    const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
    Object.assign(map, { currentNodeId: '5-0', visitedNodes: ['0-0', '1-0', '2-0', '3-0', '4-0', '5-0'] });
    await canvas.scene.setFlag('gachadnd', 'floorMap', map);
    await game.settings.set('gachadnd', 'graveyard', [...game.settings.get('gachadnd', 'graveyard'), { id: 'gdtest', actorId: 'x', name: 'GD-тест: Павший', floor: 2, nodeId: '4-0', at: Date.now() }]);
    await game.settings.set('gachadnd', 'anchorResidents', [{ id: 'healer', floor: 2 }]);
    await gdt.settle();
}, { hero, skillId });
const logged = await ev(() => canvas.scene.getFlag('gachadnd', 'floorMap').chronicle ?? []);
check('Летопись записала сгоревший навык и прорыв на их узлах', logged.some(e => e.kind === 'burn' && e.nodeId === '2-0' && /Берсерк/.test(e.text)) && logged.some(e => e.kind === 'breach' && e.nodeId === '3-0'), JSON.stringify(logged));
const marks = await ev(async () => {
    const c = await gdt.mod('labyrinth/chronicle.js');
    return c.floorMarks(canvas.scene.getFlag('gachadnd', 'floorMap'), 2).map(m => `${m.nodeId}:${m.kind}`).sort().join(' ');
});
check('пометки этажа: павший, сгоревший, прорыв, луна, жилец', marks === '2-0:burn 3-0:breach 4-0:fallen 5-0:moon 5-0:resident', marks);

// ---------- Мастер чертит этаж III кнопкой окна карты
await ev(async () => {
    await game.gachadnd.openMapTerminal();
    await new Promise(r => setTimeout(r, 600));
    const el = document.getElementById('gachadnd-map-terminal');
    el.querySelector('[name="length"]').value = '9';
    el.querySelector('[name="floor"]').value = '3';
    el.querySelector('[data-action="generate"]').click();
});
// Снимки медленные — сцена замедлена (настройка «Замедление»), снимок — по фазе сцены
// Фаза — эта или уже следующая (снимок мог занять дольше фазы); сцена кончилась — тоже дальше
const ORDER = ['dim', 'thread', 'turn', 'end'];
const phase = (name, timeout = 90000) => page.waitForFunction(({ p, order }) => {
    const root = document.querySelector('.gd-chronicle');
    return !root || order.indexOf(root.dataset.phase) >= order.indexOf(p);
}, { p: name, order: ORDER }, { timeout, polling: 100 });
await phase('dim');
await wait(1800);
await f.shot('chronicle-1-dim');
await phase('thread');
await page.waitForFunction(() => document.querySelectorAll('.gd-chr-mark.on').length >= 2, null, { timeout: 60000, polling: 100 }).catch(() => {});
await f.shot('chronicle-2-thread');
await phase('turn');
const state = await ev(() => ({
    on: document.querySelectorAll('.gd-chr-mark.on').length, all: document.querySelectorAll('.gd-chr-mark').length,
    floor: game.settings.get('gachadnd', 'runFloor'), fresh: !(canvas.scene.getFlag('gachadnd', 'floorMap').chronicle?.length)
}));
check('пометки проступили на пути: павший, сгоревший, прорыв, у Босса — луна и жилец', state.all === 4 && state.on === 4, JSON.stringify(state));
check('новый этаж: номер 3, Летопись прошлой карты не перешла на новую', state.floor === 3 && state.fresh, JSON.stringify(state));
await f.shot('chronicle-3-marks');
await wait(2600);
await f.shot('chronicle-4-turn');
await phase('end');
await f.shot('chronicle-5-new');
for (let i = 0; i < 200 && await ev(() => !!document.querySelector('.gd-chronicle')); i++) await wait(250);
check('сцена закончилась сама и убрала за собой', await ev(() => !document.querySelector('.gd-chronicle')));

// ---------- Пропуск щелчком
await ev(async () => {
    const c = await gdt.mod('labyrinth/chronicle.js');
    const map = canvas.scene.getFlag('gachadnd', 'floorMap');
    c.playChronicle({ oldMap: { ...map, visitedNodes: [map.nodes[0].id] }, oldFloor: 3, newMap: map, newFloor: 4, marks: [] });
});
await wait(1200);
await page.mouse.click(400, 300);
await wait(900);
check('щелчок — сцена пропущена', await ev(() => !document.querySelector('.gd-chronicle')));

// ---------- Эффекты выключены — сцены нет
await ev(async () => {
    await game.settings.set('gachadnd', 'effects', 'off');
    await game.settings.set('gachadnd', 'impactSlow', 1);
    const c = await gdt.mod('labyrinth/chronicle.js');
    const map = canvas.scene.getFlag('gachadnd', 'floorMap');
    c.playChronicle({ oldMap: { ...map, visitedNodes: [map.nodes[0].id] }, oldFloor: 3, newMap: map, newFloor: 4, marks: [] });
});
await wait(500);
check('эффекты выключены — Летописи нет', await ev(() => !document.querySelector('.gd-chronicle')));

await ev(async s => {
    for (const [k, v] of Object.entries(s)) await game.settings.set('gachadnd', k, v);
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
    foundry.applications.instances.get('gachadnd-map-terminal')?.close();
}, saved);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
