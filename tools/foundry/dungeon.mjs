// Арены подземелья (катакомбы) в настоящей Foundry: node tools/foundry/dungeon.mjs [--headed] [--only=hall,gate]
// Каждая схема: картинка, стены по краю пола, двери Foundry (открытые, закрытые, запертые, тайные; решётка —
// видно насквозь), провал и завал — регионы, факелы, отряд и враги на кромках; темнота полная и условная — снимки.
import { connect, checker, moduleErrors, done, args } from './harness.mjs';
import { install, scene } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const only = args().only?.split(',');

await install(page);
const ids = await scene(page, { hero: { level: 3 }, enemies: [{ name: 'Враг', x: 9, y: 5 }, { name: 'Враг 2', x: 9, y: 6 }] });
const since = f.log.length;
const back = await ev(() => canvas.scene.id);
const saved = await ev(() => game.settings.get('gachadnd', 'dungeonDark'));

// Схема → узел (размер арены как у встречи) и темнота для снимка
const CASES = [
    ['hall', 'elite', 'full'], ['corridors', 'mob', 'cond'], ['rooms', 'mob', 'cond'], ['crypt', 'elite', 'full'],
    ['chasm', 'elite', 'cond'], ['sanctum', 'boss', 'full'], ['gate', 'outpost', 'full'], ['hall', 'elite', 'cond']
].filter(([s]) => !only || only.includes(s));
const SIZE = { mob: [24, 18], elite: [28, 20], outpost: [28, 20], boss: [30, 22] };

for (const [scheme, node, dark] of CASES) {
    const r = await ev(async ({ scheme, node, dark, hero, enemies, SIZE }) => {
        await game.settings.set('gachadnd', 'dungeonDark', dark);
        const [cols, rows] = SIZE[node];
        const { scene, plan } = await game.gachadnd.arena.generate({ seed: 'dng', biome: 'crypt', scheme, cols, rows, encounter: { node }, party: [hero], enemies });
        await new Promise(r => setTimeout(r, 1500));
        const doors = {};
        for (const w of scene.walls) if (w.door) { const k = w.door === 2 ? 'тайная' : ['закрытая', 'открытая', 'запертая'][w.ds]; doors[k] = (doors[k] ?? 0) + 1; }
        const see = scene.walls.filter(w => w.door === 1 && w.sight === 0).length;
        const regions = Object.fromEntries(scene.regions.map(g => [g.getFlag('gachadnd', 'terrain'), { shapes: g.shapes.length, behaviors: g.behaviors.map(b => b.type) }]));
        // Токены — на полу, не в породе и не на дверях
        const C = canvas.grid.size, bad = scene.tokens.filter(t => { const x = Math.floor(t.x / C), y = Math.floor(t.y / C); return ![1, 4, 5].includes(plan.get(x, y)) || plan.doorAt(x, y); }).length;
        const party = scene.tokens.filter(t => t.actorId === hero), foes = scene.tokens.filter(t => t.actorId !== hero);
        return {
            viewed: canvas.scene?.id === scene.id, scheme: plan.scheme, dark: plan.dark, env: `${scene.environment.darknessLevel}/${scene.environment.globalLight.enabled ? 'общий свет' : 'без общего'}`,
            walls: scene.walls.size, doors, see, regions, lights: scene.lights.size, tokens: scene.tokens.size, bad,
            sides: party.every(p => foes.every(e => p.x < e.x)), note: plan.note, props: plan.props.length
        };
    }, { scheme, node, dark, hero: ids.hero, enemies: ids.enemies, SIZE });
    const name = `${scheme}-${dark}`;
    check(`${name}: сцена — эта схема и темнота (${r.env})`, r.viewed && r.scheme === scheme && r.dark === dark
        && (dark === 'full' ? r.env === '1/без общего' : r.env === '0.6/общий свет'), JSON.stringify({ scheme: r.scheme, dark: r.dark, env: r.env }));
    check(`${name}: стены по краю пола, факелы светят`, r.walls > 30 && r.lights > 2, JSON.stringify({ walls: r.walls, lights: r.lights }));
    check(`${name}: отряд и враги на полу, отряд — западнее врагов`, r.tokens === 3 && r.bad === 0 && r.sides, JSON.stringify({ tokens: r.tokens, bad: r.bad, sides: r.sides }));
    if (scheme === 'gate') check(`${name}: решётка — дверь, сквозь которую видно; обход — через запертую дверь`, r.see >= 1 && r.doors['запертая'] >= 1, JSON.stringify({ doors: r.doors, see: r.see }));
    if (scheme === 'rooms' || scheme === 'corridors') check(`${name}: двери Foundry`, Object.values(r.doors).reduce((a, b) => a + b, 0) >= 2, JSON.stringify(r.doors));
    if (scheme === 'chasm') check(`${name}: провал — регион без автоматики`, r.regions.chasm && r.regions.chasm.behaviors.length === 0, JSON.stringify(r.regions));
    if (scheme === 'gate' || scheme === 'corridors') check(`${name}: завал — трудная местность`, !r.regions.rubble || r.regions.rubble.behaviors.includes('dnd5e.difficultTerrain'), JSON.stringify(r.regions));
    console.log(`  ${name}: ${r.note}; двери ${JSON.stringify(r.doors)}; предметов арены ${r.props}`);
    await ev(() => { if (game.paused) game.togglePause(false, { broadcast: true }); document.getElementById('pause')?.classList.remove('paused'); });
    await ev(() => { canvas.animatePan({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2, scale: Math.min(window.innerWidth / canvas.dimensions.sceneWidth, window.innerHeight / canvas.dimensions.sceneHeight) * 0.98, duration: 0 }); document.querySelectorAll('#notifications li, #notifications .notification').forEach(n => n.remove()); });
    await page.waitForTimeout(9000);
    await f.shot(`dungeon-${name}`);
}

// Настройка «Темнота подземелий» по встрече: Монстры — условная
const auto = await ev(async ({ hero }) => {
    await game.settings.set('gachadnd', 'dungeonDark', 'auto');
    const { plan } = await game.gachadnd.arena.generate({ seed: 'dng2', biome: 'crypt', cols: 24, rows: 18, encounter: { node: 'mob' }, party: [hero], enemies: [], view: false });
    return plan.dark;
}, { hero: ids.hero });
check('темнота «по встрече»: у Монстров — условная', auto === 'cond', auto);

await ev(async ({ id, saved }) => { await game.settings.set('gachadnd', 'dungeonDark', saved); await game.scenes.get(id)?.view(); }, { id: back, saved });
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
