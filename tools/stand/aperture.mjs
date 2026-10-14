// Портал: node tools/stand/aperture.mjs
// Синий и оранжевый порталы, проход по направлению движения, занятый выход, замена старого
// портала, запрет на клетку с существом, уборка в конце боя. Снимки out/aperture_<этап>.png
// Поле (клетки): персонаж 5,10; гоблин 11,7; огр 12–13,5–6; союзник 9,8; бес 15,8.
import { open } from './harness.mjs';

const stand = await open('aperture.html', { width: 1500, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const cell = (j, i) => page.evaluate(([x, y]) => { const p = canvas.stage.toGlobal(new PIXI.Point(x, y)); return [p.x, p.y]; }, [j * 50 + 25, i * 50 + 25]);
const portals = () => page.evaluate(() => Object.fromEntries(scene.tiles.filter(t => t.flags.gachadnd.portal).map(t => [t.flags.gachadnd.portal.color, `${t.x / 50},${t.y / 50}`])));
const pos = id => page.evaluate(id => { const t = scene.tokens.get(id); return `${t.x / 50},${t.y / 50}`; }, id);
const move = (id, gx, gy) => page.evaluate(([id, gx, gy]) => scene.updateEmbeddedDocuments('Token', [{ _id: id, x: gx * 50, y: gy * 50 }]), [id, gx, gy]);
// Клик по клетке: button 'left' — синий, 'right' — оранжевый; use — сначала использовать навык
const shoot = async (j, i, { shot = null, button = 'left', use = true } = {}) => {
    if (use) await page.evaluate(() => useSkill());
    const [x, y] = await cell(j, i);
    await page.mouse.move(x, y, { steps: 3 });
    await page.waitForTimeout(120);
    if (shot) await stand.shot(shot);
    await page.mouse.click(x, y, { button });
    await page.waitForTimeout(300);
};

// 1. На существо нельзя
await shoot(11, 7);
check(Object.keys(await portals()).length === 0, 'на клетку гоблина портал не встал');
await page.keyboard.press('Escape');

// 2. Первое использование ставит оба: синий левой кнопкой, затем второй — оранжевый
await shoot(7, 10, { shot: 'aperture_preview' });
check(Object.keys(await portals()).length === 0, 'после первого клика порталы ещё не поставлены — ждёт второй');
await shoot(14, 12, { use: false, shot: 'aperture_preview_second' });
let p = await portals();
check(p.blue === '7,10' && p.orange === '14,12', `синий ${p.blue}, оранжевый ${p.orange}`);
await stand.shot('aperture_pair');

// 3. Гоблин 11,7 → в синий 7,10: шёл влево-вниз — выходит из оранжевого влево-вниз, в 13,13
await move('goblin', 7, 10);
await page.waitForTimeout(1100);
check(await pos('goblin') === '13,13', `гоблин вышел из оранжевого по ходу движения: ${await pos('goblin')}`);

// 4. Бес 15,8 → в оранжевый 14,12 (влево-вниз): выход 6,11 из синего
await move('imp', 14, 12);
await page.waitForTimeout(1100);
check(await pos('imp') === '6,11', `бес вышел из синего: ${await pos('imp')}`);

// 5. Выход занят: союзник 9,8 → в синий 7,10 (влево-вниз) — 13,13 занят гоблином, рядом свободная
await move('ally', 7, 10);
await page.waitForTimeout(1100);
const ally = await pos('ally');
const [ax, ay] = ally.split(',').map(Number);
check(ally !== '13,13' && Math.max(Math.abs(ax - 13), Math.abs(ay - 13)) === 1, `выход занят — союзник рядом: ${ally}`);
await stand.shot('aperture_through');

// 6. Порталы уже стоят: одно использование — один портал; правая кнопка — оранжевый
await shoot(3, 4, { button: 'right' });
p = await portals();
check(p.orange === '3,4' && p.blue === '7,10' && Object.keys(p).length === 2, `правой кнопкой переставлен оранжевый: ${p.orange}, синий на месте`);

// 7. Перенос — только когда доехал: сдвинули дальше до конца пути — переноса нет
await move('goblin', 7, 10);
await page.waitForTimeout(100);
await move('goblin', 8, 12);
await page.waitForTimeout(1100);
check(await pos('goblin') === '8,12', `ушёл с портала до прибытия — остался: ${await pos('goblin')}`);

// 8. Конец боя
await page.evaluate(() => Hooks.events.deleteCombat.forEach(fn => fn({ scene })));
await page.waitForTimeout(200);
check(Object.keys(await portals()).length === 0, 'конец боя: порталы убраны');
await stand.close();
