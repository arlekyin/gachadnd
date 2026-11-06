// Голоса игроков на карте этажа в настоящей Foundry: node tools/foundry/votes.mjs [--headed]
// Два игрока (Claude_player — Лира, Claude_trusted — Борк), щелчки мышью по настоящей карте: голос виден всем с портретом
// и цветом, повторный щелчок снимает, другой узел — переносит; можно и недоступный узел, нельзя — под отрядом; отряд с места
// не двигается;
// шаг Мастера гасит голоса; вышедший игрок исчезает с орбиты. Паутина и бумажные ряды.
import { connect, joinAs, checker, moduleErrors, done } from './harness.mjs';
import { install, scene } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
await scene(page, { enemies: [] });
const since = f.log.length;
const saved = await ev(() => Object.fromEntries(['runFloor', 'mapMode', 'floorSceneId', 'effects'].map(k => [k, game.settings.get('gachadnd', k)])));

// Лира и Борк: персонажи назначены игрокам, цвета — различимые
const P = await ev(async () => {
    await game.settings.set('gachadnd', 'effects', 'off');
    await game.settings.set('gachadnd', 'runFloor', 1);
    await game.settings.set('gachadnd', 'floorSceneId', '');
    for (const old of game.actors.filter(a => /^GD-тест: (Лира|Борк)$/.test(a.name))) await old.delete();
    const p1 = game.users.getName('Claude_player'), p2 = game.users.getName('Claude_trusted');
    const mk = (name, user, img) => Actor.create({ name: `GD-тест: ${name}`, type: 'character', img, ownership: { default: 0, [user.id]: 3 } });
    const lira = await mk('Лира', p1, 'systems/dnd5e/tokens/heroes/RangerBow.webp');
    const bork = await mk('Борк', p2, 'systems/dnd5e/tokens/heroes/FighterShield.webp');
    const colors = { p1: p1.color, p2: p2.color };
    await p1.update({ character: lira.id, color: '#e5484d', 'flags.gachadnd.mapVote': null });
    await p2.update({ character: bork.id, color: '#3e9bff', 'flags.gachadnd.mapVote': null });
    if (!game.users.getName('GD-тест: зритель')) await User.create({ name: 'GD-тест: зритель', role: 1, password: '' });
    return { lira: lira.id, bork: bork.id, p1: p1.id, p2: p2.id, colors };
});

const draw = mode => ev(async mode => {
    const map = await gdt.mod('labyrinth/map.js');
    for (const w of [...foundry.applications.instances.values()]) if (/gachadnd-(map-terminal|web-overlay)/.test(w.id)) await w.close({ instant: true });
    await map.drawFloor({ mode, length: 7, floor: 1 });
    await gdt.settle();
}, mode);
const mapNow = () => ev(() => canvas.scene.getFlag('gachadnd', 'floorMap'));
// Окно узла открывается у всех и закрывает карту: игрок на сессии закрывает его сам
const closeNodeWindows = pg => pg.evaluate(async () => {
    for (const w of [...foundry.applications.instances.values()]) if (w.hasFrame && w.rendered && !/gachadnd-(map-terminal|web-overlay)/.test(w.id)) await w.close();
});
let players = [];
const stepGM = async id => {
    await ev(async id => {
        await (await gdt.mod('labyrinth/map.js')).stepTo(id);
        await new Promise(r => setTimeout(r, 400));
        await gdt.settle(300, 6000);
    }, id);
    await wait(800);
    for (const pg of [page, ...players]) await closeNodeWindows(pg);
};
const openMap = pg => pg.evaluate(async () => { await game.gachadnd.openMapTerminal(); await new Promise(r => setTimeout(r, 2800)); });
const flag = (pg, id) => pg.evaluate(id => game.users.get(id).getFlag('gachadnd', 'mapVote')?.node ?? null, id);

// Что нарисовано на холсте паутины: узел → портреты с цветом
const webVotes = pg => pg.evaluate(() => {
    const stage = foundry.applications.instances.get('gachadnd-web-overlay')?.stage;
    const out = {};
    for (const [id, voters] of stage?.model?.votes ?? []) out[id] = voters.map(v => `${v.name}|${v.color}|${v.img}`);
    return { votes: out, orbits: stage?.orbits?.length ?? 0, layer: stage?.votes?.children.length ?? 0 };
});
// Щелчок мышью по кристаллу: координаты — из самого холста
const clickWeb = async (pg, id) => {
    const at = await pg.evaluate(id => {
        const app = foundry.applications.instances.get('gachadnd-web-overlay'), node = app.stage.nodes.get(id).node, box = app.stage.view.getBoundingClientRect();
        return { x: box.left + node.position.x, y: box.top + node.position.y };
    }, id);
    await pg.mouse.move(at.x, at.y);
    await pg.waitForTimeout(80);
    await pg.mouse.click(at.x, at.y);
    await pg.waitForTimeout(700);
};
// Ряды: что нарисовано на бумаге
const rowVotes = pg => pg.evaluate(() => Object.fromEntries([...document.querySelectorAll('#gachadnd-map-terminal .gd-map-node:has(.gd-vote-orbit)')].map(n => [n.dataset.nodeId, {
    faces: [...n.querySelectorAll('.gd-vote-face')].map(el => `${el.title}|${getComputedStyle(el).getPropertyValue('--voter').trim()}`),
    img: n.querySelector('.gd-vote-face img')?.naturalWidth ?? 0, arcs: n.querySelectorAll('.gd-vote-rim circle').length
}])));
const clickRow = async (pg, id) => {
    await pg.evaluate(id => document.querySelector(`#gachadnd-map-terminal .gd-map-node[data-node-id="${id}"]`).scrollIntoView({ block: 'center' }), id);
    await pg.locator(`#gachadnd-map-terminal .gd-map-node[data-node-id="${id}"] .gd-map-mark`).click({ force: true });
    await pg.waitForTimeout(700);
};

// ---------- Паутина
await draw('web');
const p1 = await joinAs(f, 'Claude_player');
const p2 = await joinAs(f, 'Claude_trusted');
const p3 = await joinAs(f, 'GD-тест: зритель');
await wait(1500);
players = [p1.page, p2.page];
for (const pg of [page, p1.page, p2.page]) await openMap(pg);

let m = await mapNow();
const start = (await ev(async () => { const { webMoves } = await gdt.mod('labyrinth/web-map.js'); return Object.keys(webMoves(canvas.scene.getFlag('gachadnd', 'floorMap'))); }));
await stepGM(start[0]);
m = await mapNow();
const moves = await ev(async () => { const { webMoves } = await gdt.mod('labyrinth/web-map.js'); return Object.keys(webMoves(canvas.scene.getFlag('gachadnd', 'floorMap'))); });
// Карта случайная, отряд может стоять в тупике: шаг — на a, голосовать можно и за любой другой узел
const here = m.currentNodeId;
const a = moves[0];
const others = m.nodes.filter(n => n.id !== here && n.id !== a).map(n => n.id);
const b = moves[1] ?? others[0];
const far = others.find(id => !moves.includes(id) && id !== b);
check('паутина: есть узел для шага, второй узел и недоступный узел', !!a && !!b && !!far, [a, b, far].join(','));
await wait(800);

await clickWeb(p1.page, a);
let gm = await webVotes(page);
check('щелчок игрока: голос стоит, Мастер видит портрет и цвет игрока', await flag(page, P.p1) === a && gm.votes[a]?.length === 1 && gm.votes[a][0] === 'GD-тест: Лира|#e5484d|systems/dnd5e/tokens/heroes/RangerBow.webp' && gm.orbits === 1, JSON.stringify(gm));
check('второй игрок тоже видит этот голос', (await webVotes(p2.page)).votes[a]?.length === 1);
check('голос — только выбор: отряд остался на месте', (await mapNow()).currentNodeId === here);
await p1.shot('votes-1-web-player');

await clickWeb(p2.page, a);
gm = await webVotes(page);
check('двое на одном узле: два портрета на одной орбите', gm.votes[a]?.length === 2 && gm.orbits === 2, JSON.stringify(gm.votes));
await f.shot('votes-2-web-two');

await clickWeb(p2.page, b);
gm = await webVotes(page);
check('щелчок по другому узлу переносит голос', gm.votes[a]?.length === 1 && gm.votes[b]?.length === 1 && await flag(page, P.p2) === b, JSON.stringify(gm.votes));
await f.shot('votes-3-web-split');

await clickWeb(p2.page, b);
gm = await webVotes(page);
check('повторный щелчок снимает голос', !gm.votes[b] && await flag(page, P.p2) === null, JSON.stringify(gm.votes));

await clickWeb(p2.page, here);
gm = await webVotes(page);
check('за узел под отрядом голосовать нельзя', await flag(page, P.p2) === null && !gm.votes[here], here);

await clickWeb(p2.page, far);
gm = await webVotes(page);
check('можно голосовать за недоступный узел: портрет на орбите, отряд на месте', await flag(page, P.p2) === far && gm.votes[far]?.length === 1 && (await mapNow()).currentNodeId === here, far);
await f.shot('votes-3b-web-far');
await clickWeb(p2.page, far);

const hovered = await p2.page.evaluate(id => {
    const app = foundry.applications.instances.get('gachadnd-web-overlay'), node = app.stage.nodes.get(id);
    node.node.emit('pointerover', {});
    const tip = app.element.querySelector('.gd-wo-tip')?.textContent ?? '';
    node.node.emit('pointerout', {});
    return tip;
}, a);
check('подсказка узла называет выбравших', /Выбрали: GD-тест: Лира/.test(hovered), hovered);

// Первый щелчок Мастера — всё так же выбор кристалла, а не голос
await clickWeb(page, a);
check('Мастер не голосует: его щелчок только выбирает кристалл', await ev(() => !game.user.getFlag('gachadnd', 'mapVote')) && (await mapNow()).currentNodeId === here);
await ev(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

await stepGM(a);
await wait(800);
gm = await webVotes(page);
const moved = await webVotes(p1.page);
check('шаг отряда гасит голоса у всех, флаг чистить не нужно', !Object.keys(gm.votes).length && !gm.orbits && !gm.layer && !Object.keys(moved.votes).length && await flag(page, P.p1) === a, JSON.stringify({ gm, moved }));

// ---------- Бумажные ряды
await draw('rows');
await wait(600);
for (const pg of [page, p1.page, p2.page]) await openMap(pg);
const entry = (await mapNow()).nodes.find(n => n.type === 'start').id;
await stepGM(entry);
await wait(600);
for (const w of [page, p1.page, p2.page]) await w.evaluate(() => foundry.applications.instances.get('gachadnd-map-terminal')?.render());
await wait(400);
m = await mapNow();
const next = m.nodes.find(n => n.id === m.currentNodeId).next;
const pre = (await mapNow()).currentNodeId;
await clickRow(p1.page, next[0]);
let rows = await rowVotes(page);
check('ряды: щелчок игрока — портрет с цветом и кольцо у всех', rows[next[0]]?.faces[0] === 'GD-тест: Лира|#e5484d' && rows[next[0]].arcs === 1 && rows[next[0]].img > 0 && (await mapNow()).currentNodeId === pre, JSON.stringify(rows));
await clickRow(p2.page, next[0]);
rows = await rowVotes(p1.page);
check('ряды: двое на одном узле — кольцо делится на два цвета', rows[next[0]]?.faces.length === 2 && rows[next[0]].arcs === 2, JSON.stringify(rows));
await f.shot('votes-4-rows-two');
await clickRow(p2.page, next[0]);
rows = await rowVotes(page);
check('ряды: повторный щелчок снимает голос', rows[next[0]]?.faces.length === 1, JSON.stringify(rows));
const farRow = m.nodes.find(n => n.id !== m.currentNodeId && !next.includes(n.id) && n.type !== 'start').id;
await clickRow(p2.page, farRow);
rows = await rowVotes(page);
check('ряды: можно голосовать за недоступный узел', rows[farRow]?.faces.length === 1 && (await mapNow()).currentNodeId === pre, farRow);
// Портрет новой картинки у самого голосующего: загрузился и показан в полный размер
const faceReady = await p2.page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#gachadnd-map-terminal .gd-vote-face img')];
    return imgs.length >= 2 && imgs.every(i => i.complete && i.naturalWidth > 0 && i.getAnimations().every(x => x.playState === 'finished') && i.getBoundingClientRect().width > 20);
}, null, { timeout: 8000 }).then(() => true, () => false);
check('ряды: портреты у голосующего загружены и видны', faceReady);
await p2.shot('votes-5-rows-far');
await clickRow(p2.page, m.currentNodeId);
rows = await rowVotes(page);
check('ряды: за узел под отрядом голосовать нельзя', !rows[m.currentNodeId] && rows[farRow]?.faces.length === 1, JSON.stringify(rows));

// Игрок вышел — его портрета на орбите нет
await p1.close();
await wait(1500);
rows = await rowVotes(page);
check('вышедший игрок исчезает с орбиты', !rows[next[0]], JSON.stringify(rows));

const errors = [...p2.log].filter(l => /gachadnd/i.test(l) && /error|ошибк/i.test(l));
check('ошибок модуля у игрока нет', !errors.length, errors.slice(0, 3).join(' | '));
const own = moduleErrors(f.log.slice(since));
check('ошибок модуля у Мастера нет', !own.length, own.slice(0, 3).join(' | '));

// Уборка
await p3.close(); await p2.close();
await ev(async ({ P, saved }) => {
    for (const w of [...foundry.applications.instances.values()]) if (/gachadnd-(map-terminal|web-overlay)/.test(w.id)) await w.close({ instant: true });
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
    await game.users.get(P.p1)?.update({ character: null, color: P.colors.p1, 'flags.gachadnd.mapVote': null });
    await game.users.get(P.p2)?.update({ character: null, color: P.colors.p2, 'flags.gachadnd.mapVote': null });
    for (const id of [P.lira, P.bork]) await game.actors.get(id)?.delete();
    await game.users.getName('GD-тест: зритель')?.delete();
    for (const [k, v] of Object.entries(saved)) await game.settings.set('gachadnd', k, v);
}, { P, saved });
const failed = summary();
await f.close().catch(() => {});
done(failed);
