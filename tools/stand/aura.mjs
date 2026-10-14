// Счётчик ауры: node tools/stand/aura.mjs [--v13]
// Включение только в бою, позёрство (помеха, −5, КД −2, Ва-банк), итог по КД и Сл, итог Мастером,
// убывание за ход без ауры, крит, натуральная 1, добивание, пороги 2/4/5 (эффект, помеха врагам
// в 10 футах, страх в 15), тема и волны на 5, финал «Не в этой арке», конец на 0 и с концом боя.
// Снимок out/aura_hero.png. Поле (клетки): персонаж 5,10; огр 8–9,9–10 (10 футов); гоблин 11,7 (25 футов).
import { open, args } from './harness.mjs';

const { v13 } = args();
const stand = await open(`aura.html${v13 ? '?v13' : ''}`, { width: 1300, height: 900 });
const { page } = stand;
const check = (ok, text) => console.log(ok ? '  ok ' : '  !! ', text);
const aura = () => page.evaluate(() => structuredClone(actor.flags.gachadnd?.aura ?? null));
const value = async () => (await aura())?.active ? (await aura()).value : 0;
const effects = id => page.evaluate(id => scene.tokens.get(id).actor.effects.map(e => e.name), id);
const wait = (ms = 150) => page.waitForTimeout(ms);
const turn = async (r, t) => { await page.evaluate(([r, t]) => turn(r, t), [r, t]); await wait(); };
// Бросок к20 персонажа: preRoll, затем итог
const roll = (kind, { total = 10, target = null, crit = false, fumble = false } = {}) => page.evaluate(([kind, total, target, crit, fumble]) => {
    const activity = { actor, item: { actor } };
    const config = { subject: kind === 'attack' ? activity : actor, hookNames: [kind === 'attack' ? 'attack' : kind === 'save' ? 'savingThrow' : 'abilityCheck', 'd20Test'], rolls: [{ parts: ['@mod'], options: {} }] };
    Hooks.call('dnd5e.preRollD20TestV2', config);
    const r = { options: { ...config.rolls[0].options, ...(target !== null ? { target } : {}) }, total, isCritical: crit, isFumble: fumble };
    const hook = { attack: 'dnd5e.rollAttackV2', save: 'dnd5e.rollSavingThrowV2', check: 'dnd5e.rollAbilityCheckV2' }[kind];
    Hooks.callAll(hook, [r], { subject: kind === 'attack' ? activity : actor });
    return { disadvantage: !!config.rolls[0].options.disadvantage, parts: config.rolls[0].parts };
}, [kind, total, target, crit, fumble]);
const pose = async (price, text = 'Не оборачиваясь') => {
    await page.evaluate(([price, text]) => { window.POSE = { price, text }; }, [price, text]);
    await page.click('.gachadnd-aura [data-action="pose"]');
    await wait();
};

// 1. Вне боя — не включается
check(await page.evaluate(() => useSkill()) === false && !(await aura())?.active, 'вне боя навык не включается');

// 2. В бою — аура 1, панель, «+1000 aura»
await page.evaluate(() => { game.combat.started = true; });
check(await page.evaluate(() => useSkill()) === true, 'в бою навык используется');
await page.waitForSelector('.gachadnd-aura .gd-aura-value');
check(await value() === 1 && (await page.evaluate(() => window.floats ?? [])).includes('+1000 aura'), 'аура 1, всплыло «+1000 aura», панель открыта');

// 3. Позёрство «Небрежно» по атаке: помеха, попадание по КД 12 — аура 2, Уверенность
await pose('casual');
check((await page.evaluate(() => actor.flags.gachadnd.auraPose?.status)) === 'ready', 'поза объявлена');
let r = await roll('attack', { total: 15, target: 12 });
await wait();
check(r.disadvantage, 'Небрежно: помеха на бросок');
check(await value() === 2 && (await effects('caster')).includes('Аура: Уверенность'), 'попадание: аура 2, эффект «Уверенность»');
check(await page.evaluate(() => /Удалось: \+1000 aura/.test(chat) && /Не оборачиваясь/.test(chat)), 'карточка позы в чате');

// 4. Вторая поза в том же раунде — нельзя
check(await page.evaluate(() => aura.canPose(actor)) === 'В этом раунде поза уже была.', 'вторая поза в раунде — отказ');

// 5. Ходы: аура была — без убывания; ход без ауры — −1, Уверенность снята
await turn(1, 1); await turn(2, 0);
check(await value() === 2, 'ход после ауры — без убывания');
await turn(2, 1); await turn(3, 0);
check(await value() === 1 && !(await effects('caster')).includes('Аура: Уверенность'), 'ход без ауры — аура 1, Уверенность снята');

// 6. «Одной левой» на проверке без Сл — −5, итог решает Мастер кнопкой
await pose('onehand');
r = await roll('check', { total: 14 });
await wait();
check(r.parts.includes('-5') && await value() === 1, 'Одной левой: −5 к броску, Сл неизвестна — аура ждёт Мастера');
await page.evaluate(() => aura.resolvePoseCard(messages.at(-1), true));
await wait();
check(await value() === 2, 'Мастер: «Удалось» — аура 2');

// 7. Крит +1, натуральная 1 −1, добивание +1
await roll('attack', { total: 25, crit: true }); await wait();
check(await value() === 3, 'крит — аура 3');
await roll('check', { total: 3, fumble: true }); await wait();
check(await value() === 2, 'натуральная 1 — аура 2');
await page.evaluate(() => Hooks.call('updateActor', scene.tokens.get('goblin').actor, { system: { attributes: { hp: { value: 0 } } } }));
await wait();
check(await value() === 3, 'добивание врага в свой ход — аура 3');

// 8. Ва-банк на спасброске Сл 15: помеха, КД −2, +2 — аура 5
await turn(3, 1); await turn(4, 0);
await pose('allin', 'Скрестив руки');
r = await roll('save', { total: 18, target: 15 });
await wait(300);
check(r.disadvantage && await value() === 5, 'Ва-банк: помеха, спасбросок удался — аура 5');
check((await effects('caster')).includes('Позёрство: Ва-банк'), 'Ва-банк: КД −2 до начала следующего хода');
await wait(400);
check(await page.evaluate(() => window.gachadndAuraTheme === true && (window.gachadndAuraWaves ?? 0) >= 2), 'аура 5: тема героя и волна');
await page.evaluate(() => auraPanel.AuraPanel.instance(actor).render());
await wait(500);
await stand.shot('aura_hero');

// 9. Давление: огр в 10 футах — спасбросок с помехой, гоблин в 25 — без
const enemySave = id => page.evaluate(id => {
    const config = { subject: scene.tokens.get(id).actor, hookNames: ['savingThrow', 'd20Test'], rolls: [{ options: {} }] };
    Hooks.call('dnd5e.preRollD20TestV2', config);
    return !!config.rolls[0].options.disadvantage;
}, id);
check(await enemySave('ogre') && !(await enemySave('goblin')), 'Давление: огр с помехой, гоблин — без');

// 10. Главный герой: огр начинает ход в 15 футах — провал, испуган; гоблин далеко — без спасброска
await page.evaluate(() => { window.SAVE_OK = false; window.saves = []; });
await turn(4, 1);
check((await page.evaluate(() => saves.length)) === 0, 'гоблин в 25 футах — спасброска нет');
await turn(4, 2);
check((await page.evaluate(() => saves[0]?.[2])) === 15 && (await effects('ogre')).includes('Испуган аурой'), 'огр: спасбросок Мудрости Сл 15 (8 + 3 + 4) провален — испуган');
await turn(4, 3);
check(!(await effects('ogre')).includes('Испуган аурой'), 'страх снят в конце хода огра');

// 11. Начало хода персонажа: КД −2 снят
await turn(5, 0);
check(!(await effects('caster')).includes('Позёрство: Ва-банк'), 'КД −2 снят в начале хода');

// 12. Финал «Не в этой арке»: урон 10 не проходит, аура гаснет
const hp = () => page.evaluate(() => actor.system.attributes.hp.value);
const before = await hp();
await page.evaluate(() => actor.applyDamage(10));
await wait(300);
check(await hp() === before && !(await aura()).active && !(await effects('caster')).includes('Аура: Уверенность'), 'финал: урон не прошёл, аура погасла');
check(await page.evaluate(() => window.gachadndAuraTheme === false), 'тема героя затихла');

// 13. Снова: аура 1 — урон проходит без вопроса; ход без ауры — гаснет
await page.evaluate(() => useSkill());
await wait();
await page.evaluate(() => actor.applyDamage(4));
await wait();
check(await hp() === before - 4, 'аура 1: урон проходит');
await turn(5, 1); await turn(6, 0);
check(await value() === 1, 'первый ход после включения — без убывания');
await turn(6, 1); await turn(7, 0);
check(await value() === 0 && !(await aura()).active, 'ход без ауры на 1 — аура погасла');

// 14. Конец боя гасит ауру
await page.evaluate(() => { actor.items[0].system.uses.spent = 0; useSkill(); });
await wait();
const was = await value();
await page.evaluate(() => Promise.all(Hooks.events.deleteCombat.map(fn => fn(game.combat))));
await wait();
check(was === 1 && !(await aura()).active, 'конец боя — аура погасла');
await stand.close();
