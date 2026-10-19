// Генератор арен (прототип) в настоящей Foundry: node tools/foundry/arena.mjs [--headed]
// Планировка → картинка → сцена «Арена»: фон, стены, «живая муть», токены; четыре настроения — снимки.
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

for (const mood of ['day', 'night', 'fog', 'rot']) {
    const r = await ev(async ({ mood, hero, enemies }) => {
        const t0 = performance.now();
        const { scene, plan } = await game.gachadnd.arena.generate({ seed: 'proto', mood, party: [hero], enemies });
        await new Promise(r => setTimeout(r, 2500));
        const src = scene.background?.src ?? scene.levels?.contents?.[0]?.background?.src;
        return {
            ms: Math.round(performance.now() - t0), viewed: canvas.scene?.id === scene.id, src,
            walls: scene.walls.size, lights: scene.lights.size, tokens: scene.tokens.size, objects: plan.objects.length, cover: plan.cover,
            weather: scene.weather, size: `${scene.width}x${scene.height}`
        };
    }, { mood, hero: ids.hero, enemies: ids.enemies });
    check(`арена «${mood}»: фон, стены, свет, отряд и враги на местах`, r.viewed && /arena-proto/.test(r.src ?? '') && r.walls > 40 && r.lights > 3 && r.tokens === 3 && (mood !== 'fog' || r.weather === 'fog'), JSON.stringify(r));
    await ev(() => { canvas.animatePan({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2, scale: Math.min(window.innerWidth / canvas.dimensions.sceneWidth, window.innerHeight / canvas.dimensions.sceneHeight) * 0.98, duration: 0 }); document.querySelectorAll('#notifications li, #notifications .notification').forEach(n => n.remove()); });
    await page.waitForTimeout(1500);
    await f.shot(`arena-${mood}`);
}
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
