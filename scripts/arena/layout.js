/**
 * Генератор арен — планировка (без Foundry: её же гоняет проверка в Node)
 *
 * Сначала тактика, потом рисунок: тропа от кромки отряда к кромке врагов, ручей с бродом, укрытия в середине,
 * деревья по краям и перелескам, руины — стены и укрытие. Всё в клетках (дробные координаты). Из планировки
 * потом получаются и картинка (paint.js), и стены со светом (arena.js).
 *
 * layout({ cols, rows, seed, biome, encounter }) → { cols, rows, seed, terrain: { path, stream, ford, patches },
 *   objects: [{ kind, x, y, r, rot, variant }], zones: { party, enemies }, cover }
 */

/** Детерминированный генератор чисел (mulberry32) по строке-сиду */
export function rng(seed) {
    let h = 1779033703 ^ String(seed).length;
    for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    const next = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    next.range = (lo, hi) => lo + next() * (hi - lo);
    next.int = (lo, hi) => Math.floor(next.range(lo, hi + 1));
    next.pick = list => list[Math.floor(next() * list.length)];
    return next;
}

/** Плавная кривая через точки (Catmull-Rom) — шаг ~0.25 клетки */
export function smoothPath(points, step = 0.25) {
    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y), n = Math.max(2, Math.ceil(len / step));
        for (let k = 0; k < n; k++) {
            const t = k / n, t2 = t * t, t3 = t2 * t;
            const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
            out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
        }
    }
    out.push(points.at(-1));
    return out;
}

/** Расстояние от точки до ломаной (в клетках) */
export function distToPath(path, x, y) {
    let best = Infinity;
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
        best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
    }
    return best;
}

/** Размеры и свойства предметов (в клетках): радиус, препятствие для хода, укрытие */
export const OBJECTS = {
    tree: { r: [1.3, 1.9], blocks: 'trunk', cover: 'half' },
    pine: { r: [1.0, 1.4], blocks: 'trunk', cover: 'half' },
    deadtree: { r: [0.9, 1.3], blocks: 'trunk', cover: 'half' },
    bush: { r: [0.45, 0.6], blocks: 'none', cover: 'half' },
    reeds: { r: [0.35, 0.5], blocks: 'none', cover: 'none' },
    lilypad: { r: [0.25, 0.4], blocks: 'none', cover: 'none' },
    rock: { r: [0.45, 0.6], blocks: 'all', cover: 'half' },
    boulder: { r: [0.9, 1.2], blocks: 'all', cover: 'full' },
    log: { r: [1.2, 1.6], blocks: 'all', cover: 'half' },
    ruin: { r: [1.5, 1.5], blocks: 'all', cover: 'full' },
    pillar: { r: [0.45, 0.55], blocks: 'all', cover: 'full' },
    crystal: { r: [0.4, 0.55], blocks: 'none', cover: 'none' },
    stump: { r: [0.35, 0.45], blocks: 'all', cover: 'half' }
};

export function layout({ cols = 28, rows = 20, seed = 'arena', biome = 'forest', encounter = {} } = {}) {
    const R = rng(`${seed}|${biome}`);
    const ranged = encounter.ranged ?? 0.3;          // доля стрелков: больше укрытий и длинных линий
    const objects = [];
    const zones = {
        party: { x0: 0, x1: 4, y0: rows * 0.2, y1: rows * 0.8 },
        enemies: { x0: cols - 4, x1: cols, y0: rows * 0.2, y1: rows * 0.8 }
    };
    const inZone = (x, y, pad = 0) => [zones.party, zones.enemies].some(z => x > z.x0 - pad && x < z.x1 + pad && y > z.y0 - pad && y < z.y1 + pad);

    // Тропа: от кромки отряда к кромке врагов, мягкими изгибами
    const pathPts = [{ x: -1, y: rows * R.range(0.38, 0.62) }];
    for (let i = 1; i <= 4; i++) pathPts.push({ x: (cols * i) / 5, y: Math.max(3, Math.min(rows - 3, pathPts.at(-1).y + R.range(-rows * 0.18, rows * 0.18))) });
    pathPts.push({ x: cols + 1, y: Math.max(3, Math.min(rows - 3, pathPts.at(-1).y + R.range(-2, 2))) });
    const path = smoothPath(pathPts);

    // Ручей: поперёк, через середину, с изгибами; брод там, где его пересекает тропа
    let stream = null, ford = null;
    if (biome === 'forest' && R() < 0.85) {
        const sx = cols * R.range(0.42, 0.6), pts = [{ x: sx + R.range(-3, 3), y: -1 }];
        for (let i = 1; i <= 4; i++) pts.push({ x: Math.max(6, Math.min(cols - 6, pts.at(-1).x + R.range(-3.5, 3.5))), y: (rows * i) / 5 });
        pts.push({ x: pts.at(-1).x + R.range(-2, 2), y: rows + 1 });
        stream = { path: smoothPath(pts), width: R.range(0.9, 1.5) };
        let best = Infinity;
        for (const p of stream.path) { const d = distToPath(path, p.x, p.y); if (d < best) { best = d; ford = { x: p.x, y: p.y }; } }
    }

    // Пятна земли: лесная подстилка, грязь, камень — центры и радиусы, края рисует шум
    const patches = [];
    for (let i = 0; i < 5; i++) patches.push({ type: 'forest', x: R.range(0, cols), y: R.pick([R.range(-2, rows * 0.3), R.range(rows * 0.7, rows + 2)]), r: R.range(4, 7) });
    for (let i = 0; i < 3; i++) patches.push({ type: 'rock', x: R.range(cols * 0.25, cols * 0.75), y: R.range(2, rows - 2), r: R.range(1.5, 3) });
    for (let i = 0; i < 3; i++) patches.push({ type: 'moss', x: R.range(0, cols), y: R.range(0, rows), r: R.range(2, 4) });

    const free = (x, y, r, extra = 0) => {
        if (x < 0.4 || y < 0.4 || x > cols - 0.4 || y > rows - 0.4) return false;
        if (distToPath(path, x, y) < 1.1 + r * 0.5 + extra) return false;
        if (stream && distToPath(stream.path, x, y) < stream.width / 2 + r * 0.6 + 0.3 + extra) return false;
        return !objects.some(o => Math.hypot(o.x - x, o.y - y) < (o.r + r) * 0.85 + extra);
    };
    const place = (kind, x, y, extra = {}) => {
        const [a, b] = OBJECTS[kind].r;
        const o = { kind, x, y, r: extra.r ?? R.range(a, b), rot: R.range(0, Math.PI * 2), variant: R.int(1, 4), ...extra };
        objects.push(o);
        return o;
    };

    // Руины в середине — стены и полное укрытие (не всегда)
    if (R() < 0.7) {
        for (let tries = 0; tries < 40; tries++) {
            const x = R.range(cols * 0.3, cols * 0.7), y = R.range(3, rows - 3);
            if (!free(x, y, 2.4, 0.5) || inZone(x, y, 3)) continue;
            const rot = R.pick([0, Math.PI / 2, Math.PI, Math.PI * 1.5]);
            // L-образный угол: две стены и обломки
            place('ruin', x, y, { r: 1.5, rot, len: R.int(3, 4), shape: 'L' });
            place('pillar', x + Math.cos(rot + 0.8) * 2.6, y + Math.sin(rot + 0.8) * 2.6);
            break;
        }
    }

    // Укрытия в средней трети: камни и валуны; стрелкам — больше
    const coverWanted = Math.round(4 + ranged * 6);
    for (let tries = 0, made = 0; tries < 400 && made < coverWanted; tries++) {
        const x = R.range(cols * 0.25, cols * 0.75), y = R.range(1.5, rows - 1.5), kind = R() < 0.35 ? 'boulder' : 'rock';
        const r = R.range(...OBJECTS[kind].r);
        if (!free(x, y, r, 0.6) || inZone(x, y, 1)) continue;
        place(kind, x, y, { r });
        made++;
    }

    // Деревья: гуще у верхней и нижней кромки и в перелесках, поляна посередине
    for (let tries = 0; tries < 1400; tries++) {
        const x = R.range(0, cols), y = R.range(0, rows);
        const edge = Math.min(y, rows - y) / (rows / 2);                      // 0 у кромки, 1 в середине
        const grove = patches.filter(p => p.type === 'forest').some(p => Math.hypot(p.x - x, p.y - y) < p.r);
        const want = grove ? 0.75 : 0.5 * (1 - edge) ** 1.6;
        if (R() > want) continue;
        const kind = R() < 0.62 ? 'tree' : R() < 0.75 ? 'pine' : 'deadtree';
        const r = R.range(...OBJECTS[kind].r);
        if (!free(x, y, r * 0.75) || inZone(x, y, 0.5)) continue;
        place(kind, x, y, { r });
    }
    // Кусты и пни у деревьев, бревно-другое
    for (let tries = 0, made = 0; tries < 600 && made < Math.round(cols * rows / 26); tries++) {
        const x = R.range(0, cols), y = R.range(0, rows), kind = R() < 0.85 ? 'bush' : 'stump';
        const r = R.range(...OBJECTS[kind].r);
        if (!free(x, y, r) || inZone(x, y, 0)) continue;
        place(kind, x, y, { r }); made++;
    }
    for (let tries = 0, made = 0; tries < 200 && made < R.int(1, 3); tries++) {
        const x = R.range(cols * 0.15, cols * 0.85), y = R.range(2, rows - 2), r = R.range(...OBJECTS.log.r);
        if (!free(x, y, r, 0.3) || inZone(x, y, 1)) continue;
        place('log', x, y, { r }); made++;
    }
    // Камыш вдоль берегов, кувшинки на воде
    if (stream) {
        for (const p of stream.path) {
            if (R() < 0.16 && (!ford || Math.hypot(p.x - ford.x, p.y - ford.y) > 2)) {
                const side = R() < 0.5 ? -1 : 1, off = stream.width / 2 + R.range(0.1, 0.5);
                const i = stream.path.indexOf(p), q = stream.path[Math.min(stream.path.length - 1, i + 1)], dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
                objects.push({ kind: 'reeds', x: p.x - (dy / l) * off * side, y: p.y + (dx / l) * off * side, r: R.range(...OBJECTS.reeds.r), rot: R.range(0, 6.28), variant: R.int(1, 3) });
            }
            if (R() < 0.06) objects.push({ kind: 'lilypad', x: p.x + R.range(-0.3, 0.3), y: p.y + R.range(-0.3, 0.3), r: R.range(...OBJECTS.lilypad.r), rot: R.range(0, 6.28), variant: R.int(1, 3) });
        }
    }
    // Кристаллы Тумана — одна-две друзы
    for (let tries = 0, made = 0; tries < 200 && made < R.int(1, 2); tries++) {
        const x = R.range(2, cols - 2), y = R.range(2, rows - 2), r = R.range(...OBJECTS.crystal.r);
        if (!free(x, y, r, 0.4) || inZone(x, y, 1)) continue;
        place('crystal', x, y, { r }); made++;
    }

    // Укрытие в середине: сколько предметов с укрытием в средней трети
    const cover = objects.filter(o => OBJECTS[o.kind].cover !== 'none' && o.x > cols / 3 && o.x < (cols * 2) / 3).length;
    return { cols, rows, seed, biome, terrain: { path, stream, ford, patches }, objects, zones, cover };
}

/**
 * Проходимость: сетка клеток, где true — можно встать. Деревья — ствол, камни, руины — целиком.
 * Проверка: от кромки отряда есть путь к кромке врагов.
 */
export function passable(plan) {
    const { cols, rows, objects } = plan;
    const grid = Array.from({ length: rows }, () => Array(cols).fill(true));
    for (const o of objects) {
        const b = OBJECTS[o.kind].blocks;
        if (b === 'none') continue;
        const r = b === 'trunk' ? 0.3 : o.r * 0.8;
        for (let y = Math.floor(o.y - r); y <= Math.floor(o.y + r); y++) for (let x = Math.floor(o.x - r); x <= Math.floor(o.x + r); x++) {
            if (y < 0 || x < 0 || y >= rows || x >= cols) continue;
            if (Math.hypot(x + 0.5 - o.x, y + 0.5 - o.y) < r + 0.2) grid[y][x] = false;
        }
    }
    return grid;
}

export function connected(plan) {
    const grid = passable(plan);
    const { cols, rows, zones } = plan;
    const seen = new Set(), queue = [];
    for (let y = Math.ceil(zones.party.y0); y < zones.party.y1; y++) if (grid[y]?.[0]) { queue.push([0, y]); seen.add(`0,${y}`); }
    while (queue.length) {
        const [x, y] = queue.shift();
        if (x >= cols - 1 && y >= zones.enemies.y0 && y < zones.enemies.y1) return true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen.has(k) || !grid[ny][nx]) continue;
            seen.add(k); queue.push([nx, ny]);
        }
    }
    return false;
}

/** Стартовые клетки: отряд — у левой кромки, враги — у правой, на проходимых клетках */
export function startCells(plan, side, count) {
    const grid = passable(plan), z = plan.zones[side], cells = [];
    for (let x = Math.floor(z.x0); x < z.x1; x++) for (let y = Math.ceil(z.y0); y < z.y1; y++) if (grid[y]?.[x]) cells.push({ x, y });
    // От центра зоны наружу
    const cy = (z.y0 + z.y1) / 2, cx = side === 'party' ? 1 : plan.cols - 2;
    return cells.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy)).slice(0, count);
}
