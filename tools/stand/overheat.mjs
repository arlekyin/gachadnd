// Перегрев: node tools/stand/overheat.mjs
// Подзарядка (выбор цели, заёмные заряды), первое заёмное использование без броска, кость d6 по уровню,
// сгорание и выдержка, цикл зарядчиков сам себя сжигает, неудаляемый навык — блок, отдых, Оверклокинг
// только по экипированному навыку без зарядов, свои заряды не греют.
import { open } from './harness.mjs';

const stand = await open('overheat.html', { width: 400, height: 300 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const run = fn => page.evaluate(fn);
const wait = (ms = 200) => page.waitForTimeout(ms);
const state = id => page.evaluate(id => { const i = actor.items.get(id); return i ? { spent: i.system.uses.spent, heat: heat.heatOf(i) } : null; }, id);
const use = async id => { await page.evaluate(id => actor.items.get(id).activity.use(), id); await wait(700); };

await run(() => {
    skill('R', 'Тетрис', 'red', 1);
    skill('P', 'Перезарядка', 'purple', 1, { recharger: { restore: 'all', target: 'memory' } });
    skill('O', 'Оверклокинг', 'blue', 1, { recharger: { restore: 1, target: 'equipped_empty' } });
    skill('G', 'Серый', 'gray', 2);
});

// 1. Свои заряды не греют
await use('R');
let r = await state('R');
check(r.spent === 1 && r.heat.extra === 0 && r.heat.borrowed === 0, 'свой заряд красного навыка — без перегрева');

// 2. Перезарядка: выбор цели, заряд восстановлен, он заёмный
await run(() => { window.TARGET = 'R'; });
await use('P');
await wait(300);
r = await state('R');
check(r.spent === 0 && r.heat.borrowed === 1 && (await state('P')).spent === 1, 'Перезарядка: цель выбрана, заряд вернулся заёмным, свой заряд Перезарядки потрачен');
check(await run(() => /без перегрева/.test(chats.at(-1))), 'карточка подзарядки: следующее использование без перегрева');

// 3. Первое заёмное использование — без броска
await use('R');
r = await state('R');
check(r.heat.extra === 1 && r.heat.borrowed === 0 && !(await run(() => chats.some(c => /Перегрев:/.test(c)))), 'первое заёмное использование — без броска');

// 4. Второе заёмное: уровень 1, кость 2 — выдержал
await run(() => heat.recharge(actor.items.get('R'), 'all'));
await run(() => { D6 = [2]; });
await use('R');
check(await run(() => /Уровень 1: сгорает на 1–1 \(17%\)\. Выпало 2 — выдержал/.test(chats.at(-1))) && (await state('R')).heat.extra === 2, 'второе заёмное: уровень 1, выпало 2 — выдержал');

// 5. Третье заёмное: уровень 2, кость 2 — сгорел
await run(() => heat.recharge(actor.items.get('R'), 'all'));
check(await run(() => heat.riskText(heat.nextRisk(actor.items.get('R')))) === 'перегрев 2: сгорает на 1–2 (33%)', 'риск следующего: перегрев 2, 33%');
await run(() => { D6 = [2]; });
await use('R');
check(!(await state('R')) && await run(() => /сгорел/.test(chats.at(-1))), 'третье заёмное: уровень 2, выпало 2 — навык сгорел');

// 6. Цикл зарядчиков: Перезарядка греется сама и сгорает
await run(() => { skill('Q', 'Вторая перезарядка', 'purple', 1, { recharger: { restore: 'all', target: 'memory' } }); actor.items.get('Q').system.uses.spent = 1; });
let rounds = 0;
await run(() => { D6 = [6, 6, 6, 1]; });
while (rounds < 8 && await state('P') && await state('Q')) {
    await run(() => { window.TARGET = 'P'; });
    await use('Q');
    if (!(await state('Q')) || !(await state('P'))) break;
    await run(() => { window.TARGET = 'Q'; });
    await use('P');
    rounds++;
}
check(!(await state('P')) || !(await state('Q')), `цикл двух Перезарядок сам себя сжёг за ${rounds} круга`);

// 7. Неудаляемый навык не сгорает, а блокируется
await run(() => { skill('U', 'Неудаляемый', 'red', 1, { undeletable: true }); });
await use('U');
for (let i = 0; i < 2; i++) { await run(() => heat.recharge(actor.items.get('U'), 'all')); await run(() => { D6 = [1]; }); await use('U'); }
check((await state('U'))?.heat.locked === true, 'неудаляемый навык при провале — заблокирован');
await run(() => heat.recharge(actor.items.get('U'), 'all'));
check(await run(() => actor.items.get('U').activity.use()) === null && await run(() => /заблокирован/.test(warnings.at(-1))), 'заблокированный навык не используется');

// 8. Отдых: короткий сжигает заём, долгий снимает перегрев и блок
await run(() => heat.recharge(actor.items.get('G'), 'all'));
await run(() => { skill('V', 'Фиолетовый', 'purple', 2); const v = actor.items.get('V'); v.system.uses.spent = 2; });
await run(() => heat.recharge(actor.items.get('V'), 1));
check((await state('V')).heat.borrowed === 1, 'фиолетовый: заёмный заряд');
await run(() => rest(false)); await wait();
check((await state('V')).heat.borrowed === 0, 'короткий отдых — незатраченный заём сгорел');
await run(() => rest(true)); await wait();
const u = await state('U');
check(!u.heat.locked && u.heat.extra === 0, 'долгий отдых — перегрев и блок сняты');
check((await state('G')).heat.borrowed === 0 && (await state('G')).heat.extra === 0, 'серый навык не греется');

// 9. Оверклокинг: только экипированный навык без зарядов
await run(() => { actor.items.get('O').system.uses.spent = 0; actor.items.get('V').system.uses.spent = 1; });
check(await run(() => actor.items.get('O').activity.use()) === null && await run(() => /нет экипированного навыка/.test(warnings.at(-1))), 'Оверклокинг: целей нет — заряд не тратится');
await run(() => { actor.items.get('V').system.uses.spent = 2; });
await use('O');
await wait(300);
check((await state('V')).spent === 1 && (await state('V')).heat.borrowed === 1 && (await state('O')).spent === 1, 'Оверклокинг: 1 заёмный заряд единственной цели, без окна выбора');
await stand.close();
