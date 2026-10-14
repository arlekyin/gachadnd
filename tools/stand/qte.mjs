// QTE: node tools/stand/qte.mjs
// Атака мимо — QTE нет; попадание — стрелки на экране: успел (промах после помехи — урона нет,
// попала и так — урон вдвое меньше), ошибся, не успел; заряды. Снимок out/qte.png
import { open } from './harness.mjs';

const stand = await open('qte.html', { width: 1200, height: 800 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const hp = () => page.evaluate(() => actor.system.attributes.hp.value);
const sequence = () => page.evaluate(() => [...document.querySelectorAll('.gd-qte:not(.win):not(.fail) .gd-qte-key')].map(b => b.dataset.key));
const pressAll = async keys => { for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(60); } };
const damage = amount => page.evaluate(amount => actor.applyDamage(amount), amount);
const reset = () => page.evaluate(() => { item.system.uses.spent = 0; actor.system.attributes.hp.value = 30; window.chat = ''; });

// 1. Атака мимо КД — QTE не появляется
await page.evaluate(() => attack(5, 9));
await page.waitForTimeout(150);
check(!(await page.$('.gd-qte')), 'промах — QTE нет');

// 2. Попала; успел; второй d20 = 2 — промах, урона нет
await page.evaluate(() => { Math.random = (r => () => 0.05)(Math.random); attack(14, 18); });
await page.waitForSelector('.gd-qte');
let keys = await sequence();
await pressAll(keys);
await page.waitForTimeout(300);
let chat = await page.evaluate(() => window.chat);
check(/успел/.test(chat) && /промах/.test(chat), `успел: ${chat.replace(/<[^>]+>/g, '')}`);
await damage(8);
check(await hp() === 30, 'урона нет');
check(await page.evaluate(() => item.system.uses.spent) === 1, 'заряд потрачен');

// 3. Попала; успел; второй d20 высокий — попала и так, урон вдвое
await reset();
await page.evaluate(() => { Math.random = () => 0.95; attack(16, 20); });
await page.waitForSelector('.gd-qte:not(.win):not(.fail)');
keys = await sequence();
await pressAll(keys);
await page.waitForTimeout(300);
await damage(9);
check(await hp() === 26, `попала и так — урон вдвое меньше (ПЗ ${await hp()})`);

// 4. Ошибся клавишей — атака как была
await reset();
await page.evaluate(() => attack(16, 20));
await page.waitForTimeout(800);
await page.waitForSelector('.gd-qte:not(.win):not(.fail)');
keys = await sequence();
await page.keyboard.press(keys[0] === 'ArrowUp' ? 'ArrowDown' : 'ArrowUp');
await page.waitForTimeout(300);
await damage(9);
check(/не успел/.test(await page.evaluate(() => window.chat)) && await hp() === 21, 'ошибся — полный урон');

// 5. Не успел за время
await reset();
await page.evaluate(() => attack(16, 20));
await page.waitForTimeout(800);
await page.waitForSelector('.gd-qte:not(.win):not(.fail)');
// Снимок программным WebGL долгий — здесь, где ждать всё равно нужно
await stand.shot('qte');
await page.waitForTimeout(2700);
check(/не успел/.test(await page.evaluate(() => window.chat)), 'не успел за 2,5 с');

// 6. Заряды кончились — QTE нет
await page.waitForTimeout(800);
await page.evaluate(() => { item.system.uses.spent = 3; attack(16, 20); });
await page.waitForTimeout(200);
check(!(await page.$('.gd-qte')), 'без зарядов — QTE нет');
await stand.close();
