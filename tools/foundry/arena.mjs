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
            drawn: [...drawn],
            ms: Math.round(performance.now() - t0), viewed: canvas.scene?.id === scene.id, src,
            walls: scene.walls.size, lights: scene.lights.size, tokens: scene.tokens.size, objects: plan.objects.length, cover: plan.cover,
            weather: scene.weather, size: `${scene.width}x${scene.height}`
        };
    }, { mood, hero: ids.hero, enemies: ids.enemies });
    check(`арена «${mood}»: нарисован фон этого настроения, стены, свет, отряд и враги на местах`, r.viewed && r.src?.endsWith(`arena-proto-${mood}.webp`) && r.drawn.length === 1 && r.drawn[0] === `arena-proto-${mood}.webp` && r.walls > 40 && r.lights > 3 && r.tokens === 3 && (mood !== 'fog' || r.weather === 'fog'), JSON.stringify(r));
    await ev(() => { if (game.paused) game.togglePause(false, { broadcast: true }); document.getElementById('pause')?.classList.remove('paused'); });
    await ev(() => { canvas.animatePan({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2, scale: Math.min(window.innerWidth / canvas.dimensions.sceneWidth, window.innerHeight / canvas.dimensions.sceneHeight) * 0.98, duration: 0 }); document.querySelectorAll('#notifications li, #notifications .notification').forEach(n => n.remove()); });
    // Большая картинка на программной отрисовке (swiftshader) встаёт на экран через 5–10 секунд после сборки
    await page.waitForTimeout(10000);
    // Яркость того, что на экране перед снимком: средний цвет нарисованной сцены
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
    return { stream: !!plan.terrain.stream, water: water.length };
}, { hero: ids.hero, enemies: ids.enemies });
check('брод: ручей есть, свет над водой не ставится', ford.stream && ford.water === 0, JSON.stringify(ford));
await page.waitForTimeout(1500);
await f.shot('arena-water');
await ev(id => game.scenes.get(id)?.view(), back);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
