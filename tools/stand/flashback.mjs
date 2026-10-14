// Флешбэк: node tools/stand/flashback.mjs
// Окно заявки (ответ подставляется), три уровня: списание Костей Хитов и заряда, бросок
// (с помехой — 2d20kl), карточка в чате; отказ без заряда и без Костей Хитов.
import { open } from './harness.mjs';

const stand = await open('flashback.html', { width: 1200, height: 800 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const use = answer => page.evaluate(async answer => {
    window.DIALOG_ANSWER = answer;
    item.system.uses.spent = 0;
    const blocked = Hooks.events['dnd5e.preUseActivity'].some(fn => fn({ item }) === false);
    await new Promise(resolve => setTimeout(resolve, 100));
    return { blocked, hd: cls.system.hd.value, spent: item.system.uses.spent, chat: window.chat, roll: window.rolls?.at(-1) };
}, answer);

// Простая: бесплатно, без броска; обычное использование dnd5e не идёт
let r = await use({ text: 'Я взял с собой верёвку', tier: 'simple', ability: 'int' });
check(r.blocked && r.hd === 3 && r.spent === 1 && /верёвку/.test(r.chat) && !r.roll, 'простая: заряд, без Костей Хитов и броска, карточка в чате');

// Сложная: 1 Кость Хитов, бросок 1d20 + Интеллект
r = await use({ text: 'Вчера я подкупил стражника', tier: 'hard', ability: 'int' });
check(r.hd === 2 && r.roll?.formula === '1d20 + @mod' && r.roll.total === 15 && /стражника/.test(r.roll.flavor), `сложная: −1 КХ, бросок ${r.roll?.formula} = ${r.roll?.total}`);

// Невероятная: 2 Кости Хитов, бросок с помехой
r = await use({ text: 'Неделю назад я заминировал этот мост', tier: 'wild', ability: 'dex' });
check(r.hd === 0 && r.roll?.formula === '2d20kl + @mod' && /с помехой/.test(r.roll.flavor), 'невероятная: −2 КХ, бросок с помехой');

// Без Костей Хитов сложную нельзя
const before = await page.evaluate(() => window.rolls.length);
r = await use({ text: 'Я заранее спрятал отмычку', tier: 'hard', ability: 'dex' });
check(r.hd === 0 && r.spent === 0 && (await page.evaluate(() => window.rolls.length)) === before, 'без Костей Хитов — отказ, заряд цел');

// Пустая заявка — отказ
r = await use({ text: '', tier: 'simple', ability: 'int' });
check(r.spent === 0, 'пустая заявка — отказ');

// Заряд кончился — окно не открывается
const blockedNoUses = await page.evaluate(() => { item.system.uses.spent = 1; window.DIALOG_ANSWER = null; return Hooks.events['dnd5e.preUseActivity'].some(fn => fn({ item }) === false); });
check(blockedNoUses, 'без заряда — отказ');
await stand.close();
