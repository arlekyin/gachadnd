// Тетрис: node tools/stand/tetris.mjs
// Окно головоломки (сборка кликами, поворот R), использование навыка, силуэт на сцене, обрушение:
// блоки, выталкивание, цели; третья фигура осыпает первую; отмена возвращает заряд.
// Снимки out/tetris_<этап>.png
import { open } from './harness.mjs';

const stand = await open('tetris.html', { width: 1500, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);

// Решение головоломки перебором: положения деталей
const solve = () => page.evaluate(() => {
    const { canPlace, counts, isSolved } = puzzleLib;
    const app = foundry.applications.instances.get('gachadnd-tetris-A');
    const p = structuredClone(app.puzzle); p.placed = {};
    const rec = i => {
        if (i === p.pieces.length) return isSolved(p);
        const piece = p.pieces[i];
        for (let rot = 0; rot < 4; rot++) for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
            const at = { rot, x, y };
            if (!canPlace(p, piece, at)) continue;
            p.placed[piece.id] = at;
            const c = counts(p);
            if (c.rows.every((v, k) => v <= p.rows[k]) && c.cols.every((v, k) => v <= p.cols[k]) && rec(i + 1)) return true;
            delete p.placed[piece.id];
        }
        return false;
    };
    rec(0);
    return p.placed;
});

// 1. Навык без собранной фигуры: открывается окно, заряд цел
const used = await page.evaluate(() => useSkill());
await page.waitForSelector('.gd-tetris');
check(used === false && await page.evaluate(() => item.system.uses.spent) === 0, 'не собрано: навык открыл окно, заряд не потрачен');
await stand.shot('tetris_open');

// 2. Сборка кликами: деталь из лотка, R — поворот, клик по клетке под «ручкой» детали
const solution = await solve();
let first = true;
for (const [id, at] of Object.entries(solution)) {
    await page.click(`.gd-tetris-piece[data-piece="${id}"]`);
    for (let r = 0; r < at.rot; r++) await page.keyboard.press('KeyR');
    const cell = await page.evaluate(([id, at]) => {
        const { rotate } = puzzleLib;
        const app = foundry.applications.instances.get('gachadnd-tetris-A');
        const cells = rotate(app.puzzle.pieces.find(p => p.id === id).cells, at.rot);
        const cx = cells.reduce((s, c) => s + c[0], 0) / 4, cy = cells.reduce((s, c) => s + c[1], 0) / 4;
        const g = cells.reduce((b, c) => Math.hypot(c[0] - cx, c[1] - cy) < Math.hypot(b[0] - cx, b[1] - cy) ? c : b);
        return [at.x + g[0], at.y + g[1]];
    }, [id, at]);
    await page.hover(`.gd-tetris-cell[data-x="${cell[0]}"][data-y="${cell[1]}"]`);
    if (first) { await stand.shot('tetris_ghost'); first = false; }
    await page.click(`.gd-tetris-cell[data-x="${cell[0]}"][data-y="${cell[1]}"]`);
}
await page.waitForTimeout(400);
const solved = await page.evaluate(() => ({ cls: document.querySelector('.gd-tetris').classList.contains('solved'), flag: actor.flags.gachadnd.tetris.placed.every(Boolean) }));
check(solved.cls && solved.flag, 'собрано кликами, флаг персонажа сохранён');
await stand.shot('tetris_solved');

// Экранные координаты точки сцены
const screen = (x, y) => page.evaluate(([x, y]) => { const p = canvas.stage.toGlobal(new PIXI.Point(x, y)); return [p.x, p.y]; }, [x, y]);

// 3. Использование: силуэт, поворот R, обрушение на гоблина и огра
check(await page.evaluate(() => useSkill()) === true, 'собрано: навык использован, заряд потрачен');
let [sx, sy] = await screen(612, 362);
await page.mouse.move(sx, sy, { steps: 4 });
await page.waitForTimeout(200);
await stand.shot('tetris_preview');
await page.keyboard.press('KeyR');
await page.waitForTimeout(200);
await stand.shot('tetris_preview_rot');
await page.mouse.click(sx, sy);
await page.waitForTimeout(600);
let state = await page.evaluate(() => ({ tiles: canvas.scene.tiles.length, moved: window.moved, targets: window.targets, chat: window.chat, figures: Object.keys(canvas.scene.flags.gachadnd?.tetris ?? {}).length, fresh: !actor.flags.gachadnd.tetris.placed.some(Boolean) }));
console.log('  ', JSON.stringify(state));
check(state.tiles === 16 && state.figures === 1, '16 блоков, одна фигура');
check(state.fresh, 'после обрушения — новая головоломка');
await stand.shot('tetris_dropped');

// Блоки не пересекаются с токенами после выталкивания
const overlap = await page.evaluate(() => canvas.scene.tokens.some(t => canvas.scene.tiles.some(b => b.x < t.x + t.width * 50 && b.x + 50 > t.x && b.y < t.y + t.height * 50 && b.y + 50 > t.y)));
check(!overlap, 'никто не стоит в блоке');

// 4. Ещё две фигуры: третья осыпает первую
const inject = () => page.evaluate(async placed => {
    const app = foundry.applications.instances.get('gachadnd-tetris-A');
    app.puzzle.placed = placed;
    await actor.update({ 'flags.gachadnd.tetris': { ...app.puzzle, placed: app.puzzle.pieces.map(p => placed[p.id] ?? null) } });
}, null);
const firstFigure = await page.evaluate(() => Object.keys(canvas.scene.flags.gachadnd.tetris)[0]);
for (const [x, y] of [[300, 900], [600, 760]]) {
    await page.evaluate(() => foundry.applications.instances.get('gachadnd-tetris-A').reload());
    await page.waitForTimeout(100);
    const placed = await solve();
    await page.evaluate(async placed => {
        const app = foundry.applications.instances.get('gachadnd-tetris-A');
        await actor.update({ 'flags.gachadnd.tetris': { ...app.puzzle, placed: app.puzzle.pieces.map(p => placed[p.id] ?? null) } });
    }, placed);
    await page.evaluate(() => useSkill());
    [sx, sy] = await screen(x, y);
    await page.mouse.move(sx, sy, { steps: 3 });
    await page.mouse.click(sx, sy);
    await page.waitForTimeout(400);
}
state = await page.evaluate(id => ({ tiles: canvas.scene.tiles.length, figures: Object.keys(canvas.scene.flags.gachadnd?.tetris ?? {}).length, firstGone: !canvas.scene.flags.gachadnd.tetris[id] && !canvas.scene.tiles.some(t => t.flags.gachadnd.tetris === id), spent: item.system.uses.spent }), firstFigure);
check(state.tiles === 32 && state.figures === 2 && state.firstGone && state.spent === 3, `третья фигура осыпала первую: ${state.tiles} блоков, ${state.figures} фигуры`);
await stand.shot('tetris_three');

// 5. Отмена правой кнопкой возвращает заряд (зарядов уже нет — даём один)
await page.evaluate(() => { item.system.uses.spent = 0; });
const placed = await solve();
await page.evaluate(async placed => {
    const app = foundry.applications.instances.get('gachadnd-tetris-A');
    await actor.update({ 'flags.gachadnd.tetris': { ...app.puzzle, placed: app.puzzle.pieces.map(p => placed[p.id] ?? null) } });
}, placed);
await page.evaluate(() => useSkill());
await page.evaluate(() => canvas.app.view.oncontextmenu(new MouseEvent('contextmenu')));
await page.waitForTimeout(200);
check(await page.evaluate(() => item.system.uses.spent) === 0, 'отмена вернула заряд');

// 6. Конец боя: блоки убраны
await page.evaluate(() => Hooks.events.deleteCombat.forEach(fn => fn({ scene: canvas.scene })));
await page.waitForTimeout(200);
check(await page.evaluate(() => canvas.scene.tiles.length === 0 && !Object.keys(canvas.scene.flags.gachadnd?.tetris ?? {}).length), 'конец боя: блоки убраны');
await stand.close();
