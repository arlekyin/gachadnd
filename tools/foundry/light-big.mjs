// Рикошет, Вспышка камеры и Спотлайт в настоящей Foundry: node tools/foundry/light-big.mjs [--headed] [--slow[=мс]]
// Рикошет: путь с двумя отражениями от стен, прицел мышью, задетые — цели, отмена Esc без заряда.
// Вспышка: снимок 30 футов, проявка без заряда — места и ПЗ, занятая клетка — ближайшая свободная.
// Спотлайт: темнота сцены, свет на звезде, враги — только звезда или вплотную, массовка с преимуществом,
// «Подыграть», перевод луча без заряда, угасание после следующего раунда.
import { connect, checker } from './harness.mjs';
import { install, scene, skills, use, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const chats = () => ev(() => gdt.chats().map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
const spent = (actor, id) => ev(({ actor, id }) => game.actors.get(actor).items.get(id).system.uses.spent, { actor, id });
const pos = id => ev(id => { const t = game.actors.get(id).getActiveTokens()[0].document; return `${t.x / 100},${t.y / 100}`; }, id);
const toScreen = point => ev(p => { const s = canvas.clientCoordinatesFromCanvas(p); return { x: s.x, y: s.y }; }, point);
const weapon = actor => ev(async id => {
    await game.actors.get(id).createEmbeddedDocuments('Item', [{ name: 'GD-тест: меч', type: 'weapon', system: { type: { value: 'martialM', baseItem: 'longsword' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } }]);
}, actor);

await install(page);

// ================= Рикошет =================
let ids = await scene(page, {
    hero: { x: 5, y: 5, level: 5 },
    enemies: [{ name: 'Восток', x: 8, y: 5 }, { name: 'Запад', x: 3, y: 5 }, { name: 'В стороне', x: 8, y: 9 }],
    walls: [{ c: [10, 0, 10, 14] }, { c: [1, 0, 1, 14] }]
});
let hero = ids.hero;
let [E, W, Side] = ids.enemies;
let S = await skills(page, hero, ['Рикошет']);
await ev(() => gdt.closeForeign());

const path = await ev(async scene => {
    const r = await gdt.mod('memory/skills/light/ricochet.js');
    const s = game.scenes.get(scene);
    const p = r.trace(s, { x: 550, y: 550 }, 0, 2400);
    return { points: p.points.map(q => `${Math.round(q.x)},${Math.round(q.y)}`).join(' → '), bounces: p.bounces, hits: r.hitsAlong(s, p.points, s.tokens.find(t => t.name.includes('Герой')).id).map(t => t.name.replace('GD-тест: ', '')) };
}, ids.scene);
check('Рикошет: луч на восток — стена, назад, стена, назад; два отражения', path.points === '550,550 → 1000,550 → 100,550 → 1000,550' && path.bounces === 2, `${path.points} (${path.bounces})`);
check('Рикошет: задеты Восток и Запад, не стрелок и не тот, кто в стороне', JSON.stringify(path.hits) === '["Восток","Запад"]', JSON.stringify(path.hits));

// Прицел мышью: Esc — отмена без заряда
await ev(({ hero, id }) => { gdt.p = game.actors.get(hero).items.get(id).system.activities.contents[0].use(); }, { hero, id: S['Рикошет'] });
await wait(800);
await page.keyboard.press('Escape');
await wait(500);
check('Рикошет: Esc — отмена, заряд не потрачен', (await spent(hero, S['Рикошет'])) === 0);
// Прицел на восток и выстрел
await ev(() => gdt.mark());
await ev(({ hero, id }) => { gdt.p = game.actors.get(hero).items.get(id).system.activities.contents[0].use(); }, { hero, id: S['Рикошет'] });
await wait(800);
let screen = await toScreen({ x: 900, y: 550 });
await page.mouse.move(screen.x - 30, screen.y + 30);
await page.mouse.move(screen.x, screen.y, { steps: 6 });
await wait(400);
await f.shot('ricochet_aim');
await page.mouse.down(); await page.mouse.up();
// Окно использования dnd5e
for (let i = 0; i < 20; i++) {
    const w = (await ev(() => gdt.windows())).find(w => w.cls === 'ActivityUsageDialog');
    if (w) { await page.click(`#${w.id} button[data-action="use"]`); break; }
    await wait(150);
}
await wait(1500);
const targets = await ev(() => [...game.user.targets].map(t => t.name.replace('GD-тест: ', '')).sort());
check('Рикошет: выстрел — цели Восток и Запад', JSON.stringify(targets) === '["Восток","Запад"]', JSON.stringify(targets));
check('Рикошет: заряд потрачен один раз', (await spent(hero, S['Рикошет'])) === 1, String(await spent(hero, S['Рикошет'])));
let cs = await chats();
check('Рикошет: карточка — отражений 2, задеты оба', cs.some(c => /Отражений: 2/.test(c) && /Восток/.test(c) && /Запад/.test(c)), cs.filter(c => /Рикошет|Отраж/.test(c)).join(' | '));
check('Рикошет: карточка активности dnd5e (спасбросок Ловкости)', await ev(() => game.messages.contents.slice(gdt._mark).some(m => m.flags?.dnd5e?.activity || /Ловкост/.test(m.content))));

// ================= Вспышка камеры =================
ids = await scene(page, {
    hero: { x: 5, y: 5, level: 5 },
    enemies: [{ name: 'В кадре', x: 7, y: 5 }, { name: 'Вне кадра', x: 14, y: 9 }]
});
hero = ids.hero;
const [InFrame, OutFrame] = ids.enemies;
S = await skills(page, hero, ['Вспышка камеры']);
await combat(page, ids.scene, [hero, InFrame, OutFrame]);
await wait(500);
await ev(() => gdt.mark());
await use(page, hero, S['Вспышка камеры']);
await wait(1200);
const shot = await ev(hero => game.actors.get(hero).getFlag('gachadnd', 'cameraFlash'), hero);
check('Вспышка: снимок — герой и «В кадре», без «Вне кадра»', shot && shot.tokens.length === 2 && shot.tokens.every(t => !/Вне кадра/.test(t.name)) && shot.hp === 60, JSON.stringify(shot?.tokens?.map(t => t.name)));
check('Вспышка: заряд потрачен', (await spent(hero, S['Вспышка камеры'])) === 1);
// Всё сдвинулось, героя ранили, на его место встал «Вне кадра»
// Перестановка по очереди, без анимации (как перенос в модуле): иначе v13 ведёт токены по пути
await ev(async ({ hero, a, b }) => {
    const { placeToken } = await gdt.mod('memory/skills/pick.js');
    const doc = id => game.actors.get(id).getActiveTokens()[0].document;
    await placeToken(doc(hero), 500, 800);
    await placeToken(doc(a), 900, 600);
    await placeToken(doc(b), 500, 500);
}, { hero, a: InFrame, b: OutFrame });
await ev(hero => game.actors.get(hero).applyDamage(25), hero);
await wait(800);
const hp0 = await ev(hero => game.actors.get(hero).system.attributes.hp.value, hero);
await ev(() => gdt.mark());
const dev = await use(page, hero, S['Вспышка камеры'], { timeout: 2500 });
await wait(1500);
const heroPos = await pos(hero);
check('Вспышка: проявка — без окна dnd5e и без заряда', !dev.windows.some(w => /ActivityUsageDialog/.test(w)) && (await spent(hero, S['Вспышка камеры'])) === 1, dev.windows.join(', '));
check('Вспышка: «В кадре» вернулся на место со снимка', (await pos(InFrame)) === '7,5', await pos(InFrame));
check('Вспышка: место героя занято — он в соседней свободной клетке', heroPos !== '5,5' && heroPos !== '5,8' && Math.max(Math.abs(+heroPos.split(',')[0] - 5), Math.abs(+heroPos.split(',')[1] - 5)) === 1, heroPos);
check('Вспышка: «Вне кадра» не тронут', (await pos(OutFrame)) === '5,5', await pos(OutFrame));
const hp1 = await ev(hero => game.actors.get(hero).system.attributes.hp.value, hero);
check('Вспышка: ПЗ героя — как на снимке', hp0 === 35 && hp1 === 60, `${hp0} → ${hp1}`);
check('Вспышка: снимок проявлен один раз — стёрт', !(await ev(hero => game.actors.get(hero).getFlag('gachadnd', 'cameraFlash'), hero)));

// ================= Спотлайт =================
ids = await scene(page, {
    hero: { x: 5, y: 5, level: 5 },
    enemies: [{ name: 'Союзник', x: 5, y: 8, disposition: 1 }, { name: 'Враг', x: 9, y: 5 }, { name: 'Вплотную', x: 6, y: 6 }]
});
hero = ids.hero;
const [Ally, Foe, Close] = ids.enemies;
S = await skills(page, hero, ['Спотлайт']);
for (const a of [hero, Ally, Foe, Close]) await weapon(a);
await combat(page, ids.scene, [hero, Ally, Foe, Close]);
await wait(500);
const target = (...actors) => ev(actors => canvas.tokens.setTargets(actors.map(a => game.actors.get(a).getActiveTokens()[0].id)), actors);
const attack = (attacker, ...targets) => ev(async ({ attacker, targets }) => {
    gdt.warnings.length = 0;
    canvas.tokens.setTargets(targets.map(a => game.actors.get(a).getActiveTokens()[0].id));
    const act = game.actors.get(attacker).items.find(i => i.type === 'weapon').system.activities.find(x => x.type === 'attack');
    const rs = await act.rollAttack({}, { configure: false }, {});
    const roll = Array.isArray(rs) ? rs[0] : rs;
    return { formula: roll?.formula ?? null, warn: gdt.warnings.at(-1) ?? null };
}, { attacker, targets });

await target(Ally);
await ev(() => gdt.mark());
await use(page, hero, S['Спотлайт']);
await wait(2500);
const env = () => ev(scene => { const e = game.scenes.get(scene).environment; return { darkness: e.darknessLevel, globalMax: e.globalLight.darkness.max }; }, ids.scene);
const tokenLight = id => ev(id => game.actors.get(id).getActiveTokens()[0].document.light.bright, id);
check('Спотлайт: сцена потемнела, глобальный свет не горит', (await env()).darkness === 1 && (await env()).globalMax <= 0.5, JSON.stringify(await env()));
check('Спотлайт: прожектор на звезде (Союзник)', (await tokenLight(Ally)) === 7.5 && (await tokenLight(hero)) === 0, `${await tokenLight(Ally)} / ${await tokenLight(hero)}`);
await f.shot('spotlight');
let a = await attack(Foe, hero);
check('Спотлайт: враг не может атаковать массовку издалека', a.formula === null && /видит только звезду/.test(a.warn ?? ''), JSON.stringify(a));
a = await attack(Foe, Ally);
check('Спотлайт: враг атакует звезду', !!a.formula && /^1d20/.test(a.formula), JSON.stringify(a));
a = await attack(Close, hero);
check('Спотлайт: враг вплотную атакует массовку', !!a.formula, JSON.stringify(a));
a = await attack(hero, Foe);
check('Спотлайт: массовка атакует из темноты с преимуществом', /^2d20kh/.test(a.formula ?? ''), JSON.stringify(a));
a = await attack(Ally, Foe);
check('Спотлайт: звезда — без преимущества', /^1d20/.test(a.formula ?? ''), JSON.stringify(a));
// «Подыграть» — ход героя (массовка)
await ev(async () => { await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary'); });
await wait(500);
await ev(() => gdt.mark());
const btn = await ev(() => game.messages.contents.findLast(m => m.flags?.gachadnd?.spotlight)?.id);
await page.click(`#chat [data-message-id="${btn}"] [data-spotlight-assist]`);
await wait(1200);
check('Спотлайт: «Подыграть» в ход массовки — звезда получает действие', (await chats()).some(c => /Подыграл/.test(c) && /Союзник/.test(c)), (await chats()).join(' | '));
await page.click(`#chat [data-message-id="${btn}"] [data-spotlight-assist]`);
await wait(800);
check('Спотлайт: второй раз за ход — нельзя', (await chats()).filter(c => /Подыграл/.test(c)).length === 1);
// Перевод луча на героя — без заряда
await target(hero);
const before = await spent(hero, S['Спотлайт']);
await use(page, hero, S['Спотлайт']);
await wait(1500);
check('Спотлайт: луч переведён на героя, свет Союзника вернулся, заряд не тратится', (await tokenLight(hero)) === 7.5 && (await tokenLight(Ally)) === 0 && (await spent(hero, S['Спотлайт'])) === before, `${await tokenLight(hero)} / ${await tokenLight(Ally)}`);
// Угасание: горит до конца раунда 2
for (let i = 0; i < 4; i++) { await ev(() => game.combat.nextTurn()); await wait(500); }
check('раунд 2: Спотлайт ещё горит', (await ev(() => game.combat.round)) === 2 && (await env()).darkness === 1);
for (let i = 0; i < 4; i++) { await ev(() => game.combat.nextTurn()); await wait(500); }
await wait(2000);
check('раунд 3: Спотлайт погас — темнота и свет токенов как были', (await env()).darkness === 0 && (await tokenLight(hero)) === 0 && !(await ev(() => game.combat.getFlag('gachadnd', 'spotlight'))), JSON.stringify(await env()));

const errors = f.log.filter(l => /pageerror|error:.*gachadnd/.test(l));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
process.exit(failed ? 1 : 0);
