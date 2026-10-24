// Генератор арен (прототип) в настоящей Foundry: node tools/foundry/arena.mjs [--headed]
// Планировка → картинка → сцена «Арена»: фон, стены, «живая муть», токены; пять настроений — снимки.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
const ids = await scene(page, { hero: { level: 3 }, enemies: [{ name: 'Враг', x: 9, y: 5 }, { name: 'Враг 2', x: 9, y: 6 }] });
const since = f.log.length;
const back = await ev(() => canvas.scene.id);

const lightOf = {};
let nightInfo = null, dayInfo = null;
for (const mood of ['day', 'night', 'fog', 'rot', 'blood']) {
    const r = await ev(async ({ mood, hero, enemies }) => {
        const t0 = performance.now();
        const { scene, plan } = await game.gachadnd.arena.generate({ seed: 'proto', mood, party: [hero], enemies });
        await new Promise(r => setTimeout(r, 2500));
        const src = scene.background?.src ?? scene.levels?.contents?.[0]?.background?.src;
        // Что на самом деле нарисовано: картинки арены в текстурах холста (второй бой подряд не должен идти на старой)
        const drawn = new Set();
        const walk = o => {
            const t = o?.texture, u = t?.source?.resource?.src ?? t?.source?.label ?? t?.baseTexture?.resource?.src ?? t?.baseTexture?.cacheId;
            if (typeof u === 'string' && u.includes('gachadnd-arena')) drawn.add(u.split('/').pop().split('?')[0]);
            for (const c of o?.children ?? []) walk(c);
        };
        walk(canvas.stage);
        return {
            env: `${scene.environment.darknessLevel}/${scene.environment.globalLight.enabled ? 'общий свет' : 'без общего'}`,
            murk: scene.lights.filter(l => l.config.animation?.type === 'ghost').length,
            // Доля круга, которую источник реально освещает (стены режут): запертый в кольце даёт почти ноль
            lit: scene.lights.map(l => {
                const pts = (l.object?.lightSource ?? l.object?.source)?.shape?.points ?? [];
                let area = 0;
                for (let i = 0; i < pts.length; i += 2) { const j = (i + 2) % pts.length; area += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]; }
                const r = (l.config.dim / 5) * 140;
                return Math.round((Math.abs(area) / 2 / (Math.PI * r * r)) * 100) / 100;
            }),
            drawn: [...drawn],
            ms: Math.round(performance.now() - t0), viewed: canvas.scene?.id === scene.id, src,
            walls: scene.walls.size, lights: scene.lights.size, tokens: scene.tokens.size, objects: plan.objects.length, cover: plan.cover,
            weather: scene.weather, size: `${scene.width}x${scene.height}`
        };
    }, { mood, hero: ids.hero, enemies: ids.enemies });
    check(`арена «${mood}»: нарисован фон этого настроения, стены, свет, отряд и враги на местах`, r.viewed && r.src?.endsWith(`arena-proto-${mood}.webp`) && r.drawn.length === 1 && r.drawn[0] === `arena-proto-${mood}.webp` && r.walls > 40 && r.lights > (mood === 'night' ? 0 : 3) && r.tokens === 3 && (mood !== 'fog' || r.weather === 'fog'), JSON.stringify(r));
    await ev(() => { if (game.paused) game.togglePause(false, { broadcast: true }); document.getElementById('pause')?.classList.remove('paused'); });
    await ev(() => { canvas.animatePan({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2, scale: Math.min(window.innerWidth / canvas.dimensions.sceneWidth, window.innerHeight / canvas.dimensions.sceneHeight) * 0.98, duration: 0 }); document.querySelectorAll('#notifications li, #notifications .notification').forEach(n => n.remove()); });
    // Большая картинка на программной отрисовке (swiftshader) встаёт на экран через 5–10 секунд после сборки
    await page.waitForTimeout(10000);
    // Яркость того, что на экране перед снимком: средний цвет нарисованной сцены
    if (mood === 'night') nightInfo = r;
    if (mood === 'day') dayInfo = r;
    lightOf[mood] = await ev(() => {
        const r = canvas.app.renderer, px = r.extract.pixels(canvas.stage), d = px.pixels ?? px, w = px.width ?? r.width, h = px.height ?? r.height;
        let sum = 0, n = 0;
        for (let y = Math.round(h * 0.15); y < h * 0.85; y += 9) for (let x = Math.round(w * 0.15); x < w * 0.75; x += 9) { const i = (y * w + x) * 4; sum += d[i] + d[i + 1] + d[i + 2]; n++; }
        return Math.round(sum / n / 3);
    });
    await f.shot(`arena-${mood}`);
}
// Пересборка подряд: на экране фон этого боя, а не прошлого — ночь темнее дня, следующий за ней туман светлее ночи
check('пересборка подряд: на экране фон этого боя — ночь темнее дня, туман светлее ночи', lightOf.night < lightOf.day * 0.85 && lightOf.fog > lightOf.night * 1.1, JSON.stringify(lightOf));

// Пять пересборок подряд на глазах у Мастера: подсветка регионов не залипает белыми лентами и кругами (обход v14)
const highlights = await ev(() => ({ visible: canvas.regions._highlights.children.filter(c => c.visible && c.renderable).length, meshes: canvas.regions._highlights.children.length, regions: canvas.regions.placeables.length }));
check('пересборки подряд: сирот подсветки регионов нет, видимых сеток нет', highlights.visible === 0, JSON.stringify(highlights));

// Ночь: темнота сцены без общего света, «мути» нет (она бы светила), светят костры, святилища и друзы
check('ночь — настоящая: темнота 0.6 без общего света, «живой мути» нет; светят три-пять друз (костёр потушен), стены их не запирают; днём — общий свет',
    nightInfo.env === '0.6/без общего' && nightInfo.murk === 0 && nightInfo.lights >= 3 && nightInfo.lit.every(a => a > 0.15) && dayInfo.env === '0/общий свет' && dayInfo.murk > 0, JSON.stringify({ nightInfo, dayInfo }));

// Лесистая арена (чаща) — листья фоном; ливень их сменяет, без погоды листья возвращаются
const leaves = await ev(async ({ hero }) => {
    const { applyWeather, clearWeather } = await gdt.mod('arena/weather.js');
    const { scene } = await game.gachadnd.arena.generate({ seed: 'leaf', mood: 'day', scheme: 'thicket', party: [hero], enemies: [], view: false });
    const out = { calm: scene.weather, flag: scene.getFlag('gachadnd', 'arena').leaves };
    await applyWeather(scene, 'rain', { seed: 'l' });
    out.rain = scene.weather;
    await clearWeather(scene);
    out.after = scene.weather;
    return out;
}, { hero: ids.hero });
check('лесистая арена: листья фоном; ливень их сменяет, после снятия погоды листья снова', leaves.calm === 'leaves' && leaves.flag && leaves.rain === 'rain' && leaves.after === 'leaves', JSON.stringify(leaves));

// Брод: ручей и камни брода — снимок воды крупно
const ford = await ev(async ({ hero, enemies }) => {
    const { scene, plan } = await game.gachadnd.arena.generate({ seed: 's1', mood: 'day', scheme: 'crossing', party: [hero], enemies });
    if (canvas.scene?.id !== scene.id) await scene.view();
    for (let i = 0; i < 40 && (canvas.scene?.id !== scene.id || !canvas.ready); i++) await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 2500));
    if (game.paused) game.togglePause(false, { broadcast: true });
    document.getElementById('pause')?.classList.remove('paused');
    const water = scene.lights.filter(l => l.config.animation?.type === 'fog');
    const p = plan.terrain.stream?.path[Math.floor((plan.terrain.stream?.path.length ?? 0) / 3)] ?? { x: 14, y: 10 };
    await canvas.animatePan({ x: p.x * 140, y: p.y * 140, scale: 1, duration: 0 });
    document.querySelectorAll('#notifications li, #notifications .notification').forEach(n => n.remove());
    // Трудная местность: регионы и цена шага поперёк ручья у героя
    const regions = Object.fromEntries(scene.regions.map(r => [r.getFlag('gachadnd', 'terrain'), { shapes: r.shapes.length, behavior: r.behaviors.contents[0]?.type, types: [...(r.behaviors.contents[0]?.system?.types ?? [])] }]));
    // Слой регионов открыт (как при шаблоне заклинания) — регионов местности не видно, они заперты
    canvas.regions.activate();
    await new Promise(r => setTimeout(r, 500));
    const shown = canvas.regions.placeables.filter(p => p.document.getFlag('gachadnd', 'terrain') && p.isVisible).length;
    canvas.tokens.activate();
    const mid = plan.terrain.stream.path[Math.floor(plan.terrain.stream.path.length / 2)];
    const inWater = scene.regions.find(r => r.getFlag('gachadnd', 'terrain') === 'water')?.testPoint({ x: mid.x * 140, y: mid.y * 140, elevation: 0 });
    const token = scene.tokens.find(t => t.actorId === hero)?.object;
    let walk = null;
    if (token) {
        const y = (Math.floor(mid.y)) * 140, x0 = (Math.floor(mid.x) - 3) * 140, x1 = (Math.floor(mid.x) + 3) * 140;
        // Местность в путь кладёт createTerrainMovementPath — как перетаскивание токена
        const m = token.measureMovementPath(token.createTerrainMovementPath([{ x: x0, y, elevation: 0 }, { x: x1, y, elevation: 0 }]));
        walk = { distance: Math.round(m.distance), cost: Math.round(m.cost) };
    }
    return { stream: !!plan.terrain.stream, water: water.length, regions, inWater, walk, shown };
}, { hero: ids.hero, enemies: ids.enemies });
check('брод: ручей есть, свет над водой не ставится', ford.stream && ford.water === 0, JSON.stringify(ford));
check('трудная местность: вода ручья и подлесок — регионы «Трудная местность» dnd5e (жидкость, растения); шаг поперёк ручья дороже расстояния; на открытом слое регионов их не видно',
    ford.regions.water?.behavior === 'dnd5e.difficultTerrain' && ford.regions.water.types.includes('liquid') && ford.regions.brush?.types.includes('plants') && ford.regions.brush.shapes > 5
    && ford.inWater && ford.walk && ford.walk.cost > ford.walk.distance && ford.shown === 0, JSON.stringify({ regions: ford.regions, inWater: ford.inWater, walk: ford.walk, shown: ford.shown }));
await page.waitForTimeout(1500);
await f.shot('arena-water');
// Топь: озерца болота — регион «Топь» (грязь), по кругу на озерцо
const mire = await ev(async ({ hero }) => {
    const { scene, plan } = await game.gachadnd.arena.generate({ seed: 's2', mood: 'day', scheme: 'swamp', party: [hero], enemies: [], view: false });
    const r = scene.regions.find(r => r.getFlag('gachadnd', 'terrain') === 'mire');
    return { pools: plan.terrain.pools.length, shapes: r?.shapes.length ?? 0, types: [...(r?.behaviors.contents[0]?.system?.types ?? [])] };
}, { hero: ids.hero });
check('топь: каждое озерцо болота — круг региона «Топь» (грязь)', mire.pools > 3 && mire.shapes === mire.pools && mire.types.includes('mud'), JSON.stringify(mire));
await ev(id => game.scenes.get(id)?.view(), back);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
