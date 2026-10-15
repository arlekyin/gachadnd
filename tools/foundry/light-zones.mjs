// Маяк и Диско-шар в настоящей Foundry: node tools/foundry/light-zones.mjs [--headed] [--slow[=мс]]
// Маяк: конус ставится мышью (шаблон dnd5e), свет с тем же направлением, враг в луче — спасбросок
// Телосложения и ослепление, поворот на 90° каждый раунд, союзник в луче — +1d4, срок и разбитый маяк.
// Диско-шар: 6 цветных пятен в 30 футах, карта Пятницы в начале хода на пятне и при заходе на пятно,
// новые пятна каждый раунд, уборка в конце боя.
import { connect, checker } from './harness.mjs';
import { install, scene, skills, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const ids = await scene(page, {
    hero: { x: 5, y: 5, level: 5 },
    enemies: [{ name: 'Рядом', x: 8, y: 5 }, { name: 'Далеко', x: 12, y: 9 }]
});
const { hero } = ids;
const [A, B] = ids.enemies;
const S = await skills(page, hero, ['Маяк', 'Диско-шар']);
const chats = () => ev(() => gdt.chats().map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
const turn = () => ev(() => `${game.combat.round}:${game.combat.combatant?.name?.replace('GD-тест: ', '')}`);
const next = async () => { await ev(() => game.combat.nextTurn()); await wait(1200); return turn(); };
const effects = id => ev(id => game.actors.get(id).effects.map(e => e.name), id);
const center = id => ev(id => { const t = game.actors.get(id).getActiveTokens()[0]; return { x: t.center.x, y: t.center.y }; }, id);

await combat(page, ids.scene, [hero, A, B]);
await wait(600);
await ev(() => gdt.closeForeign());

// ---------- Маяк: использование → окно dnd5e → конус мышью в вершине (700, 500), направление 0° (восток)
const before = (await ev(() => gdt.windows())).map(w => w.id);
await ev(({ hero, id }) => { gdt.p = game.actors.get(hero).items.get(id).system.activities.contents[0].use(); }, { hero, id: S['Маяк'] });
for (let i = 0; i < 20; i++) {
    const w = (await ev(() => gdt.windows())).find(w => !before.includes(w.id) && w.cls === 'ActivityUsageDialog');
    if (w) { await page.click(`#${w.id} button[data-action="use"]`); break; }
    await wait(150);
}
await wait(800);
const screen = await ev(() => { const p = canvas.clientCoordinatesFromCanvas({ x: 700, y: 500 }); return { x: p.x, y: p.y }; });
await page.mouse.move(screen.x - 40, screen.y - 40);
await page.mouse.move(screen.x, screen.y, { steps: 8 });
await wait(300);
await page.mouse.down();
await page.mouse.up();
await ev(() => gdt.p);
await wait(1500);
const beacon = () => ev(scene => {
    const t = game.scenes.get(scene).templates.find(t => t.flags.gachadnd?.lighthouse);
    if (!t) return null;
    const light = game.scenes.get(scene).lights.get(t.flags.gachadnd.lighthouse.lightId);
    return { x: t.x, y: t.y, direction: t.direction, distance: t.distance, angle: t.angle, light: light ? { x: light.x, y: light.y, rotation: light.rotation, angle: light.config.angle } : null };
}, ids.scene);
let b = await beacon();
check('Маяк: конус поставлен мышью, свет зажжён в вершине', b && b.light && b.light.x === b.x && b.light.y === b.y, JSON.stringify(b));
// Свет светит туда же, куда конус: точка луча (враг «Рядом») — в свете, герой за спиной — нет
const lit = point => ev(({ scene, point }) => {
    const t = game.scenes.get(scene).templates.find(t => t.flags.gachadnd?.lighthouse);
    const src = canvas.lighting.get(t.flags.gachadnd.lighthouse.lightId)?.lightSource;
    return !!src?.shape?.contains(point.x, point.y);
}, { scene: ids.scene, point });
check('Маяк: свет направлен как конус (враг в луче освещён, герой за спиной — нет)', await lit(await center(A)) && !(await lit(await center(hero))), JSON.stringify(b?.light));
await f.shot('lighthouse');

// Ход врага «Рядом» в луче: спасбросок Телосложения, к20 = 1 — ослеплён
await ev(() => { gdt.mark(); gdt.dice(20, 1); });
check('ход врага «Рядом»', (await next()) === '1:Рядом', await turn());
let cs = await chats();
check('Маяк: враг в луче — спасбросок Телосложения, провал, ослеплён', cs.some(c => /Телосложени/.test(c)) && await ev(id => game.actors.get(id).statuses.has('blinded'), A), cs.filter(c => /Маяк|Телосл/.test(c)).join(' | '));
await ev(() => gdt.mark());
await next(); // «Далеко»: не в луче
check('Маяк: враг вне луча — спасброска нет; ослепление снято с концом хода', !(await chats()).some(c => /Телосложени/.test(c)) && !(await ev(id => game.actors.get(id).statuses.has('blinded'), A)));
// Раунд 2: луч на юг, раунд 3: на запад — герой в луче
check('раунд 2', (await next()) === '2:Герой', await turn());
b = await beacon();
check('Маяк: в начале раунда 2 луч повернулся на 90° (и свет)', b.direction === 90 && b.light.rotation === 0, JSON.stringify(b));
await next(); await next();
check('раунд 3: ход героя', (await next()) === '3:Герой', await turn());
b = await beacon();
check('Маяк: раунд 3 — луч на запад', b.direction === 180, JSON.stringify(b));
check('Маяк: союзник в луче — +1d4 к атакам и спасброскам', (await effects(hero)).includes('Маяк: свет'), (await effects(hero)).join(', '));
// Разбили маяк — свет гаснет
const lightId = (await ev(scene => game.scenes.get(scene).templates.find(t => t.flags.gachadnd?.lighthouse).flags.gachadnd.lighthouse.lightId, ids.scene));
await ev(scene => game.scenes.get(scene).templates.find(t => t.flags.gachadnd?.lighthouse).delete(), ids.scene);
await wait(800);
check('Маяк разбит — свет погас', !(await ev(({ scene, lightId }) => game.scenes.get(scene).lights.has(lightId), { scene: ids.scene, lightId })));

// ---------- Диско-шар
await ev(() => gdt.mark());
await ev(async ({ hero, id }) => {
    const act = game.actors.get(hero).items.get(id).system.activities.contents[0];
    await act.use({}, { configure: false });
}, { hero, id: S['Диско-шар'] });
await wait(1500);
const disco = () => ev(() => game.combat.getFlag('gachadnd', 'disco'));
let d = await disco();
const lights = await ev(({ scene, ids }) => (ids ?? []).filter(id => game.scenes.get(scene).lights.has(id)).length, { scene: ids.scene, ids: d?.lights });
const far = await ev(({ d }) => d.spots.filter(s => Math.max(Math.abs(s.i - Math.floor(d.x / 100)), Math.abs(s.j - Math.floor(d.y / 100))) > 6).length, { d });
check('Диско-шар: 6 пятен — 6 цветных огней', d?.spots?.length === 6 && lights === 6, JSON.stringify(d?.spots));
check('Диско-шар: все пятна в 30 футах от шара', far === 0, String(far));
await f.shot('disco');
// Пятно под врагом «Рядом» — карта в начале его хода
await ev(({ A }) => {
    const t = game.actors.get(A).getActiveTokens()[0].document;
    const d = game.combat.getFlag('gachadnd', 'disco');
    return game.combat.setFlag('gachadnd', 'disco', { ...d, spots: [{ i: Math.round(t.x / 100), j: Math.round(t.y / 100) }, { i: 14, j: 9 }] });
}, { A });
await ev(() => gdt.mark());
await next();
check('ход «Рядом» на пятне — карта Пятницы', (await effects(A)).some(n => /Чумовая пятница/.test(n)) && (await chats()).some(c => /Диско-шар.*на пятне/.test(c)), (await effects(A)).join(', '));
// «Далеко» заходит на пятно (14, 9) в свой ход
await next();
await ev(B => game.actors.get(B).getActiveTokens()[0].document.update({ x: 1400, y: 900 }), B);
await ev(B => gdt.until(() => game.actors.get(B).effects.some(e => /Чумовая пятница/.test(e.name)), 8000), B);
check('«Далеко» зашёл на пятно — карта', (await effects(B)).some(n => /Чумовая пятница/.test(n)), (await effects(B)).join(', '));
await ev(B => game.actors.get(B).getActiveTokens()[0].document.update({ x: 1300, y: 900 }), B);
await wait(500);
await ev(B => game.actors.get(B).getActiveTokens()[0].document.update({ x: 1400, y: 900 }), B);
await wait(1000);
check('повторный заход за тот же ход — второй карты нет', (await effects(B)).filter(n => /Чумовая пятница/.test(n)).length === 1, (await effects(B)).join(', '));
// Новый раунд — новые пятна
const oldLights = (await disco()).lights;
await next();
d = await disco();
check('новый раунд — новые пятна', d.lights.length === 6 && !d.lights.some(id => oldLights.includes(id)), JSON.stringify(d.lights));
// Конец боя — огни убраны
await ev(() => game.combat.delete());
await wait(1500);
const left = await ev(scene => game.scenes.get(scene).lights.filter(l => l.flags.gachadnd?.discoSpot).length, ids.scene);
check('конец боя — огни диско убраны', left === 0, String(left));

await ev(() => gdt.resetDice());
const errors = f.log.filter(l => /pageerror|error:.*gachadnd/.test(l));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
process.exit(failed ? 1 : 0);
