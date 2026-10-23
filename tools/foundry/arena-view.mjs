// Арена глазами игрока: node tools/foundry/arena-view.mjs [--headed]
// Герой игрока на арене: днём деревья и камни не режут обзор в клочья (стволы, камни и кроны держат только шаг,
// крупное — ограниченный обзор); ночью без общего света видит тёмное зрение на свою дальность, без него — только
// освещённое друзами. Снимки экрана игрока: день, ночь с тёмным зрением, ночь без него.
import { connect, joinAs, checker, moduleErrors, done } from './harness.mjs';
import { install, scene } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
const ids = await scene(page, { hero: { level: 3 }, enemies: [] });
const since = f.log.length;
const back = await ev(() => game.scenes.active?.id ?? canvas.scene.id);
// Герой — у игрока
await ev(async hero => {
    const player = game.users.getName('Claude_player');
    await game.actors.get(hero).update({ [`ownership.${player.id}`]: 3 });
}, ids.hero);

// Арена: собрать у Мастера, сделать активной — игрок на ней
const build = mood => ev(async ({ hero, mood }) => {
    const { scene } = await game.gachadnd.arena.generate({ seed: 'view', mood, party: [hero], enemies: [] });
    await scene.activate();
    return scene.id;
}, { hero: ids.hero, mood });
// Зрение героя: тёмное зрение на дальность или без него. Дальность зрения токена dnd5e берёт из чувств персонажа
const sight = range => ev(async ({ hero, range }) => {
    await game.actors.get(hero).update({ 'system.attributes.senses.ranges.darkvision': range });
    const t = game.scenes.active.tokens.find(t => t.actorId === hero);
    await t.update({ sight: { enabled: true, range, visionMode: range ? 'darkvision' : 'basic' } });
}, { hero: ids.hero, range });

const player = await joinAs(f, 'Claude_player');
const pev = (fn, arg) => player.page.evaluate(fn, arg);
// Что видит игрок: площадь обзора (линия взгляда) и поля зрения героя — доли сцены и круга дальности
const view = sceneId => pev(async ({ sceneId, hero }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 80 && (canvas.scene?.id !== sceneId || !canvas.ready); i++) await sleep(250);
    await sleep(6000);
    // Окна поверх поля (настройка участника при первом входе) — закрыть
    for (const app of [...foundry.applications.instances.values()]) if (app.hasFrame && app.rendered) await app.close();
    const token = canvas.tokens.placeables.find(t => t.document.actorId === hero);
    token?.control({ releaseOthers: true });
    await sleep(1500);
    const area = poly => { const p = poly?.points ?? []; let a = 0; for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length; a += p[i] * p[j + 1] - p[j] * p[i + 1]; } return Math.abs(a) / 2; };
    const src = token?.vision;
    const inScene = (c, r) => {
        const r2 = d.sceneRect ?? { x: 0, y: 0, width: d.sceneWidth, height: d.sceneHeight };
        let n = 0, k = 0;
        for (let x = -r; x <= r; x += r / 30) for (let y = -r; y <= r; y += r / 30) if (x * x + y * y <= r * r) { k++; const px = c.x + x, py = c.y + y; if (px >= r2.x && px <= r2.x + r2.width && py >= r2.y && py <= r2.y + r2.height) n++; }
        return (Math.PI * r * r * n) / k;
    };
    const d = canvas.dimensions, range = (token.document.sight.range / d.distance) * d.size;
    await canvas.animatePan({ x: token.center.x + d.size * 6, y: token.center.y, scale: 0.55, duration: 0 });
    if (game.paused) document.getElementById('pause')?.classList.remove('paused');
    document.querySelectorAll('#notifications li, #notifications .notification').forEach(n => n.remove());
    return {
        los: Math.round((area(src?.los) / (d.sceneWidth * d.sceneHeight)) * 100) / 100,
        // Доля круга дальности внутри сцены, которую герой видит (у кромки половина круга — за краем)
        fov: range ? Math.round((area(src?.fov) / inScene(token.center, range)) * 100) / 100 : null,
        mode: token.document.sight.visionMode, range: token.document.sight.range
    };
}, { sceneId, hero: ids.hero });

// ---------- День: обзор открыт
let sceneId = await build('day');
await sight(0);
const day = await view(sceneId);
check('день: обзор героя — больше половины поля, деревья и камни не режут его в клочья', day.los >= 0.5, JSON.stringify(day));
await player.page.waitForTimeout(1500);
await player.shot('arena-view-day');

// ---------- Ночь: тёмное зрение 60 футов
sceneId = await build('night');
await sight(60);
const dark = await view(sceneId);
check('ночь с тёмным зрением 60 футов: видна большая часть круга дальности', dark.fov >= 0.8, JSON.stringify(dark));
await player.page.waitForTimeout(1500);
await player.shot('arena-view-night-darkvision');

// ---------- Ночь без тёмного зрения: только освещённое друзами
await sight(0);
await player.page.waitForTimeout(3000);
await player.shot('arena-view-night-plain');

// ---------- Уборка: герой — снова без игрока, активная сцена — как была
await ev(async ({ hero, back }) => {
    const player = game.users.getName('Claude_player');
    await game.actors.get(hero)?.update({ [`ownership.${player.id}`]: 0, 'system.attributes.senses.ranges.darkvision': 0 });
    await game.scenes.get(back)?.activate();
}, { hero: ids.hero, back });
await player.close();

const errors = moduleErrors(f.log.slice(since)).concat(moduleErrors(player.log));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
