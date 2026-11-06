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

const lightOf = {}, srcOf = {};
let nightInfo = null, dayInfo = null;
// Пробуждение Босса — ступени 2 (без пепла) и 4 (пепельная пелена); файл фона несёт ступень
for (const [mood, stage] of [['day'], ['night'], ['fog'], ['rot'], ['blood', 2], ['blood', 4]]) {
    const look = `${mood}${stage ?? ''}`;
    const r = await ev(async ({ mood, stage, hero, enemies }) => {
        const t0 = performance.now();
        const { scene, plan } = await game.gachadnd.arena.generate({ seed: 'proto', mood, stage, party: [hero], enemies });
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
            weather: scene.weather, size: `${scene.width}x${scene.height}`, ash: scene.getFlag('gachadnd', 'arena').ash,
            pale: scene.tiles.find(t => t.getFlag('gachadnd', 'awaken'))?.texture.src ?? null,
            // Где бледная плитка на экране: прямоугольник сетки в координатах сцены — должен совпасть со сценой
            paleBox: (() => {
                const m = canvas.tiles.placeables.find(t => t.document.getFlag('gachadnd', 'awaken'))?.mesh;
                if (!m) return null;
                const b = m.getLocalBounds();
                return [m.x + b.x * m.scale.x, m.y + b.y * m.scale.y, b.width * m.scale.x, b.height * m.scale.y].map(Math.round).join(',');
            })(),
            flakes: canvas.weather?.weatherEffects?.children?.length ?? null
        };
    }, { mood, stage, hero: ids.hero, enemies: ids.enemies });
    // Пробуждение: фон — обычная картинка, бледная копия ступени — плиткой поверх
    const drawn = [`arena-proto-${mood}.webp`, ...(stage ? [`arena-proto-${look}.webp`] : [])];
    check(`арена «${look}»: нарисован фон этого настроения${stage ? ' и бледная плитка ступени' : ''}, стены, свет, отряд и враги на местах`, r.viewed && r.src?.endsWith(`arena-proto-${mood}.webp`) && (!stage || (r.pale?.endsWith(`arena-proto-${look}.webp`) && r.paleBox === `0,0,${3920},${2800}`)) && r.drawn.sort().join() === drawn.sort().join() && r.walls > 40 && r.lights > (mood === 'night' ? 0 : 3) && r.tokens === 3 && (mood !== 'fog' || r.weather === 'fog'), JSON.stringify(r));
    if (mood === 'blood') check(`пробуждение, ступень ${stage}: ${stage >= 3 ? 'пепельная пелена — погода сцены' : 'пепла ещё нет'}`, stage >= 3 ? r.weather === 'gachadndAsh4' && r.ash === 'gachadndAsh4' : !r.weather?.startsWith('gachadndAsh') && !r.ash, JSON.stringify({ weather: r.weather, ash: r.ash, flakes: r.flakes }));
    await ev(() => { if (game.paused) game.togglePause(false, { broadcast: true }); document.getElementById('pause')?.classList.remove('paused'); });
    await ev(() => { canvas.animatePan({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2, scale: Math.min(window.innerWidth / canvas.dimensions.sceneWidth, window.innerHeight / canvas.dimensions.sceneHeight) * 0.98, duration: 0 }); document.querySelectorAll('#notifications li, #notifications .notification').forEach(n => n.remove()); });
    // Большая картинка на программной отрисовке (swiftshader) встаёт на экран через 5–10 секунд после сборки
    await page.waitForTimeout(10000);
    // Яркость того, что на экране перед снимком: средний цвет нарисованной сцены
    if (mood === 'night') nightInfo = r;
    if (mood === 'day') dayInfo = r;
    srcOf[look] = r.pale ?? r.src;
    lightOf[look] = await ev(() => {
        const r = canvas.app.renderer, px = r.extract.pixels(canvas.stage), d = px.pixels ?? px, w = px.width ?? r.width, h = px.height ?? r.height;
        let sum = 0, n = 0;
        for (let y = Math.round(h * 0.15); y < h * 0.85; y += 9) for (let x = Math.round(w * 0.15); x < w * 0.75; x += 9) { const i = (y * w + x) * 4; sum += d[i] + d[i + 1] + d[i + 2]; n++; }
        return Math.round(sum / n / 3);
    });
    await f.shot(`arena-${look}`);
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

// Пепел пробуждения и погода боя: ливень его сменяет, после снятия погоды пепел снова; насыщенность картинки
// падает по ступеням (средняя насыщенность фона — по снимкам выше)
const ash = await ev(async ({ hero }) => {
    const { applyWeather, clearWeather } = await gdt.mod('arena/weather.js');
    const { scene } = await game.gachadnd.arena.generate({ seed: 'ash', mood: 'blood', stage: 3, party: [hero], enemies: [], view: false });
    const out = { calm: scene.weather, registered: ['gachadndAsh3', 'gachadndAsh4'].every(k => CONFIG.weatherEffects[k]?.effects?.length === 2) };
    await applyWeather(scene, 'rain', { seed: 'a' });
    out.rain = scene.weather;
    await clearWeather(scene);
    out.after = scene.weather;
    return out;
}, { hero: ids.hero });
check('пепел пробуждения — своя погода (хлопья и дымка); ливень его сменяет, после снятия погоды пепел снова', ash.registered && ash.calm === 'gachadndAsh3' && ash.rain === 'rain' && ash.after === 'gachadndAsh3', JSON.stringify(ash));
const sat = await ev(async srcOf => {
    const one = async src => {
        const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
        const c = document.createElement('canvas'); c.width = 200; c.height = Math.round(200 * img.height / img.width);
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        let s = 0; for (let i = 0; i < d.length; i += 4) { const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); s += mx ? (mx - mn) / mx : 0; }
        return Math.round(s / (d.length / 4) * 100) / 100;
    };
    return { day: await one(srcOf.day), blood2: await one(srcOf.blood2), blood4: await one(srcOf.blood4) };
}, srcOf);
check('пробуждение бледнит этаж по ступеням: насыщенность день > 2-я ступень > 4-я, но 4-я — не полное ч/б', sat.day > sat.blood2 && sat.blood2 > sat.blood4 && sat.blood4 > 0.03, JSON.stringify(sat));

// Прорыв Пожирателя на арену пробуждённого Босса: эффекты не складываются — бледность и пепел мягко сходят за
// катсцену (снимок посередине), потом их нет и в документах; погода — пустая
await ev(async ({ hero }) => {
    await game.gachadnd.arena.generate({ seed: 'proto', mood: 'blood', stage: 4, party: [hero], enemies: [] });
    await new Promise(r => setTimeout(r, 2500));
    if (game.paused) game.togglePause(false, { broadcast: true });
    document.getElementById('pause')?.classList.remove('paused');
    await canvas.animatePan({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2, scale: Math.min(window.innerWidth / canvas.dimensions.sceneWidth, window.innerHeight / canvas.dimensions.sceneHeight) * 0.98, duration: 0 });
    window.__gdHad = game.actors.filter(a => a.getFlag('gachadnd', 'creature') === 'devourer').map(a => a.id);
    // Луна натравила — предвестие и хроника не меняются
    window.__gdBreachDone = (await gdt.mod('labyrinth/breach.js')).startBreach({ ally: true, point: { x: canvas.dimensions.width * 0.6, y: canvas.dimensions.height / 2 } }).then(() => true);
}, { hero: ids.hero });
const sample = () => ev(() => {
    const tile = canvas.tiles.placeables.find(t => t.document.getFlag('gachadnd', 'awaken'));
    return { tile: tile ? Math.round(tile.mesh.alpha * 100) / 100 : null, ash: Math.round((canvas.weather?.weatherEffects?.children?.[0]?.alpha ?? -1) * 100) / 100 };
});
const before = await sample();
await page.waitForTimeout(2300);
const mid = await sample();
await f.shot('arena-breach-mid');
await ev(() => window.__gdBreachDone);
await page.waitForTimeout(1000);
const after = await ev(async () => {
    const scene = canvas.scene, arena = scene.getFlag('gachadnd', 'arena');
    const out = { tiles: scene.tiles.filter(t => t.getFlag('gachadnd', 'awaken')).length, weather: scene.weather, ash: arena.ash ?? null, stage: arena.stage ?? null, devourer: scene.tokens.some(t => t.actor?.getFlag('gachadnd', 'creature') === 'devourer') };
    // Пожиратель из компендиума, если его привёл прорыв, — убрать
    for (const a of game.actors.filter(a => a.getFlag('gachadnd', 'creature') === 'devourer' && !window.__gdHad.includes(a.id))) await a.delete();
    return out;
});
await f.shot('arena-breach-after');
check('прорыв на арене пробуждения: бледность и пепел сходят мягко — посередине катсцены полупрозрачны', before.tile === 1 && mid.tile > 0.05 && mid.tile < 0.95 && mid.ash < 0.95, JSON.stringify({ before, mid }));
check('после прорыва: бледной плитки и пепла нет, погода пустая, Пожиратель на поле', after.tiles === 0 && after.weather === '' && !after.ash && !after.stage && after.devourer, JSON.stringify(after));

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
