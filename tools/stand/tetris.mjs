// Тетрис: node tools/stand/tetris.mjs
// Панель «Следующая / Запас», обмен, использование навыка, силуэт на сцене, обрушение, выталкивание,
// линия из блоков (сгорает, соседи — цели), отмена возвращает заряд, уборка в конце боя.
// Снимки out/tetris_<этап>.png
import { open } from './harness.mjs';

const stand = await open('tetris.html', { width: 1500, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const screen = (x, y) => page.evaluate(([x, y]) => { const p = canvas.stage.toGlobal(new PIXI.Point(x, y)); return [p.x, p.y]; }, [x, y]);
// Центр клетки сцены (столбец, строка)
const cell = (j, i) => screen(j * 50 + 25, i * 50 + 25);
const setQueue = (next, hold = null) => page.evaluate(([next, hold]) => { actor.flags.gachadnd.tetris = { next, hold, bag: ['T', 'S', 'Z'] }; }, [next, hold]);
const drop = async (j, i, rotations = 0, shot = null) => {
    await page.evaluate(() => useSkill());
    await page.waitForSelector('.gd-tetris');
    const [x, y] = await cell(j, i);
    await page.mouse.move(x, y, { steps: 3 });
    for (let r = 0; r < rotations; r++) await page.keyboard.press('KeyR');
    await page.waitForTimeout(150);
    if (shot) await stand.shot(shot);
    await page.mouse.click(x, y);
    await page.waitForTimeout(500);
};

// 1. Панель и обмен «Следующая» ↔ «Запас»
await page.evaluate(() => { actor.flags.gachadnd = {}; });
await page.evaluate(() => tetris.openTetris(actor));
await page.waitForSelector('.gd-tetris');
const q0 = await page.evaluate(() => structuredClone(actor.flags.gachadnd.tetris));
await page.click('[data-swap]');
await page.waitForTimeout(200);
const q1 = await page.evaluate(() => structuredClone(actor.flags.gachadnd.tetris));
check(q0.next && !q0.hold && q1.hold === q0.next && q1.next && q1.next !== q0.next, `обмен в пустой запас: ${q0.next} → запас, следующая ${q1.next}`);
await page.click('[data-swap]');
await page.waitForTimeout(200);
const q2 = await page.evaluate(() => structuredClone(actor.flags.gachadnd.tetris));
check(q2.next === q1.hold && q2.hold === q1.next, 'повторный обмен меняет местами');
await stand.shot('tetris_panel');

// 2. I горизонтально в строку 6, столбцы 8–11
await setQueue('I', 'O');
await page.evaluate(() => foundry.applications.instances.get('gachadnd-tetris-A').render());
await drop(9, 6, 0, 'tetris_preview');
console.log('   после I:', await page.evaluate(() => canvas.scene.tiles.map(t => `${t.x / 50},${t.y / 50}`).join(' ') + ' | ' + JSON.stringify(window.moved ?? [])));
let state = await page.evaluate(() => ({ tiles: canvas.scene.tiles.length, next: actor.flags.gachadnd.tetris.next, spent: item.system.uses.spent }));
check(state.tiles === 4 && state.next === 'T' && state.spent === 1, `I обрушена: ${state.tiles} блока, следующая из мешка ${state.next}`);

// 3. O в столбцы 12–13, строки 6–7: строка 6 — шесть блоков подряд, линия; огр под O выталкивается
await setQueue('O');
await drop(12, 6, 0, 'tetris_preview_line');
state = await page.evaluate(() => ({ tiles: canvas.scene.tiles.map(t => `${t.x / 50},${t.y / 50}`).sort(), moved: window.moved, targets: window.targets, chat: window.chat }));
console.log('  ', JSON.stringify(state));
check(state.tiles.length === 2 && state.tiles.includes('12,7') && state.tiles.includes('13,7'), 'линия сгорела: остались два нижних блока O');
check(state.moved?.some(m => m._id === 'ogre'), 'огра под O вытолкнуло');
check(state.targets?.includes('goblin'), 'гоблин рядом с линией — цель');
check(/Линия/.test(state.chat), 'в чате — линия');
await page.waitForTimeout(100);
await stand.shot('tetris_line');
const overlap = await page.evaluate(() => canvas.scene.tokens.some(t => canvas.scene.tiles.some(b => b.x < t.x + t.width * 50 && b.x + 50 > t.x && b.y < t.y + t.height * 50 && b.y + 50 > t.y)));
check(!overlap, 'никто не стоит в блоке');

// 4. Вертикальная линия: I вертикально в столбце 2 (строки 8–11) и O под ней — столбец из шести
await setQueue('I');
await drop(2, 9, 1);
await setQueue('O');
await drop(2, 12, 0);
state = await page.evaluate(() => canvas.scene.tiles.map(t => `${t.x / 50},${t.y / 50}`).sort());
check(!state.some(k => k.startsWith('2,')) && state.includes('3,12') && state.includes('3,13'), `вертикальная линия сгорела, у O остался правый столбец: ${state.join(' ')}`);

// 5. Отмена правой кнопкой возвращает заряд
await page.evaluate(() => { item.system.uses.spent = 0; });
await page.evaluate(() => useSkill());
await page.evaluate(() => canvas.app.view.oncontextmenu(new MouseEvent('contextmenu')));
await page.waitForTimeout(200);
check(await page.evaluate(() => item.system.uses.spent) === 0, 'отмена вернула заряд');

// 6. Конец боя: блоки убраны
await page.evaluate(() => Hooks.events.deleteCombat.forEach(fn => fn({ scene: canvas.scene })));
await page.waitForTimeout(200);
check(await page.evaluate(() => canvas.scene.tiles.length === 0), 'конец боя: блоки убраны');
await stand.close();
