// Чумовая пятница: node tools/stand/freaky.mjs
// Доли ПЗ живых участников боя перемешиваются; мёртвый гоблин не участвует; полоски летят.
// Снимок out/freaky_flight.png
import { open } from './harness.mjs';

const stand = await open('freaky.html', { width: 1500, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const ratios = () => page.evaluate(() => Object.fromEntries(scene.tokens.map(t => {
    const hp = t.actor.system.attributes.hp;
    return [t.id, Math.round(hp.value / hp.max * 100)];
})));

const before = await ratios();
console.log('   до:', JSON.stringify(before));
check(await page.evaluate(() => useSkill()) === true, 'навык использован в бою');
// Снимок программным WebGL долгий — один, в середине полёта
await page.waitForTimeout(500);
await stand.shot('freaky_flight');
await page.waitForTimeout(1500);
const after = await ratios();
console.log('   после:', JSON.stringify(after));
const live = ids => ids.filter(id => before[id] > 0);
const ids = Object.keys(before);
check(after.goblin === 0, 'мёртвый гоблин не участвует');
check(JSON.stringify(live(ids).map(id => before[id]).sort()) === JSON.stringify(live(ids).map(id => after[id]).sort()), 'те же доли, перемешаны');
check(live(ids).some(id => before[id] !== after[id]), 'перестановка не тождественная');
check(/Чумовая пятница/.test(await page.evaluate(() => window.chat)), 'итог в чате');
check(await page.evaluate(() => canvas.controls.children.length === 0), 'полоски убраны');

// Вне боя — отказ
await page.evaluate(() => { game.combat.started = false; item.system.uses.spent = 0; });
check(await page.evaluate(() => useSkill()) === false, 'вне боя навык не срабатывает');
await stand.close();
