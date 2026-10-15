// Автоматизация навыков света в настоящей Foundry: node tools/foundry/light-auto.mjs [--headed] [--slow[=мс]]
// Ультрафиолет (тайные двери в радиусе), Призма (урон на 7 типов с сопротивлением и иммунитетом),
// Скорость света (ход вне очереди, свой ход пропущен, со следующего раунда — по порядку),
// Солнечная батарея (заряд за конец хода на ярком свету, не в темноте, 3 заряда → заряд навыка).
import { connect, checker } from './harness.mjs';
import { install, scene, skills, use, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, {
    hero: { x: 5, y: 5, level: 5 },
    enemies: [{ name: 'Огнеупорный', x: 8, y: 5, traits: { dr: { value: ['fire'] }, di: { value: ['poison'] } } }, { name: 'Второй', x: 9, y: 7 }],
    walls: [
        { c: [7, 4, 7, 7], door: 2 },   // тайная дверь в 10 футах
        { c: [18, 2, 18, 5], door: 2 }, // тайная дверь в 60 футах
        { c: [10, 0, 10, 3], door: 0 }  // обычная стена
    ]
});
const { hero } = ids;
const [A, B] = ids.enemies;
const S = await skills(page, hero, ['Ультрафиолет', 'Призма', 'Скорость света', 'Солнечная батарея']);
const chats = () => ev(() => gdt.chats().map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
const spent = id => ev(({ hero, id }) => game.actors.get(hero).items.get(id).system.uses.spent, { hero, id });

// ---------- Ультрафиолет
await ev(() => gdt.mark());
let u = await use(page, hero, S['Ультрафиолет']);
await wait(800);
const doors = await ev(scene => game.scenes.get(scene).walls.map(w => w.door), ids.scene);
check('Ультрафиолет: тайная дверь в 30 футах стала обычной, дальняя — тайная, стена — стена', JSON.stringify(doors) === '[1,2,0]', JSON.stringify(doors) + ' окна: ' + u.windows.join(', '));
check('Ультрафиолет: карточка в чате', (await chats()).some(c => /проступили тайные двери: 1/.test(c)), (await chats()).at(-1));

// ---------- Призма: 8 + 2 = 10 урона → 4 огнём (сопротивление: 2), по 1 кислотой, молнией, ядом (иммунитет: 0), холодом, звуком, силовым полем
await ev(async hero => {
    await game.actors.get(hero).createEmbeddedDocuments('Item', [{ name: 'GD-тест: меч', type: 'weapon', system: { type: { value: 'martialM', baseItem: 'longsword' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } }]);
}, hero);
const strike = target => ev(async ({ hero, target }) => {
    const a = game.actors.get(hero), t = game.actors.get(target);
    const act = a.items.find(i => i.type === 'weapon').system.activities.find(x => x.type === 'attack');
    gdt.dice(8, 8);
    const rolls = await act.rollDamage({}, { configure: false }, {});
    // Как кнопка применения урона в чате: описание урона из бросков
    const damages = rolls.map(r => ({ value: r.total, type: r.options.type, properties: new Set(r.options.properties ?? []) }));
    const hp0 = t.system.attributes.hp.value;
    const preview = t.calculateDamage(damages, {});
    await t.applyDamage(damages, {});
    return { formula: rolls.map(r => r.formula).join(' + '), total: rolls.reduce((s, r) => s + r.total, 0), lost: hp0 - t.system.attributes.hp.value,
        parts: preview ? preview.map(d => `${d.type}:${d.value}`).join(' ') : null };
}, { hero, target });
u = await use(page, hero, S['Призма']);
await wait(500);
check('Призма: взведена', !!(await ev(hero => game.actors.get(hero).getFlag('gachadnd', 'prism'), hero)));
let r = await strike(A);
check('Призма: 10 урона → 7 типов, сопротивление огню и иммунитет к яду — потеря 7', r.lost === 7, JSON.stringify(r));
check('Призма: погасла после атаки', !(await ev(hero => game.actors.get(hero).getFlag('gachadnd', 'prism'), hero)));
r = await strike(A);
check('без Призмы: 10 рубящего — потеря 10', r.lost === 10, JSON.stringify(r));

// ---------- Скорость света: порядок Огнеупорный, Второй, Герой
await combat(page, ids.scene, [A, B, hero]);
await wait(600);
const turn = () => ev(() => `${game.combat.round}:${game.combat.combatant?.name?.replace('GD-тест: ', '')}`);
check('бой: раунд 1, ходит Огнеупорный', (await turn()) === '1:Огнеупорный', await turn());
await ev(() => gdt.mark());
u = await use(page, hero, S['Скорость света']);
await wait(800);
check('Скорость света: ход героя вне очереди', (await turn()) === '1:Герой', await turn() + ' ' + u.windows.join(', '));
check('Скорость света: заряд потрачен, карточка', (await spent(S['Скорость света'])) === 1 && (await chats()).some(c => /вне очереди/.test(c)));
const next = async () => { await ev(() => game.combat.nextTurn()); await wait(700); return turn(); };
check('после хода вне очереди — Второй', (await next()) === '1:Второй', await turn());
check('свой ход героя в раунде 1 пропущен — раунд 2', (await next()) === '2:Огнеупорный', await turn());
check('раунд 2: Второй', (await next()) === '2:Второй', await turn());
check('раунд 2: герой ходит на своём месте', (await next()) === '2:Герой', await turn());
await ev(() => { gdt.warnings.length = 0; });
await ev(({ hero, id }) => game.actors.get(hero).items.get(id).update({ 'system.uses.spent': 0 }), { hero, id: S['Скорость света'] });
await use(page, hero, S['Скорость света']);
check('в свой ход — отказ, заряд не тратится', await ev(() => gdt.warnings.some(w => /и так ваш ход/.test(w))) && (await spent(S['Скорость света'])) === 0, (await ev(() => gdt.warnings)).join(' | '));

// ---------- Солнечная батарея: ход героя кончается на ярком свету (глобальный свет)
const charges = () => ev(({ hero, id }) => game.actors.get(hero).items.get(id).getFlag('gachadnd', 'battery') ?? 0, { hero, id: S['Солнечная батарея'] });
// Ходы героя выше тоже кончались на свету — батарея копила; начинаем с нуля
await ev(({ hero, id }) => game.actors.get(hero).items.get(id).setFlag('gachadnd', 'battery', 0), { hero, id: S['Солнечная батарея'] });
while (!/Герой/.test(await turn())) await next();
await next(); // ход героя кончился на свету
check('батарея: конец хода на ярком свету — заряд 1', (await charges()) === 1, String(await charges()));
// Ночь: глобальный свет не горит
await ev(scene => game.scenes.get(scene).update({ 'environment.darknessLevel': 1, 'environment.globalLight.darkness.max': 0.5 }), ids.scene);
await wait(1500);
while (!/Герой/.test(await turn())) await next();
await next();
check('батарея: ночью без света — заряда нет', (await charges()) === 1, String(await charges()));
// Фонарь рядом с героем: яркий свет 15 футов
await ev(scene => game.scenes.get(scene).createEmbeddedDocuments('AmbientLight', [{ x: 550, y: 450, config: { bright: 15, dim: 30 } }]), ids.scene);
await wait(1500);
while (!/Герой/.test(await turn())) await next();
await next();
check('батарея: ночью в ярком свете фонаря — заряд 2', (await charges()) === 2, String(await charges()));
check('батарея: потолок — бонус мастерства (3)', await ev(hero => game.actors.get(hero).system.attributes.prof, hero) === 3);
// Разряд: 2 заряда — мало
await ev(() => { gdt.warnings.length = 0; });
await use(page, hero, S['Солнечная батарея']);
check('батарея: 2 заряда — отказ', await ev(() => gdt.warnings.some(w => /нужно 3/.test(w))), (await ev(() => gdt.warnings)).join(' | '));
// 3 заряда → заряд Призме
await ev(({ hero, id }) => game.actors.get(hero).items.get(id).setFlag('gachadnd', 'battery', 3), { hero, id: S['Солнечная батарея'] });
const prismSpent = await spent(S['Призма']);
u = await use(page, hero, S['Солнечная батарея'], { select: { target: S['Призма'] }, timeout: 2500 });
check('батарея: окно выбора навыка', u.windows.some(w => /Солнечная батарея/.test(w)), u.windows.join(', '));
check('батарея: 3 заряда → Призме вернулся заряд', prismSpent === 1 && (await spent(S['Призма'])) === 0 && (await charges()) === 0, `Призма ${prismSpent} → ${await spent(S['Призма'])}, батарея ${await charges()}`);

await ev(() => gdt.resetDice());
await f.shot('light_auto');
const errors = f.log.filter(l => /pageerror|error:.*gachadnd/.test(l));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
process.exit(failed ? 1 : 0);
