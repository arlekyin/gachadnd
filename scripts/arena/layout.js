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
    vignette: { r: [2, 2], blocks: 'shape', cover: 'half' },
    stump: { r: [0.35, 0.45], blocks: 'all', cover: 'half' }
};

/**
 * Схемы планировки: у каждой своя тактика. Выбор — по узлу и врагам (pickScheme) или явно.
 * glade — поляна с ручьём; edge — опушка (лес с одной стороны, поле с другой — для стрелков);
 * thicket — чаща с прогалинами (короткий обзор, ближний бой); swamp — болото островами;
 * ruins — каменный двор в центре; crossing — широкий ручей с бродом-горлышком; hill — каменистый холм.
 */
export const SCHEMES = ['glade', 'edge', 'thicket', 'swamp', 'ruins', 'crossing', 'hill'];

export function pickScheme(R, encounter = {}) {
    const ranged = encounter.ranged ?? 0.3, node = encounter.node;
    const weights = { glade: 3, edge: 2 + ranged * 4, thicket: 2 + (1 - ranged) * 3, swamp: 2, ruins: node === 'boss' || node === 'outpost' ? 5 : 2, crossing: 2, hill: 2 + ranged * 2 };
    let t = R() * Object.values(weights).reduce((a, b) => a + b, 0);
    for (const [k, w] of Object.entries(weights)) if ((t -= w) <= 0) return k;
    return 'glade';
}

/**
 * Виньетки — нарисованные целиком маленькие сцены: «здесь что-то случилось». Размер — в клетках, препятствия —
 * в своих координатах от центра (круги [x, y, r] и прямоугольники [x, y, w, h]), свет — точки с цветом.
 * where: hero — центр интереса (средняя треть), side — у края; schemes — в каких схемах уместна.
 */
export const VIGNETTES = {
    campfire: { w: 4, h: 4, where: 'side', circles: [[0, 0, 0.45]], rects: [], lights: [{ x: 0, y: 0, dim: 6, bright: 2.5, color: '#ff9a3c', animation: 'torch' }] },
    wagon: { w: 5, h: 3, where: 'side', circles: [], rects: [[0, 0, 3.6, 1.6]], lights: [] },
    shrine: { w: 4, h: 4, where: 'hero', circles: [[0, 0, 1]], rects: [], lights: [{ x: 0, y: 0, dim: 8, bright: 2, color: '#2ee6d6', animation: 'pulse' }] },
    stones: { w: 6, h: 6, where: 'hero', circles: Array.from({ length: 7 }, (_, i) => [Math.cos((i / 7) * 6.283) * 2.3, Math.sin((i / 7) * 6.283) * 2.3, 0.4]), rects: [], lights: [] },
    statue: { w: 5, h: 3, where: 'hero', circles: [], rects: [[0, 0, 3.8, 1.3]], lights: [] },
    nest: { w: 4, h: 4, where: 'side', circles: [[0, 0, 1.2]], rects: [], lights: [] },
    bridge: { w: 2, h: 5, where: 'water', circles: [], rects: [], lights: [] }
};

export function layout({ cols = 28, rows = 20, seed = 'arena', biome = 'forest', encounter = {}, scheme = null, vignettes = Object.keys(VIGNETTES) } = {}) {
    const R = rng(`${seed}|${biome}`);
    scheme ??= pickScheme(R, encounter);
    const ranged = encounter.ranged ?? 0.3;          // доля стрелков: больше укрытий и длинных линий
    const objects = [];
    const zones = {
        party: { x0: 0, x1: 4, y0: rows * 0.2, y1: rows * 0.8 },
        enemies: { x0: cols - 4, x1: cols, y0: rows * 0.2, y1: rows * 0.8 }
    };
    const inZone = (x, y, pad = 0) => [zones.party, zones.enemies].some(z => x > z.x0 - pad && x < z.x1 + pad && y > z.y0 - pad && y < z.y1 + pad);

    // Тропа: от кромки отряда к кромке врагов, мягкими изгибами (в чаще и на болоте — извилистее)
    const wig = scheme === 'thicket' || scheme === 'swamp' ? 0.26 : 0.18;
    const pathPts = [{ x: -1, y: rows * R.range(0.38, 0.62) }];
    for (let i = 1; i <= 4; i++) pathPts.push({ x: (cols * i) / 5, y: Math.max(3, Math.min(rows - 3, pathPts.at(-1).y + R.range(-rows * wig, rows * wig))) });
    pathPts.push({ x: cols + 1, y: Math.max(3, Math.min(rows - 3, pathPts.at(-1).y + R.range(-2, 2))) });
    const path = smoothPath(pathPts);

    // Ручей: поперёк, через середину; на переправе — широкий, с бродом там, где его пересекает тропа
    let stream = null, ford = null;
    const streamChance = { glade: 0.85, edge: 0.35, thicket: 0.3, swamp: 0, ruins: 0.25, crossing: 1, hill: 0.2 }[scheme];
    if (biome === 'forest' && R() < streamChance) {
        const wide = scheme === 'crossing';
        const sx = cols * R.range(0.42, 0.58), pts = [{ x: sx + R.range(-3, 3), y: -1 }];
        for (let i = 1; i <= 4; i++) pts.push({ x: Math.max(7, Math.min(cols - 7, pts.at(-1).x + R.range(wide ? -2 : -3.5, wide ? 2 : 3.5))), y: (rows * i) / 5 });
        pts.push({ x: pts.at(-1).x + R.range(-2, 2), y: rows + 1 });
        stream = { path: smoothPath(pts), width: wide ? R.range(3, 4) : R.range(0.9, 1.5) };
        let best = Infinity;
        for (const p of stream.path) { const d = distToPath(path, p.x, p.y); if (d < best) { best = d; ford = { x: p.x, y: p.y }; } }
    }

    // Болото: озерца со рваным краем, между ними — островки суши
    const pools = [];
    if (scheme === 'swamp') {
        for (let tries = 0; tries < 400 && pools.length < R.int(7, 10); tries++) {
            const x = R.range(4, cols - 4), y = R.range(1, rows - 1), r = R.range(1.4, 3.4);
            if (inZone(x, y, r + 0.5) || pools.some(p => Math.hypot(p.x - x, p.y - y) < p.r + r - 0.8)) continue;
            pools.push({ x, y, r });
        }
    }
    const waterDist = (x, y) => Math.min(stream ? distToPath(stream.path, x, y) - stream.width / 2 : 99, ...pools.map(p => Math.hypot(p.x - x, p.y - y) - p.r), 99);

    // Пятна земли: лесная подстилка, камень, мох
    const patches = [];
    for (let i = 0; i < 5; i++) patches.push({ type: 'forest', x: R.range(0, cols), y: R.pick([R.range(-2, rows * 0.3), R.range(rows * 0.7, rows + 2)]), r: R.range(4, 7) });
    for (let i = 0; i < (scheme === 'hill' ? 1 : 3); i++) patches.push({ type: 'rock', x: R.range(cols * 0.25, cols * 0.75), y: R.range(2, rows - 2), r: R.range(1.5, 3) });
    for (let i = 0; i < 3; i++) patches.push({ type: 'moss', x: R.range(0, cols), y: R.range(0, rows), r: R.range(2, 4) });
    if (scheme === 'hill') patches.push({ type: 'rock', x: cols * R.range(0.42, 0.58), y: rows * R.range(0.4, 0.6), r: R.range(4.5, 6) });
    if (scheme === 'swamp') for (const p of pools) patches.push({ type: 'moss', x: p.x, y: p.y, r: p.r + 1.6 });

    const free = (x, y, r, extra = 0, { onPath = false } = {}) => {
        if (x < 0.4 || y < 0.4 || x > cols - 0.4 || y > rows - 0.4) return false;
        if (!onPath && distToPath(path, x, y) < 1.1 + r * 0.5 + extra) return false;
        if (waterDist(x, y) < r * 0.6 + 0.3 + extra) return false;
        return !objects.some(o => Math.hypot(o.x - x, o.y - y) < (o.r + r) * 0.85 + extra);
    };
    const place = (kind, x, y, extra = {}) => {
        const [a, b] = OBJECTS[kind].r;
        const o = { kind, x, y, r: extra.r ?? R.range(a, b), rot: R.range(0, Math.PI * 2), variant: R.int(1, 4), ...extra };
        objects.push(o);
        return o;
    };

    // Руины: на «руинах» — каменный двор в центре (стены с проломами, колонны по углам, плиты внутри);
    // в остальных — иногда одинокий угол стены
    if (scheme === 'ruins') {
        const w = R.int(8, 10), h = R.int(6, 7), cx = cols * R.range(0.45, 0.55), cy = rows * R.range(0.42, 0.58);
        const x0 = cx - w / 2, y0 = cy - h / 2;
        patches.push({ type: 'rock', x: cx, y: cy, r: Math.max(w, h) * 0.55 });
        const side = (ax, ay, bx, by) => {
            const len = Math.hypot(bx - ax, by - ay), n = Math.floor(len / 2), rot = Math.atan2(by - ay, bx - ax);
            for (let i = 0; i < n; i++) {
                const t0 = (i * 2) / len, sx = ax + (bx - ax) * t0, sy = ay + (by - ay) * t0, mx = sx + Math.cos(rot), my = sy + Math.sin(rot);
                if (distToPath(path, mx, my) < 1.4 || R() < 0.22) continue;          // пролом — где тропа и случайно
                objects.push({ kind: 'ruin', shape: 'I', x: sx, y: sy, r: 1, rot, len: 2, variant: R.int(1, 4) });
            }
        };
        side(x0, y0, x0 + w, y0); side(x0 + w, y0, x0 + w, y0 + h); side(x0 + w, y0 + h, x0, y0 + h); side(x0, y0 + h, x0, y0);
        for (const [px, py] of [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]) if (R() < 0.75) place('pillar', px, py);
        for (let i = 0; i < 3; i++) { const x = R.range(x0 + 1.5, x0 + w - 1.5), y = R.range(y0 + 1.5, y0 + h - 1.5); if (free(x, y, 0.5, 0.4)) place('pillar', x, y); }
    } else if (R() < (scheme === 'glade' ? 0.7 : 0.35)) {
        for (let tries = 0; tries < 40; tries++) {
            const x = R.range(cols * 0.3, cols * 0.7), y = R.range(3, rows - 3);
            if (!free(x, y, 2.4, 0.5) || inZone(x, y, 3)) continue;
            const rot = R.pick([0, Math.PI / 2, Math.PI, Math.PI * 1.5]);
            place('ruin', x, y, { r: 1.5, rot, len: R.int(3, 4), shape: 'L' });
            place('pillar', x + Math.cos(rot + 0.8) * 2.6, y + Math.sin(rot + 0.8) * 2.6);
            break;
        }
    }

    // Переправа: камни-ступени через брод
    if (scheme === 'crossing' && ford) {
        const i = stream.path.reduce((b, p, k) => (Math.hypot(p.x - ford.x, p.y - ford.y) < Math.hypot(stream.path[b].x - ford.x, stream.path[b].y - ford.y) ? k : b), 0);
        const q = stream.path[Math.min(stream.path.length - 1, i + 1)], dx = q.x - ford.x, dy = q.y - ford.y, l = Math.hypot(dx, dy) || 1;
        for (let t = -stream.width / 2 + 0.4; t <= stream.width / 2 - 0.3; t += 0.85) {
            for (const s of [-1.6, 1.6]) objects.push({ kind: 'rock', x: ford.x - (dy / l) * t + (dx / l) * s, y: ford.y + (dx / l) * t + (dy / l) * s, r: R.range(0.3, 0.42), rot: R.range(0, 6.28), variant: R.int(1, 4) });
        }
    }

    // Укрытия в средней трети: камни и валуны; стрелкам — больше; на холме — кольцом валунов вокруг вершины
    const coverWanted = Math.round((scheme === 'hill' ? 14 : scheme === 'thicket' ? 2 : 4) + ranged * 6);
    const top = patches.find(p => p.type === 'rock' && p.r > 4);
    for (let tries = 0, made = 0; tries < 1500 && made < coverWanted; tries++) {
        let x = R.range(cols * 0.25, cols * 0.75), y = R.range(1.5, rows - 1.5);
        if (top && R() < 0.7) { const a = R.range(0, 6.28), d = R.range(top.r * 0.5, top.r * 1.05); x = top.x + Math.cos(a) * d; y = top.y + Math.sin(a) * d; }
        const kind = R() < (scheme === 'hill' ? 0.55 : 0.35) ? 'boulder' : 'rock';
        const r = R.range(...OBJECTS[kind].r);
        if (!free(x, y, r, 0.6) || inZone(x, y, 1)) continue;
        place(kind, x, y, { r });
        made++;
    }

    // Виньетки: «герой» — в средней трети, ещё одна-две — у краёв; только из тех, что нарисованы
    const vfree = (x, y, w, h, onPath) => {
        if (x - w / 2 < 0.5 || y - h / 2 < 0.5 || x + w / 2 > cols - 0.5 || y + h / 2 > rows - 0.5 || inZone(x, y, Math.max(w, h) / 2 + 0.5)) return false;
        if (!onPath && distToPath(path, x, y) < Math.max(w, h) / 2 + 0.6) return false;
        if (waterDist(x, y) < Math.max(w, h) / 2) return false;
        return !objects.some(o => Math.abs(o.x - x) < w / 2 + o.r + 0.3 && Math.abs(o.y - y) < h / 2 + o.r + 0.3);
    };
    const vplace = (name, x, y) => objects.push({ kind: 'vignette', name, x, y, r: Math.max(VIGNETTES[name].w, VIGNETTES[name].h) / 2, w: VIGNETTES[name].w, h: VIGNETTES[name].h, rot: 0, variant: 1 });
    const avail = vignettes.filter(n => VIGNETTES[n]);
    // Мост — через ручей, где его пересекает тропа (вместо брода с камнями)
    if (avail.includes('bridge') && stream && ford && stream.width < 2.5 && R() < 0.6) vplace('bridge', ford.x, ford.y);
    const heroes = avail.filter(n => VIGNETTES[n].where === 'hero' && !(scheme === 'ruins' && n === 'stones'));
    if (heroes.length && scheme !== 'thicket') {
        const name = R.pick(heroes), v = VIGNETTES[name];
        for (let tries = 0; tries < 300; tries++) {
            const x = R.range(cols * 0.36, cols * 0.64), y = R.range(rows * 0.25, rows * 0.75);
            if (vfree(x, y, v.w, v.h)) { vplace(name, x, y); break; }
        }
    }
    const sides = avail.filter(n => VIGNETTES[n].where === 'side');
    for (let k = 0, want = R.int(1, 2); k < want && sides.length; k++) {
        const name = R.pick(sides), v = VIGNETTES[name];
        for (let tries = 0; tries < 300; tries++) {
            const x = R.range(cols * 0.18, cols * 0.82), y = R.pick([R.range(v.h / 2 + 0.6, rows * 0.32), R.range(rows * 0.68, rows - v.h / 2 - 0.6)]);
            if (vfree(x, y, v.w, v.h)) { vplace(name, x, y); break; }
        }
    }

    // Деревья: плотность — по схеме
    const groves = patches.filter(p => p.type === 'forest');
    const clearings = scheme === 'thicket' ? Array.from({ length: R.int(3, 4) }, () => ({ x: R.range(cols * 0.2, cols * 0.8), y: R.range(3, rows - 3), r: R.range(2.2, 3.4) })) : [];
    const forestTop = R() < 0.5, border = makeBorder(R, cols, rows);
    const density = (x, y) => {
        const edge = Math.min(y, rows - y) / (rows / 2), grove = groves.some(p => Math.hypot(p.x - x, p.y - y) < p.r);
        switch (scheme) {
            case 'edge': { const inForest = forestTop ? y < border(x) : y > border(x); return inForest ? 0.85 : 0.025; }
            case 'thicket': return clearings.some(c => Math.hypot(c.x - x, c.y - y) < c.r) ? 0.01 : 0.62;
            case 'swamp': return waterDist(x, y) < 1.2 ? 0.05 : 0.22;
            case 'hill': return top && Math.hypot(top.x - x, top.y - y) < top.r + 1 ? 0.02 : 0.35 * (1 - edge) ** 1.2;
            case 'ruins': return 0.45 * (1 - edge) ** 1.4 + (grove ? 0.3 : 0);
            default: return grove ? 0.75 : 0.5 * (1 - edge) ** 1.6;
        }
    };
    const treeMix = scheme === 'swamp' ? [0.25, 0.3] : scheme === 'thicket' ? [0.55, 0.85] : [0.62, 0.75];
    for (let tries = 0; tries < (scheme === 'thicket' ? 5000 : 1600); tries++) {
        const x = R.range(0, cols), y = R.range(0, rows);
        if (R() > density(x, y)) continue;
        const kind = R() < treeMix[0] ? 'tree' : R() < treeMix[1] ? 'pine' : 'deadtree';
        const r = R.range(...OBJECTS[kind].r);
        if (!free(x, y, r * (scheme === 'thicket' ? 0.55 : 0.75)) || inZone(x, y, 0.5)) continue;
        place(kind, x, y, { r });
    }
    // Кусты и пни, бревно-другое (в чаще кустов вдвое больше)
    const bushes = Math.round(((scheme === 'thicket' ? 2 : 1) * cols * rows) / 26);
    for (let tries = 0, made = 0; tries < 800 && made < bushes; tries++) {
        const x = R.range(0, cols), y = R.range(0, rows), kind = R() < 0.85 ? 'bush' : 'stump';
        const r = R.range(...OBJECTS[kind].r);
        if (!free(x, y, r) || inZone(x, y, 0)) continue;
        place(kind, x, y, { r }); made++;
    }
    for (let tries = 0, made = 0; tries < 200 && made < R.int(1, scheme === 'thicket' ? 5 : 3); tries++) {
        const x = R.range(cols * 0.15, cols * 0.85), y = R.range(2, rows - 2), r = R.range(...OBJECTS.log.r);
        if (!free(x, y, r, 0.3) || inZone(x, y, 1)) continue;
        place('log', x, y, { r }); made++;
    }
    // Камыш по берегам, кувшинки на воде
    const shore = [];
    if (stream) stream.path.forEach((p, i) => {
        const q = stream.path[Math.min(stream.path.length - 1, i + 1)], dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
        shore.push({ p, nx: -dy / l, ny: dx / l, w: stream.width / 2 });
    });
    for (const pool of pools) for (let a = 0; a < 6.28; a += 0.35) shore.push({ p: { x: pool.x, y: pool.y }, nx: Math.cos(a), ny: Math.sin(a), w: pool.r, pool: true });
    for (const s of shore) {
        if (R() < (s.pool ? 0.32 : 0.16) && (!ford || Math.hypot(s.p.x - ford.x, s.p.y - ford.y) > 2.5)) {
            const side = s.pool ? 1 : R() < 0.5 ? -1 : 1, off = s.w + R.range(0.1, 0.5);
            objects.push({ kind: 'reeds', x: s.p.x + s.nx * off * side, y: s.p.y + s.ny * off * side, r: R.range(...OBJECTS.reeds.r), rot: R.range(0, 6.28), variant: R.int(1, 3) });
        }
        if (R() < (s.pool ? 0.12 : 0.06)) {
            const d = s.pool ? R.range(0, s.w - 0.5) : 0;
            objects.push({ kind: 'lilypad', x: s.p.x + s.nx * d + R.range(-0.3, 0.3), y: s.p.y + s.ny * d + R.range(-0.3, 0.3), r: R.range(...OBJECTS.lilypad.r), rot: R.range(0, 6.28), variant: R.int(1, 3) });
        }
    }
    // Кристаллы Тумана — одна-две друзы
    for (let tries = 0, made = 0; tries < 200 && made < R.int(1, 2); tries++) {
        const x = R.range(2, cols - 2), y = R.range(2, rows - 2), r = R.range(...OBJECTS.crystal.r);
        if (!free(x, y, r, 0.4) || inZone(x, y, 1)) continue;
        place('crystal', x, y, { r }); made++;
    }

    const cover = objects.filter(o => OBJECTS[o.kind].cover !== 'none' && o.x > cols / 3 && o.x < (cols * 2) / 3).length;
    return { cols, rows, seed, biome, scheme, terrain: { path, stream, ford, pools, patches }, objects, zones, cover };
}

/** Граница опушки: волнистая линия поперёк арены (y от x) */
function makeBorder(R, cols, rows) {
    const base = rows * R.range(0.4, 0.55), a1 = R.range(1, 2.5), a2 = R.range(0.5, 1.5), f1 = R.range(0.15, 0.3), f2 = R.range(0.4, 0.7), p = R.range(0, 6.28);
    return x => base + Math.sin(x * f1 + p) * a1 + Math.sin(x * f2 + p * 2) * a2;
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
        if (b === 'shape') {
            const v = VIGNETTES[o.name];
            for (let y = Math.floor(o.y - o.h / 2); y <= Math.floor(o.y + o.h / 2); y++) for (let x = Math.floor(o.x - o.w / 2); x <= Math.floor(o.x + o.w / 2); x++) {
                if (y < 0 || x < 0 || y >= rows || x >= cols) continue;
                const lx = x + 0.5 - o.x, ly = y + 0.5 - o.y;
                if (v.circles.some(([cx, cy, r]) => Math.hypot(lx - cx, ly - cy) < r + 0.15) || v.rects.some(([cx, cy, w, h]) => Math.abs(lx - cx) < w / 2 && Math.abs(ly - cy) < h / 2)) grid[y][x] = false;
            }
            continue;
        }
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
