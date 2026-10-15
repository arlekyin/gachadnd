// Кот Шрёдингера: node tools/stand/cat.mjs [--v13]
// Раздвоение, монетка при уроне (настоящий / пустышка, по цели и по вопросу), схлопывание
// действием и в начале хода. Персонаж 5,10, копия — в 7,10. Снимки out/cat_<этап>.png
import { open, args } from './harness.mjs';

const { v13 } = args();
const stand = await open(`cat.html${v13 ? '?v13' : ''}`, { width: 1500, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const cell = (j, i) => page.evaluate(([x, y]) => { const p = canvas.stage.toGlobal(new PIXI.Point(x, y)); return [p.x, p.y]; }, [j * 50 + 25, i * 50 + 25]);
const state = () => page.evaluate(() => {
    const caster = scene.tokens.get('caster');
    const copyId = caster.flags.gachadnd?.cat?.copyId;
    return { at: `${caster.x / 50},${caster.y / 50}`, alpha: caster.alpha, copy: copyId ? `${scene.tokens.get(copyId).x / 50},${scene.tokens.get(copyId).y / 50}` : null, copyId, hp: actor.system.attributes.hp.value, tokens: scene.tokens.length };
});
const split = async (shot) => {
    await page.evaluate(() => { item.system.uses.spent = 0; useSkill(); });
    const [x, y] = await cell(7, 10);
    await page.mouse.move(x, y, { steps: 3 });
    await page.waitForTimeout(120);
    if (shot) await stand.shot(shot);
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
};
// Монетка: Math.random подменяется только на время применения урона
const hit = (coinValue, amount, target) => page.evaluate(async ([coinValue, amount, target]) => {
    const pick = { copy: () => canvas.tokens.get(scene.tokens.get('caster').flags.gachadnd.cat.copyId), original: () => canvas.tokens.get('caster') };
    game.user.targets = new Set(target ? [pick[target]()] : []);
    const random = Math.random;
    Math.random = () => coinValue;
    try { await actor.applyDamage(amount); } finally { Math.random = random; }
}, [coinValue, amount, target]);
const settle = () => page.waitForTimeout(v13 ? 700 : 300);

// 1. Раздвоение
await split('cat_preview');
let s = await state();
check(s.copy === '7,10' && s.alpha === 0.6 && s.tokens === 6, `копия в ${s.copy}, оба полупрозрачны`);
await stand.shot('cat_split');

// 2. Урон по копии (цель), монетка «настоящий»: урон проходит, персонаж — на месте копии
await hit(0.3, 5, 'copy');
await settle();
s = await state();
check(s.hp === 15 && s.at === '7,10' && !s.copyId && s.tokens === 5 && s.alpha === 1, `настоящий: ПЗ ${s.hp}, персонаж в ${s.at}, копия убрана`);

// 3. Урон по исходному, «пустышка»: урон отменён, настоящий — копия
await page.evaluate(() => { scene.tokens.get('caster').update({ x: 250, y: 500 }); });
await settle();
await split();
await hit(0.7, 5, 'original');
await settle();
s = await state();
check(s.hp === 15 && s.at === '7,10' && !s.copyId, `пустышка: урон отменён (ПЗ ${s.hp}), персонаж в ${s.at}`);

// 4. Действие из копии: она настоящая
await page.evaluate(() => { scene.tokens.get('caster').update({ x: 250, y: 500 }); game.user.targets = new Set(); });
await settle();
await split();
await page.evaluate(() => {
    canvas.tokens.controlled = [canvas.tokens.get(scene.tokens.get('caster').flags.gachadnd.cat.copyId)];
    const other = { name: 'Меч', flags: {}, actor };
    Hooks.events['dnd5e.preUseActivity'].forEach(fn => fn({ item: other }));
    canvas.tokens.controlled = [];
});
await settle();
s = await state();
check(s.at === '7,10' && !s.copyId, `действие из копии: персонаж в ${s.at}`);

// 5. Начало хода: выбран исходный
await page.evaluate(() => { scene.tokens.get('caster').update({ x: 250, y: 500 }); });
await settle();
await split();
await page.evaluate(() => {
    window.DIALOG_ANSWER = 'original';
    const combat = { started: true, combatant: { actor } };
    Hooks.events.updateCombat.forEach(fn => fn(combat, { turn: 1 }));
});
await settle();
s = await state();
check(s.at === '5,10' && !s.copyId && s.tokens === 5, `начало хода: остался исходный в ${s.at}`);

// 6. Урон без цели: вопрос «по кому» (копия), «настоящий» — урон после ответа
await split();
await page.evaluate(() => { window.DIALOG_ANSWER = 'copy'; });
await hit(0.3, 4, null);
await settle();
s = await state();
check(s.hp === 11 && s.at === '7,10' && !s.copyId, `по вопросу: урон прошёл (ПЗ ${s.hp}), персонаж в ${s.at}`);
await stand.close();
