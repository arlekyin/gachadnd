// Fez: node tools/stand/fez.mjs [--v13]
// Призраки поворота, смена направления, стена не пускает, цепочка (e2 встаёт на место e1),
// поворот карты и вспышка, перестановка у Мастера, отмена возвращает заряд.
// Поле (клетки): персонаж 10,8; e1 12,8; e2 10,6; e3 8,9; e4 13,12; far 18,3; стена над e3.
// Снимки out/fez_<этап>.png
import { open, args } from './harness.mjs';

// --v13 — механизм движения Foundry v13 (TokenDocument#move)
const { v13 } = args();
const stand = await open(`fez.html${v13 ? '?v13' : ''}`, { width: 1500, height: 900 });
if (v13) console.log('  движение v13');
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const pos = id => page.evaluate(id => { const t = scene.tokens.get(id); return `${t.x / 50},${t.y / 50}`; }, id);

// 1. Призраки по часовой, затем против (R) и обратно
await page.evaluate(() => useSkill());
await page.waitForTimeout(150);
await stand.shot('fez_preview_cw');
await page.keyboard.press('KeyR');
await page.waitForTimeout(100);
await stand.shot('fez_preview_ccw');
await page.keyboard.press('KeyR');

// 2. Отмена возвращает заряд
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check(await page.evaluate(() => item.system.uses.spent) === 0, 'отмена вернула заряд');

// 3. Поворот по часовой: снимки во время поворота карты и во вспышке
await page.evaluate(() => useSkill());
await page.waitForTimeout(100);
const [x, y] = await page.evaluate(() => { const p = canvas.stage.toGlobal(new PIXI.Point(700, 700)); return [p.x, p.y]; });
await page.mouse.click(x, y);
await page.waitForTimeout(450);
await stand.shot('fez_spin');
await page.waitForTimeout(1200);
const rot = await page.evaluate(() => canvas.stage.rotation);
check(Math.abs(rot) < 1e-6, `карта вернулась без поворота (${rot.toFixed(3)})`);
const after = { e1: await pos('e1'), e2: await pos('e2'), e3: await pos('e3'), e4: await pos('e4'), far: await pos('far') };
console.log('  ', JSON.stringify(after));
check(after.e1 === '10,10' && after.e2 === '12,8', 'e1 и e2 повернулись, e2 встал на место e1');
check(after.e3 === '8,9', 'стена не пустила e3');
check(after.e4 === '6,11', 'e4 на краю дальности повернулся');
check(after.far === '18,3', 'далёкий не тронут');
if (v13) check(await page.evaluate(() => window.moves?.length === 3 && window.moves.every(m => m.action === 'displace')), 'v13: поворот — перемещения displace');
check(/Fez/.test(await page.evaluate(() => window.chat)), 'в чате — Fez');
check(await page.evaluate(() => !document.querySelector('.gd-fez-flash')), 'вспышка убрана');
await stand.shot('fez_after');
await stand.close();
