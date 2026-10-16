// Перегрев в настоящей Foundry: node tools/foundry/overheat.mjs [--headed] [--slow[=мс]]
// Трата заряда активностью dnd5e ловится в preUpdateItem, повторный activity.use() после выбора цели
// у Перезарядки и Оверклокинга (цена 2d6 ПЗ), к100 по шансу уровня, сгорание и блок, сброс на отдыхе.
import { connect, checker, done } from './harness.mjs';
import { install, scene, skills } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const wait = ms => page.waitForTimeout(ms);
// После смены хода — ожидание тишины: хуки модуля у Мастера дописывают своё (fixtures: gdt.settle)
const settle = () => page.evaluate(() => gdt.settle());

await install(page);
const ids = await scene(page);
const hero = ids.hero;
const S = await skills(page, hero, ['Китти Прайд', 'Перезарядка', 'Оверклокинг', 'Давай по новой Миша, всё хуйня']);
const KITTY = S['Китти Прайд'], RECHARGE = S['Перезарядка'], OVER = S['Оверклокинг'], GRAY = S['Давай по новой Миша, всё хуйня'];

const state = id => page.evaluate(({ hero, id }) => {
    const item = game.actors.get(hero).items.get(id);
    if (!item) return null;
    const h = item.flags.gachadnd?.heat ?? {};
    return { spent: item.system.uses.spent, max: item.system.uses.max, borrowed: h.borrowed ?? 0, extra: h.extra ?? 0, locked: !!h.locked };
}, { hero, id });
const hp = () => page.evaluate(hero => game.actors.get(hero).system.attributes.hp.value, hero);

/**
 * Использовать навык так же, как кнопка на листе: activity.use() без настроек.
 * Окна, открывшиеся по ходу (выбор цели, окно использования dnd5e), закрываются ответом answer.
 */
async function use(id, { target = null, timeout = 6000 } = {}) {
    const before = await page.evaluate(() => gdt.windows().map(w => w.id));
    let finished = false;
    const result = page.evaluate(async ({ hero, id }) => {
        const item = game.actors.get(hero).items.get(id);
        const r = await item.system.activities.contents[0].use();
        return r === undefined ? 'undefined' : r === null ? 'null' : r === false ? 'false' : 'object';
    }, { hero, id }).finally(() => { finished = true; });
    const seen = [];
    let lastWindow = Date.now();
    const end = Date.now() + timeout;
    // Окна закрываются по мере появления; конец — use() вернулся, 700 мс нет новых окон и прошло
    // не меньше 1,2 с: окно выбора цели (Перезарядка, Батарея) открывается уже после возврата use()
    const start = Date.now();
    let quiet = 700;
    while (Date.now() < end && !(finished && Date.now() - lastWindow >= quiet && Date.now() - start >= 1200)) {
        const opened = await page.evaluate(b => gdt.windows().filter(w => !b.includes(w.id)), before);
        for (const w of opened) {
            if (seen.some(s => s.id === w.id)) continue;
            seen.push(w);
            lastWindow = Date.now();
            const sel = `#${w.id}`;
            if (await page.$(`${sel} select[name="target"]`)) {
                quiet = 1500;
                if (target) await page.selectOption(`${sel} select[name="target"]`, target);
                await page.click(`${sel} button[data-action="ok"]`);
            } else if (await page.$(`${sel} button[data-action="use"]`)) {
                await page.click(`${sel} button[data-action="use"]`);
            }
        }
        await page.waitForTimeout(100);
    }
    const r = await result;
    // Бросок перегрева идёт после использования — ждём, пока документы затихнут
    await page.evaluate(() => gdt.settle(700));
    return { result: r, windows: seen.map(w => `${w.cls}: ${w.title}`) };
}

// 1. Свои заряды не греют
let u = await use(KITTY);
let k = await state(KITTY);
console.log('   окна:', u.windows.join('; ') || 'нет', '| use() →', u.result);
check('свой заряд фиолетового навыка — без перегрева', k.spent === 1 && k.extra === 0 && k.borrowed === 0, JSON.stringify(k));

// 2. Перезарядка: выбор цели, заряд вернулся заёмным, заряд Перезарядки потрачен
await page.evaluate(() => gdt.mark());
u = await use(RECHARGE, { target: KITTY, timeout: 3000 });
console.log('   окна:', u.windows.join('; ') || 'нет', '| use() →', u.result);
k = await state(KITTY);
let r = await state(RECHARGE);
check('Перезарядка: окно выбора цели', u.windows.some(w => /Перезарядка/.test(w)), u.windows.join('; '));
check('Перезарядка: заряд цели вернулся заёмным', k.spent === 0 && k.borrowed === 1, JSON.stringify(k));
check('Перезарядка: свой заряд потрачен один раз', r.spent === 1, JSON.stringify(r));
let chats = await page.evaluate(() => gdt.chats());
check('карточка подзарядки: «без перегрева»', chats.some(c => /Перезарядка → Китти Прайд/.test(c) && /без перегрева/.test(c)), chats.length + ' сообщений');

// 3. Первое заёмное использование — без броска
await page.evaluate(() => gdt.mark());
u = await use(KITTY);
k = await state(KITTY);
chats = await page.evaluate(() => gdt.chats());
check('первое заёмное использование — без броска', k.spent === 1 && k.extra === 1 && k.borrowed === 0 && !chats.some(c => /Перегрев:/.test(c)), JSON.stringify(k));

// 4. Второе заёмное: уровень 1 (17%), к100 = 18 — выдержал
const recharge = (id, restore = 'all') => page.evaluate(async ({ hero, id, restore }) => {
    const heat = await gdt.mod('memory/overheat.js');
    return heat.recharge(game.actors.get(hero).items.get(id), restore);
}, { hero, id, restore });
await recharge(KITTY);
await page.evaluate(() => { gdt.mark(); gdt.dice(100, 18); });
await use(KITTY, { timeout: 2500 });
chats = await page.evaluate(() => gdt.chats());
check('второе заёмное: уровень 1, 17%, выпало 18 — выдержал', chats.some(c => /Уровень 1: 17% — сгорает на 1–17\. Выпало 18 — выдержал/.test(c)) && (await state(KITTY))?.extra === 2, chats.filter(c => /Перегрев/.test(c)).join(' | ').replace(/<[^>]+>/g, ' ').slice(0, 300));

// 5. Третье заёмное: уровень 2 (33%), выпало 33 — сгорел
await recharge(KITTY);
const risk = await page.evaluate(async ({ hero, id }) => { const h = await gdt.mod('memory/overheat.js'); return h.riskText(h.nextRisk(game.actors.get(hero).items.get(id))); }, { hero, id: KITTY });
check('риск следующего: перегрев 2, 33%', risk === 'перегрев 2: 33% (сгорает на 1–33 к100)', risk);
await page.evaluate(() => { gdt.mark(); gdt.dice(100, 33); });
await use(KITTY, { timeout: 2500 });
chats = await page.evaluate(() => gdt.chats());
check('третье заёмное: выпало 33 — навык сгорел и удалён', !(await state(KITTY)) && chats.some(c => /Выпало 33 — сгорел/.test(c)), chats.filter(c => /Перегрев/.test(c)).join(' | ').replace(/<[^>]+>/g, ' ').slice(0, 300));

// 6. Неудаляемый навык не сгорает, а блокируется; заблокированный не используется
if (await state(KITTY)) await page.evaluate(({ hero, id }) => game.actors.get(hero).items.get(id).delete(), { hero, id: KITTY });
const U = (await skills(page, hero, ['Китти Прайд']))['Китти Прайд'];
await page.evaluate(({ hero, id }) => game.actors.get(hero).items.get(id).setFlag('gachadnd', 'undeletable', true), { hero, id: U });
await use(U);
for (let i = 0; i < 2; i++) { await recharge(U); await page.evaluate(() => gdt.dice(100, 1)); await use(U, { timeout: 2500 }); }
let s = await state(U);
check('неудаляемый навык при сгорании — заблокирован', s?.locked === true, JSON.stringify(s));
await recharge(U);
await page.evaluate(() => { gdt.warnings.length = 0; });
u = await use(U);
s = await state(U);
const warned = await page.evaluate(() => gdt.warnings.some(w => /заблокирован/.test(w)));
check('заблокированный навык не используется', warned && s.spent === 0, `${JSON.stringify(s)} warn=${warned}`);

// 7. Оверклокинг: без целей — отказ без траты; с целью — 1 заёмный заряд, без окна, цена 2d6 ПЗ
await page.evaluate(() => { gdt.warnings.length = 0; });
// Цель — экипированный навык без зарядов: Перезарядка (её заряд потрачен в шаге 2)
const noTarget = await page.evaluate(async ({ hero, over, rech }) => {
    const a = game.actors.get(hero);
    // Сначала целей нет: вернём Перезарядке заряд
    await a.items.get(rech).update({ 'system.uses.spent': 0 }, { gachadndRecharge: true });
    return a.items.get(over).system.activities.contents[0].use();
}, { hero, over: OVER, rech: RECHARGE });
await wait(500);
check('Оверклокинг без целей: отказ, заряд не потрачен', (await state(OVER)).spent === 0 && await page.evaluate(() => gdt.warnings.some(w => /нет экипированного навыка/.test(w))), String(noTarget));
await page.evaluate(({ hero, rech }) => game.actors.get(hero).items.get(rech).update({ 'system.uses.spent': 1 }, { gachadndRecharge: true }), { hero, rech: RECHARGE });
const hp0 = await hp();
await page.evaluate(() => gdt.mark());
u = await use(OVER, { timeout: 3000 });
console.log('   окна:', u.windows.join('; ') || 'нет', '| use() →', u.result);
r = await state(RECHARGE);
const o = await state(OVER);
const hp1 = await hp();
check('Оверклокинг: окна выбора нет (одна цель)', !u.windows.some(w => /^DialogV2/.test(w)), u.windows.join('; '));
check('Оверклокинг: 1 заёмный заряд Перезарядке', r.spent === 0 && r.borrowed === 1, JSON.stringify(r));
check('Оверклокинг: свой заряд потрачен', o.spent === 1, JSON.stringify(o));
check('Оверклокинг: цена 2d6 ПЗ списана один раз', hp0 - hp1 >= 2 && hp0 - hp1 <= 12, `${hp0} → ${hp1}`);

// 8. Отдых: короткий сжигает незатраченный заём, долгий снимает перегрев и блок
await page.evaluate(hero => game.actors.get(hero).shortRest({ dialog: false, chat: false }), hero);
await wait(800);
r = await state(RECHARGE);
check('короткий отдых — незатраченный заём сгорел', r.borrowed === 0, JSON.stringify(r));
await page.evaluate(hero => game.actors.get(hero).longRest({ dialog: false, chat: false, newDay: true }), hero);
await wait(800);
s = await state(U);
check('долгий отдых — перегрев и блок сняты', s && !s.locked && s.extra === 0 && s.borrowed === 0, JSON.stringify(s));
const g = await state(GRAY);
check('серый навык не греется', g.borrowed === 0 && g.extra === 0, JSON.stringify(g));

await page.evaluate(() => gdt.resetDice());
await f.shot('overheat');
const errors = f.log.filter(l => /pageerror|error:.*gachadnd|Перегрев|Подзарядка/.test(l));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
