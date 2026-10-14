// «Сыграем... в гвинт?»: node tools/stand/gwent.mjs [--v13]
// Колода на бой и добор до трёх, панель руки, одна карта за ход, все карты: Казнь, Мороз,
// Туман, Ясное небо, Рог, Чучело, Шпион, Медик, Ведьмак. Снимок out/gwent_panel.png
// Поле (клетки): персонаж 5,10; гоблин 11,7 (25 ПЗ); огр 12–13,5–6; союзник 9,8 (20 ПЗ); бес 15,8.
import { open, args } from './harness.mjs';

const { v13 } = args();
const stand = await open(`gwent.html${v13 ? '?v13' : ''}`, { width: 1500, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const state = () => page.evaluate(() => structuredClone(actor.flags.gachadnd.gwent));
const cell = (j, i) => page.evaluate(([x, y]) => { const p = canvas.stage.toGlobal(new PIXI.Point(x, y)); return [p.x, p.y]; }, [j * 50 + 25, i * 50 + 25]);
const hand = cards => page.evaluate(cards => { actor.flags.gachadnd.gwent.hand = cards; return foundry.applications.instances.get('gachadnd-gwent-A').render(); }, cards);
let round = 1;
const next = async () => { round++; await page.evaluate(r => turn(r, 0), round); await page.waitForTimeout(100); };
const click = async (index, target) => {
    await page.click(`.gd-gwent-card[data-index="${index}"]`);
    if (target) {
        const [x, y] = await cell(...target);
        await page.mouse.move(x, y, { steps: 3 });
        await page.waitForTimeout(100);
        await page.mouse.click(x, y);
    }
    await page.waitForTimeout(400);
};
const pos = id => page.evaluate(id => { const t = scene.tokens.get(id); return `${t.x / 50},${t.y / 50}`; }, id);
const effects = id => page.evaluate(id => scene.tokens.get(id).actor.effects.map(e => e.name), id);

// 1. Начало боя: колода 12, рука 3
await page.evaluate(() => turn(1, 0));
let s = await state();
check(s.hand.length === 3 && s.deck.length === 9 && s.discard.length === 0, `колода на бой: рука ${s.hand.length}, колода ${s.deck.length}`);
// Использование навыка открывает панель и отменяет обычное использование; навык без флага — по имени
check(await page.evaluate(() => useSkill()) === false, 'использование навыка отменено');
await page.waitForSelector('.gd-gwent-card');
check(await page.evaluate(() => {
    foundry.applications.instances.get('gachadnd-gwent-A').close?.();
    foundry.applications.instances.delete?.('gachadnd-gwent-A');
    const flags = item.flags.gachadnd, saved = flags.gwent;
    delete flags.gwent;
    flags.skill_name = 'Сыграем... в гвинт?';
    const ok = useSkill() === false;
    flags.gwent = saved;
    return ok;
}), 'навык без флага узнан по имени');
await page.waitForSelector('.gd-gwent-card');
await hand(['scorch', 'horn', 'frost']);
await stand.shot('gwent_panel');

// 2. Казнь: сильнейший в 30 футах — гоблин (25 ПЗ)
await click(0);
check(await page.evaluate(() => scene.tokens.get('goblin').actor.system.attributes.hp.value) === 18, 'Казнь: гоблин получил 7');
s = await state();
check(s.discard.includes('scorch') && s.hand.length === 2, 'карта ушла в сброс');

// 3. Вторая карта в тот же ход — нельзя
await click(0);
check((await state()).hand.length === 2, 'вторая карта в тот же ход — отказ');

// 4. Следующий ход: добор до трёх; Мороз у гоблина
await next();
s = await state();
check(s.hand.length === 3, `добор до трёх: ${s.hand.join(', ')}`);
await hand(['frost', ...s.hand.slice(1)]);
await click(0, [10, 8]);
check(await page.evaluate(() => scene.templates.length) === 1 && (await effects('goblin')).some(n => /мороз/i.test(n)) && !(await effects('ally')).some(n => /мороз/i.test(n)), 'Мороз: зона, гоблин замедлен, союзник — нет');

// 5. Туман, Ясное небо
await next(); await hand(['fog', 'clear', 'horn']);
await click(0, [8, 12]);
check(await page.evaluate(() => scene.templates.length) === 2, 'Туман: вторая зона');
await next(); await hand(['clear', 'horn', 'decoy']);
await click(0);
check(await page.evaluate(() => scene.templates.length) === 0, 'Ясное небо: зоны сняты');

// 6. Рог союзнику
await next(); await hand(['horn', 'decoy', 'spy']);
await click(0, [9, 8]);
check((await effects('ally')).some(n => /рог/i.test(n)), 'Рог: эффект на союзнике');

// 7. Чучело: обмен местами
await next(); await hand(['decoy', 'spy', 'medic']);
await click(0, [9, 8]);
await page.waitForTimeout(v13 ? 500 : 100);
check(await pos('caster') === '9,8' && await pos('ally') === '5,10', 'Чучело: персонаж и союзник поменялись местами');

// 8. Шпион: +2 карты и метка
await next(); await hand(['spy', 'medic', 'witcher']);
await click(0);
s = await state();
check(s.hand.length === 4 && (await effects('caster')).some(n => /Шпион/.test(n)), `Шпион: рука ${s.hand.length}, метка на персонаже`);

// 9. Медик: вернуть Казнь
await next(); await hand(['medic', 'witcher']);
await page.evaluate(() => { window.DIALOG_ANSWER = null; foundry.applications.api.DialogV2.prompt = async () => 'scorch'; });
await click(0);
s = await state();
check(s.hand.includes('scorch'), 'Медик: Казнь вернулась в руку');

// 10. Ведьмак: эффект до конца хода
await next(); await hand(['witcher']);
await click(0);
const had = (await effects('caster')).some(n => /Ведьмак/.test(n));
await page.evaluate(r => turn(r, 1), round);
check(had && !(await effects('caster')).some(n => /Ведьмак/.test(n)), 'Ведьмак: +2d6 до конца хода, затем снят');
await stand.close();
