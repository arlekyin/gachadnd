// Тетрис: node tools/stand/tetris.mjs
// Панель «Следующая / Запас», обмен, силуэт на сцене, запрет класть на существо, детонация группы
// (два врага — взрыв, враг и союзник — нет, старые блоки связывают), отмена, уборка в конце боя.
// Поле (клетки): персонаж 5,10; гоблин 11,7; огр 12–13,5–6; союзник 9,8; бес 15,8.
// Снимки out/tetris_<этап>.png
import { open } from './harness.mjs';

const stand = await open('tetris.html', { width: 1500, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const screen = (x, y) => page.evaluate(([x, y]) => { const p = canvas.stage.toGlobal(new PIXI.Point(x, y)); return [p.x, p.y]; }, [x, y]);
const cell = (j, i) => screen(j * 50 + 25, i * 50 + 25);
const setQueue = next => page.evaluate(next => { actor.flags.gachadnd.tetris = { next, hold: null, bag: ['T', 'S', 'Z'] }; item.system.uses.spent = 0; window.targets = null; }, next);
const tiles = () => page.evaluate(() => canvas.scene.tiles.map(t => `${t.x / 50},${t.y / 50}`).sort());
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

// 1. Панель и обмен
await page.evaluate(() => { actor.flags.gachadnd = {}; });
await page.evaluate(() => tetris.openTetris(actor));
await page.waitForSelector('.gd-tetris');
const q0 = await page.evaluate(() => structuredClone(actor.flags.gachadnd.tetris));
await page.click('[data-swap]');
await page.waitForTimeout(200);
const q1 = await page.evaluate(() => structuredClone(actor.flags.gachadnd.tetris));
check(q1.hold === q0.next && q1.next && q1.next !== q0.next, `обмен в пустой запас: ${q0.next} → запас, следующая ${q1.next}`);
await stand.shot('tetris_panel');

// 2. На существо класть нельзя: O на гоблина — отказ, затем Esc
await setQueue('O');
await drop(11, 7);
check((await tiles()).length === 0, 'на гоблина фигура не легла');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check(await page.evaluate(() => item.system.uses.spent) === 0, 'Esc отменил, заряд вернулся');

// 3. I вертикально в столбце 12 (строки 7–10): касается гоблина и огра — детонация
await setQueue('I');
await drop(12, 8, 1, 'tetris_preview_blast');
let state = await page.evaluate(() => ({ targets: window.targets, chat: window.chat }));
check((await tiles()).length === 0 && state.targets?.includes('goblin') && state.targets?.includes('ogre'), `два врага в группе — детонация, блоки исчезли, цели: ${state.targets}`);
await page.waitForTimeout(80);
await stand.shot('tetris_blast');

// 4. O у беса (16–17, 8–9): один враг — без взрыва
await setQueue('O');
await drop(16, 8);
state = await page.evaluate(() => ({ targets: window.targets, chat: window.chat }));
check((await tiles()).length === 4 && !state.targets && /нужен ещё/.test(state.chat), 'один враг — блоки стоят, взрыва нет');

// 5. O между союзником и гоблином (10–11, 8–9): враг и союзник — без взрыва
await setQueue('O');
await drop(10, 8, 0, 'tetris_preview_ally');
check((await tiles()).length === 8 && !(await page.evaluate(() => window.targets)), 'враг и союзник — взрыва нет');

// 6. I горизонтально в строке 9 (12–15) связывает обе O: гоблин и бес через старые блоки — детонация
await setQueue('I');
await drop(13, 9, 0, 'tetris_preview_combo');
state = await page.evaluate(() => ({ targets: window.targets }));
check((await tiles()).length === 0 && state.targets?.length === 2 && state.targets.includes('goblin') && state.targets.includes('imp') && !state.targets.includes('ally'),
    `старые блоки связали группу: цели ${state.targets}, союзник не задет, все 12 блоков сгорели`);
await page.waitForTimeout(80);
await stand.shot('tetris_combo');

// 7. Конец боя: блоки убраны
await setQueue('O');
await drop(3, 12);
await page.evaluate(() => Hooks.events.deleteCombat.forEach(fn => fn({ scene: canvas.scene })));
await page.waitForTimeout(200);
check((await tiles()).length === 0, 'конец боя: блоки убраны');
await stand.close();
