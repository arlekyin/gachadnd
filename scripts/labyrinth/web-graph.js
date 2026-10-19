/**
 * Gacha Roguelike dnd5e — Паутина: построение сети (без Foundry — её же строит симулятор tools/sim/web.mjs)
 *
 * Сеть, как кровавая паутина: Босс в центре, вокруг — пояса узлов, разбросанных по углу и радиусу.
 *   внутренняя зона — пояса A (у Босса) и B; внешняя — пояса C и D (D — отростки по краю);
 *   Заставы — между зонами: единственный путь из внешней зоны во внутреннюю.
 * Связи — без пересечений: сначала остов, который связывает всё (случайный порядок рёбер), потом лишние
 * перемычки с вероятностью EXTRA. Остаются ветки, тупики и обходы. Координаты узлов (x, y — проценты
 * квадратного поля) хранятся в карте: рисунок одинаков у всех и при каждой перерисовке.
 */

export const WEB_SHAPE = {
    belts: [
        { tier: 'A', zone: 'inner', count: [5, 6], radius: 0.24 },
        { tier: 'B', zone: 'inner', count: [8, 9], radius: 0.46 },
        { tier: 'P', zone: 'outpost', count: [2, 3], radius: 0.62 },
        { tier: 'C', zone: 'outer', count: [10, 12], radius: 0.78 },
        { tier: 'D', zone: 'outer', count: [6, 8], radius: 0.95 }
    ],
    jitterAngle: 0.38,   // доля шага по углу
    jitterRadius: 0.05,
    minGap: 10.5,        // наименьшее расстояние между узлами, проценты поля: узлы не налезают друг на друга
    clear: 5.2,          // путь не проходит ближе этого к чужому узлу
    minAngle: 0.42,      // путям из одного узла — не меньше этого угла между собой (радианы): не слипаются
    bossLinks: [3, 4],   // сколько узлов пояса A связаны с Боссом
    extra: 0.28          // доля лишних перемычек сверх остова (обходы)
};

const pick = (rand, [lo, hi]) => lo + Math.floor(rand() * (hi - lo + 1));

// Пересекаются ли отрезки ab и cd (общий конец — не пересечение)
function crosses(a, b, c, d) {
    if (a === c || a === d || b === c || b === d) return false;
    const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/**
 * Сеть этажа.
 * @param {() => number} rand   случайность (Math.random или с зерном)
 * @param {(zone: string, count: number) => string[]} types  содержимое узлов зоны: outer, inner
 * @returns {{ nodes: object[], rows: object[][] }} узлы { id, zone, tier, type, x, y, next: [] }
 */
export function buildWeb(rand, types, shape = WEB_SHAPE) {
    const nodes = [];
    const boss = { id: 'boss', zone: 'boss', ring: 'boss', tier: 'X', type: 'boss', x: 50, y: 50, next: [] };
    const belts = shape.belts.map(belt => {
        const n = pick(rand, belt.count);
        const turn = rand() * Math.PI * 2;
        return Array.from({ length: n }, (_, i) => {
            const a = turn + (i + (rand() - 0.5) * 2 * shape.jitterAngle) * (Math.PI * 2 / n);
            const r = belt.radius + (rand() - 0.5) * 2 * shape.jitterRadius;
            const node = { id: `${belt.tier.toLowerCase()}${i}`, zone: belt.zone, ring: belt.zone, tier: belt.tier, angle: a, x: 50 + 50 * r * Math.cos(a), y: 50 + 50 * r * Math.sin(a), next: [] };
            nodes.push(node);
            return node;
        }).sort((p, q) => p.angle - q.angle);
    });
    nodes.push(boss);
    const [A, B, P, C, D] = belts;
    // Расталкивание: пары ближе minGap расходятся, Босс стоит на месте, все — внутри круга поля
    for (let round = 0; round < 40; round++) {
        let moved = false;
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
            const p = nodes[i], q = nodes[j];
            const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 0.01;
            if (d >= shape.minGap) continue;
            moved = true;
            const push = (shape.minGap - d) / 2, ux = dx / d, uy = dy / d;
            if (p !== boss) { p.x -= ux * push * (q === boss ? 2 : 1); p.y -= uy * push * (q === boss ? 2 : 1); }
            if (q !== boss) { q.x += ux * push * (p === boss ? 2 : 1); q.y += uy * push * (p === boss ? 2 : 1); }
        }
        for (const n of nodes) {
            const r = Math.hypot(n.x - 50, n.y - 50);
            if (r > 48) { n.x = 50 + (n.x - 50) * 48 / r; n.y = 50 + (n.y - 50) * 48 / r; }
            n.angle = Math.atan2(n.y - 50, n.x - 50);
        }
        if (!moved) break;
    }
    for (const belt of belts) belt.sort((p, q) => p.angle - q.angle);

    // Кандидаты рёбер: соседи по поясу и ближайшие по углу в соседнем поясе. Внешняя зона во внутреннюю — только через Заставы
    const angleGap = (p, q) => Math.abs(Math.atan2(Math.sin(p.angle - q.angle), Math.cos(p.angle - q.angle)));
    const nearest = (node, belt, k) => [...belt].sort((p, q) => angleGap(node, p) - angleGap(node, q)).slice(0, k);
    const candidates = [];
    const add = (p, q) => { if (p !== q && !candidates.some(([u, v]) => (u === p && v === q) || (u === q && v === p))) candidates.push([p, q]); };
    for (const belt of [A, B, C]) belt.forEach((n, i) => add(n, belt[(i + 1) % belt.length]));
    // Пояс D — отростки по краю: между собой связаны лишь изредка, чаще — тупик на одной связи
    D.forEach((n, i) => { if (rand() < 0.35) add(n, D[(i + 1) % D.length]); });
    for (const n of A) nearest(n, B, 2).forEach(m => add(n, m));
    for (const n of D) nearest(n, C, 1).forEach(m => add(n, m));
    for (const p of P) { nearest(p, B, 2).forEach(m => add(p, m)); nearest(p, C, 2).forEach(m => add(p, m)); }
    const toBoss = nearest({ angle: rand() * Math.PI * 2 }, A, A.length).slice(0, Math.min(A.length, pick(rand, shape.bossLinks)));

    // Остов: рёбра в случайном порядке, без пересечений, пока всё не связано (системой непересекающихся множеств)
    const parent = new Map(nodes.map(n => [n, n]));
    const root = n => (parent.get(n) === n ? n : root(parent.get(n)));
    const edges = [];
    // Путь годится: не пересекает другие, не идёт вплотную к чужому узлу и не слипается с путями из своих концов
    const segDist = (n, p, q) => {
        const dx = q.x - p.x, dy = q.y - p.y, len = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((n.x - p.x) * dx + (n.y - p.y) * dy) / len));
        return Math.hypot(n.x - (p.x + t * dx), n.y - (p.y + t * dy));
    };
    const spread = (at, to) => edges.every(([u, v]) => {
        const other = u === at ? v : v === at ? u : null;
        if (!other) return true;
        const a = Math.atan2(to.y - at.y, to.x - at.x), b = Math.atan2(other.y - at.y, other.x - at.x);
        return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) >= shape.minAngle;
    });
    const free = (p, q) => !edges.some(([u, v]) => crosses(p, q, u, v))
        && nodes.every(n => n === p || n === q || segDist(n, p, q) >= shape.clear)
        && spread(p, q) && spread(q, p);
    const link = (p, q) => { edges.push([p, q]); p.next.push(q.id); q.next.push(p.id); };
    for (const a of toBoss) { link(boss, a); parent.set(root(a), root(boss)); }
    const order = candidates.map(e => [rand(), e]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const rest = [];
    for (const [p, q] of order) {
        if (root(p) !== root(q) && free(p, q)) { link(p, q); parent.set(root(p), root(q)); } else rest.push([p, q]);
    }
    // Заставы должны вести внутрь и наружу
    for (const p of P) {
        if (!p.next.some(id => id.startsWith('b'))) { const m = nearest(p, B, 3).find(m => free(p, m)); if (m) link(p, m); }
        if (!p.next.some(id => id.startsWith('c'))) { const m = nearest(p, C, 3).find(m => free(p, m)); if (m) link(p, m); }
    }
    // Лишние перемычки — обходы; часть узлов так и останется тупиками
    for (const [p, q] of rest) {
        if (!p.next.includes(q.id) && rand() < shape.extra && free(p, q)) link(p, q);
    }

    // Содержимое узлов
    const outerTypes = types('outer', C.length + D.length);
    const innerTypes = types('inner', A.length + B.length);
    [...C, ...D].forEach((n, i) => { n.type = outerTypes[i]; });
    [...A, ...B].forEach((n, i) => { n.type = innerTypes[i]; });
    P.forEach(n => { n.type = 'outpost'; });

    for (const n of nodes) { n.x = Math.round(n.x * 100) / 100; n.y = Math.round(n.y * 100) / 100; delete n.angle; }
    return { nodes, rows: [[...D, ...C], P, [...B, ...A], [boss]] };
}

/**
 * Сеть, где всё связано с Боссом: построение повторяется, пока не выйдет (обычно с первого раза)
 */
export function buildConnectedWeb(rand, types, shape = WEB_SHAPE) {
    let web = null;
    for (let attempt = 0; attempt < 30; attempt++) {
        web = buildWeb(rand, types, shape);
        if (connected(web.nodes) && !pockets(web.nodes)) return web;
    }
    return web;
}

/**
 * Карманы: узлы, до которых с края можно дойти только через Босса. Пожиратель Босса не трогает — в кармане он
 * отряд не достанет; такие сети генератор отбрасывает
 */
export function pockets(nodes) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const start = nodes.filter(n => n.ring === 'outer').map(n => n.id);
    const seen = new Set(start), queue = [...start];
    while (queue.length) for (const id of byId.get(queue.shift()).next) if (id !== 'boss' && !seen.has(id)) { seen.add(id); queue.push(id); }
    return nodes.filter(n => n.id !== 'boss' && !seen.has(n.id)).map(n => n.id).length;
}

/** Все узлы связаны с Боссом (проверка сети) */
export function connected(nodes) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const seen = new Set(['boss']);
    const queue = ['boss'];
    while (queue.length) for (const id of byId.get(queue.shift()).next) if (!seen.has(id)) { seen.add(id); queue.push(id); }
    return seen.size === nodes.length;
}

// ==========================================
// ХОД, ЧАСЫ ЭТАЖА, ПОЖИРАТЕЛЬ (правила паутины — общие для модуля и симулятора)
// ==========================================

/**
 * Числа подобраны прогоном tools/sim/web.mjs. CALM — тиков тишины, EVERY — тиков на ступень Босса,
 * TOUCH — через сколько тиков тронутый узел съедается, PAUSE — тишина после победы над Пожирателем,
 * RUN — сколько пройденных узлов подряд за один тик, SPREAD — сколько соседей Пожиратель трогает за шаг.
 */
export const WEB = { CALM: 12, EVERY: 2, TOUCH: 2, PAUSE: 4, RUN: 3, SPREAD: 1, STAGES: null };

/** Ступени Босса паутины: что даёт каждая (иконки на карте) */
export const BOSS_STAGES = [
    { id: 'muffle', icon: 'fa-volume-xmark', name: 'Глушитель', text: 'синергии самого частого тега отряда не действуют' },
    { id: 'sleepy', icon: 'fa-moon', name: 'Крайний спит', text: 'последний экипированный навык каждого спит, пока у Босса больше половины ПЗ' },
    { id: 'strong', icon: 'fa-heart-circle-plus', name: 'Окрепший', text: 'у Босса на четверть больше ПЗ' },
    { id: 'retinue', icon: 'fa-users', name: 'Свита', text: 'с Боссом выходит свита — двое приспешников' }
];

/** Ступени, которые Мастер оставил включёнными (WEB.STAGES — их id; null — все), по порядку */
export const activeStages = () => (WEB.STAGES ? BOSS_STAGES.filter(s => WEB.STAGES.includes(s.id)) : BOSS_STAGES);
export const webStage = ticks => Math.min(activeStages().length, ticks > WEB.CALM ? Math.floor((ticks - WEB.CALM) / WEB.EVERY) + 1 : 0);
/** Сколько тиков до следующей ступени (null — ступени кончились) */
export const ticksToNextStage = ticks => {
    const stage = webStage(ticks);
    if (stage >= activeStages().length) return null;
    return (stage === 0 ? WEB.CALM + 1 : WEB.CALM + stage * WEB.EVERY) - ticks;
};

const byId = (map, id) => map.nodes.find(n => n.id === id);
const eatenSet = map => new Set(map.web?.eaten ?? []);
const familiar = (map, id) => map.visitedNodes.includes(id) && !eatenSet(map).has(id);

/**
 * Куда отряд может шагнуть за один тик: { id: путь } — соседи текущего узла и узлы за цепочкой знакомых
 * троп (до RUN узлов). До выхода на карту — любой узел внешнего кольца.
 */
export function webMoves(map) {
    if (!map.currentNodeId) return Object.fromEntries(map.nodes.filter(n => n.ring === 'outer').map(n => [n.id, [n.id]]));
    const moves = {};
    const queue = [[map.currentNodeId]];
    while (queue.length) {
        const path = queue.shift();
        if (path.length > WEB.RUN) continue;
        const last = path.at(-1);
        // Дальше идти можно только из знакомого узла (или с места, где стоит отряд)
        if (path.length > 1 && !familiar(map, last)) continue;
        for (const next of byId(map, last).next) {
            if (path.includes(next)) continue;
            const route = [...path.slice(1), next];
            if (!moves[next] || moves[next].length > route.length) moves[next] = route;
            queue.push([...path, next]);
        }
    }
    delete moves[map.currentNodeId];
    return moves;
}

/** Кратчайшее расстояние по связям (в шагах) */
export function distance(map, from, to, blocked = null) {
    if (from === to) return 0;
    const seen = new Set([from]);
    let layer = [from], d = 0;
    while (layer.length) {
        d++;
        const next = [];
        for (const id of layer) for (const n of byId(map, id).next) {
            if (n === to) return d;
            if (!seen.has(n) && !blocked?.(n)) { seen.add(n); next.push(n); }
        }
        layer = next;
    }
    return Infinity;
}

/**
 * Куда Пожирателю нельзя ступить: узел Босса и Заставы, через которые отряд ещё не прошёл.
 * Застава, пройденная отрядом, больше не держит — Пожиратель идёт через неё и съедает её, как любой узел.
 */
export const sealed = (map, id) => {
    const node = byId(map, id);
    return node.ring === 'boss' || (node.ring === 'outpost' && !map.visitedNodes?.includes(id));
};
/** Путь Пожирателя: в обход запечатанных Застав и Босса */
export const devourerDistance = (map, from, to) => distance(map, from, to, id => id !== to && sealed(map, id));

export function nextStepToward(map, from, to) {
    let best = null, bestD = Infinity;
    for (const n of byId(map, from).next) {
        if (n !== to && sealed(map, n)) continue;
        const d = devourerDistance(map, n, to);
        if (d < bestD) { best = n; bestD = d; }
    }
    return best;
}

/** Скорость Пожирателя по Запаху отряда: Охота — 1, сильнее на 4 — 2, на 8 — 3 */
export const speedFor = (value, hunt) => (value >= hunt + 8 ? 3 : value >= hunt + 4 ? 2 : 1);

// Съесть можно всё, кроме Босса и запечатанных Застав
const canEat = (map, id) => !sealed(map, id);

/**
 * Тик часов этажа после шага отряда. Меняет карту и возвращает, что случилось:
 * { map, spawned, caught, moved: [id…], eaten: [id…], stage, staged }.
 * @param {object} map   карта (будет изменена)
 * @param {object} o     scent — Запах отряда { value, state }; hunt — порог Охоты этажа
 */
export function advanceWeb(map, { scent, hunt }) {
    const web = map.web;
    const before = webStage(web.ticks);
    web.ticks++;
    const result = { map, spawned: false, caught: false, moved: [], eaten: [], stage: webStage(web.ticks) };
    result.staged = result.stage > before;
    const eaten = eatenSet(map);
    const eat = id => { if (!eaten.has(id) && canEat(map, id)) { eaten.add(id); result.eaten.push(id); } };

    // Тронутые узлы дозревают, пока Пожиратель на карте
    // Тронутые — список пар [id, тиков до поедания]: флаг сцены сливает объекты, а список заменяется целиком
    const ripe = [];
    web.touched = (web.touched ?? []).filter(([id, left]) => {
        if (left > 1) return true;
        ripe.push(id);
        return false;
    }).map(([id, left]) => [id, left - 1]);
    if (web.devourer) ripe.forEach(eat);
    const party = map.currentNodeId;
    if (!web.devourer && web.ticks > web.pausedUntil && scent.state === 'hunt' && party) {
        // Выходит на самый дальний узел края, откуда есть путь к отряду (мимо запечатанных Застав)
        const reach = n => devourerDistance(map, n.id, party);
        // …и напротив отряда по кругу (не ближе 100°), чтобы было куда уйти; если таких нет — просто самый дальний
        const pn = byId(map, party), pa = Math.atan2(pn.y - 50, pn.x - 50);
        const apart = n => { const d = Math.abs(Math.atan2(Math.sin(Math.atan2(n.y - 50, n.x - 50) - pa), Math.cos(Math.atan2(n.y - 50, n.x - 50) - pa))); return d >= (100 * Math.PI) / 180; };
        const pool = map.nodes.filter(n => n.ring === 'outer' && n.id !== party && Number.isFinite(reach(n)));
        const far = (pool.some(apart) ? pool.filter(apart) : pool).sort((a, b) => reach(b) - reach(a))[0];
        if (far) { web.devourer = far.id; web.trail = [far.id]; result.spawned = true; eat(far.id); }
    } else if (web.devourer && party) {
        for (let s = 0; s < speedFor(scent.value, hunt); s++) {
            const step = nextStepToward(map, web.devourer, party);
            if (!step) break;
            stepOnto(map, step, eaten, eat);
            result.moved.push(step);
            if (step === party) { result.caught = true; break; }
        }
    }
    web.eaten = [...eaten];
    return result;
}

/** Пожиратель ступает на узел: съедает его и трогает соседей (не больше SPREAD, случайных) — съедятся через TOUCH */
function stepOnto(map, id, eaten, eat) {
    const web = map.web;
    web.devourer = id;
    web.trail = [...(web.trail ?? []), id];
    eat(id);
    const near = byId(map, id).next.filter(n => !eaten.has(n) && canEat(map, n) && !web.touched.some(([t]) => t === n));
    for (const n of near.sort(() => Math.random() - 0.5).slice(0, WEB.SPREAD)) web.touched.push([n, WEB.TOUCH]);
}

/**
 * Мастер ходит за Пожирателя: to — узел, куда поставить (выход на карту или прыжок; след с этого узла
 * начинается заново); без to — один шаг к отряду. Часы этажа не тикают. Возвращает { placed, moved, caught }.
 */
export function moveDevourer(map, to = null) {
    const web = map.web;
    web.touched ??= [];
    const eaten = eatenSet(map);
    const eat = id => { if (!eaten.has(id) && canEat(map, id)) eaten.add(id); };
    const result = { placed: null, moved: null, caught: false };
    if (to) {
        const jump = !web.devourer || !byId(map, web.devourer).next.includes(to);
        if (jump) web.trail = [];
        stepOnto(map, to, eaten, eat);
        result.placed = to;
    } else if (web.devourer && map.currentNodeId) {
        const step = nextStepToward(map, web.devourer, map.currentNodeId);
        if (step) { stepOnto(map, step, eaten, eat); result.moved = step; }
    }
    result.caught = !!web.devourer && web.devourer === map.currentNodeId;
    web.eaten = [...eaten];
    return result;
}

/** Пожиратель побеждён, откуплен или съел приманку: уходит с карты на PAUSE тиков */
export function devourerLeaves(map) {
    if (!map.web) return map;
    map.web.devourer = null;
    map.web.pausedUntil = map.web.ticks + WEB.PAUSE;
    map.web.touched = [];
    map.web.trail = [];
    return map;
}

/** Стадия предвестий по расстоянию до отряда: в шаг Пожирателя — 1, в два — 2, в три — 3 */
export function omenFor(map, speed) {
    const at = map.web?.devourer;
    if (!at || !map.currentNodeId) return 'off';
    const d = devourerDistance(map, at, map.currentNodeId);
    if (d <= speed) return '1';
    if (d <= speed * 2) return '2';
    if (d <= speed * 3) return '3';
    return 'off';
}

export const nodeOf = byId;
export const isEaten = (map, id) => eatenSet(map).has(id);

/** Тронутые узлы — множество id */
export const touchedSet = map => new Set((map.web?.touched ?? []).map(([id]) => id));
