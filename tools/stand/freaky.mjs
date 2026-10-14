// Чумовая пятница: node tools/stand/freaky.mjs [--v13]
// Живые участники боя меняются местами внутри своего размера; мёртвый гоблин и единственный
// 2×2 огр — на месте; токены летят дугами. Снимок out/freaky_flight.png
import { open, args } from './harness.mjs';

const { v13 } = args();
const stand = await open(`freaky.html${v13 ? '?v13' : ''}`, { width: 1500, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const spots = () => page.evaluate(() => Object.fromEntries(scene.tokens.map(t => [t.id, `${t.x / 50},${t.y / 50}`])));

const before = await spots();
console.log('   до:', JSON.stringify(before));
check(await page.evaluate(() => useSkill()) === true, 'навык использован в бою');
// Снимок программным WebGL долгий — один, в середине полёта
await page.waitForTimeout(550);
await stand.shot('freaky_flight');
await page.waitForTimeout(1800);
const after = await spots();
console.log('   после:', JSON.stringify(after));
const small = ['caster', 'ally', 'imp'];
check(after.goblin === before.goblin, 'мёртвый гоблин не участвует');
check(after.ogre === before.ogre, 'огр 2×2 — единственный своего размера, на месте');
check(JSON.stringify(small.map(id => before[id]).sort()) === JSON.stringify(small.map(id => after[id]).sort()), 'те же места, перемешаны');
check(small.some(id => before[id] !== after[id]), 'перестановка не тождественная');
check(/Чумовая пятница/.test(await page.evaluate(() => window.chat)), 'итог в чате');
check(await page.evaluate(() => canvas.controls.children.length === 0 && Object.values(toks).every(t => t.renderable !== false)), 'летящие картинки убраны, токены видны');
if (v13) check(await page.evaluate(() => (window.moves ?? []).every(m => m.action === 'displace')), 'v13: перестановка — displace');

// Вне боя — отказ
await page.evaluate(() => { game.combat.started = false; item.system.uses.spent = 0; });
check(await page.evaluate(() => useSkill()) === false, 'вне боя навык не срабатывает');
await stand.close();
