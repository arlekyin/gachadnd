// Симулятор паутины (второй режим карты этажа, docs/web-map.md): node tools/sim/web.mjs [--runs 2000] [--floor 2]
// Монте-Карло без боя: сеть и правила — те же, что в модуле (scripts/labyrinth/web-graph.js). Отряд с разной
// жадностью (сколько новых узлов берёт сверх нужного) идёт к Заставе, затем к Боссу. Отчёт — средние по прогонам.
// Флаги: --calm 9 --every 2 — запас тишины и шаг ступени Босса (подставляются в WEB на время прогона)
import fs from 'node:fs';
import { buildConnectedWeb, WEB, webMoves, distance, advanceWeb, devourerLeaves, webStage, isEaten } from '../../scripts/labyrinth/web-graph.js';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const runs = arg('runs', 2000), floor = arg('floor', 2);
WEB.CALM = arg('calm', WEB.CALM);
WEB.EVERY = arg('every', WEB.EVERY);
WEB.PAUSE = arg('pause', WEB.PAUSE);
WEB.TOUCH = arg('touch', WEB.TOUCH);
WEB.SPREAD = arg('spread', WEB.SPREAD);
const HUNT = 6 + 3 * floor;
const GAIN = HUNT / 5;            // Охота примерно за 5 боёв: вес кристаллов растёт с этажом
const rnd = Math.random;

const types = (zone, n) => Array.from({ length: n }, () => (zone === 'inner' ? (rnd() < 0.75 ? 'mob' : 'event') : rnd() < 0.62 ? 'mob' : rnd() < 0.5 ? 'event' : 'shop'));

function simulate(greed) {
    const web = buildConnectedWeb(rnd, types);
    const map = { mode: 'web', ...web, currentNodeId: null, visitedNodes: [], web: { ticks: 0, devourer: null, pausedUntil: -1, eaten: [], touched: [] } };
    const node = id => map.nodes.find(n => n.id === id);
    let smell = 0, breaches = 0, fights = 0, inside = false, guard = 0;
    const needOuter = 3 + greed, needInner = 2 + Math.floor(greed / 2);
    const scent = () => ({ value: smell, state: smell >= HUNT ? 'hunt' : 'whisper' });

    while (map.currentNodeId !== 'boss' && guard++ < 120) {
        // Цель: новый узел своей зоны, Застава или Босс
        const zone = inside ? 'inner' : 'outer';
        const done = map.nodes.filter(n => n.zone === zone && map.visitedNodes.includes(n.id)).length;
        const fresh = map.nodes.filter(n => n.zone === zone && !map.visitedNodes.includes(n.id) && !isEaten(map, n.id));
        const at = map.currentNodeId;
        let goals;
        if (!at) goals = map.nodes.filter(n => n.zone === 'outer').map(n => n.id);
        else if (!inside && (done >= needOuter || !fresh.length)) goals = map.nodes.filter(n => n.zone === 'outpost').map(n => n.id);
        else if (inside && (done >= needInner || !fresh.length)) goals = ['boss'];
        else goals = fresh.map(n => n.id);
        const moves = webMoves(map);
        const far = id => Math.min(...goals.map(g => distance(map, id, g)));
        // Шаг, который ближе всего к цели; съеденного избегает, если можно
        const options = Object.keys(moves).map(id => ({ id, d: far(id) + (isEaten(map, id) ? 6 : 0) })).sort((a, b) => a.d - b.d || rnd() - 0.5);
        const step = options[0]?.id;
        if (!step) break;
        const fresh1 = !map.visitedNodes.includes(step);
        const eaten = isEaten(map, step);
        map.currentNodeId = step;
        if (fresh1) map.visitedNodes.push(step);
        if (node(step).zone === 'outpost') inside = true;
        if (fresh1 && !eaten) {
            const t = node(step).type;
            if (t === 'mob' || t === 'elite' || t === 'outpost' || t === 'boss') { fights++; smell += GAIN * (0.45 + rnd() * 1.1); }
            else if (t === 'event') smell += rnd() * 1.5;
        }
        const tick = advanceWeb(map, { scent: scent(), hunt: HUNT });
        // После прорыва отряд теряет кристаллы (Брюхо, Огрызки) и поглощает часть добычи — Запах вдвое ниже
        if (eaten || tick.caught) { breaches++; devourerLeaves(map); smell *= 0.5; }
    }
    const total = map.nodes.filter(n => n.zone === 'outer' || n.zone === 'inner').length;
    return { tick: map.web.ticks, fights, stage: webStage(map.web.ticks), breaches, eaten: map.web.eaten.length / total, nodes: map.nodes.length, reached: map.currentNodeId === 'boss' };
}

const lines = [];
const log = s => { lines.push(s); console.log(s); };
log(`Паутина: этаж ${floor} (Охота от ${HUNT}); запас тишины ${WEB.CALM}, ступень Босса за ${WEB.EVERY} тика; тронутый съедается через ${WEB.TOUCH}; пауза ${WEB.PAUSE}; знакомые тропы — ${WEB.RUN}; прогонов ${runs}`);
log('');
log('жадность | узлов | тиков | боёв | ступень Босса (0/1/2/3+)        | прорывов | съедено | дошли');
for (let greed = 0; greed <= 6; greed++) {
    const list = Array.from({ length: runs }, () => simulate(greed));
    const avg = k => list.reduce((s, r) => s + r[k], 0) / list.length;
    const share = f => `${Math.round(100 * list.filter(f).length / list.length)}%`.padStart(4);
    log(`${String(greed).padStart(8)} | ${avg('nodes').toFixed(0).padStart(5)} | ${avg('tick').toFixed(1).padStart(5)} | ${avg('fights').toFixed(1).padStart(4)} | ${avg('stage').toFixed(2)} (${share(r => r.stage === 0)} ${share(r => r.stage === 1)} ${share(r => r.stage === 2)} ${share(r => r.stage >= 3)}) | ${avg('breaches').toFixed(2).padStart(8)} | ${(100 * avg('eaten')).toFixed(0).padStart(6)}% | ${share(r => r.reached)}`);
}
fs.writeFileSync(new URL('./last-web.txt', import.meta.url), lines.join('\n') + '\n');
