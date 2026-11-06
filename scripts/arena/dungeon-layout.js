/**
 * Генератор арен — планировка подземелья (катакомбы, docs/dungeon-floor.md). Без Foundry: её же гоняет макет
 * tools/mockups/dungeon (страница со схемами) и проверка в Node. План в клетках: порода и пол, двери четырёх видов,
 * предметы с укрытием, факелы и жаровни, кромки строев; тайники и предметы арены (pointsOfInterest).
 *
 * dungeon({ scheme, cols, rows, seed }) → {
 *   cols, rows, scheme, seed,
 *   cells: Uint8Array — ROCK, FLOOR, WATER, CHASM, RUBBLE, BRIDGE,
 *   doors: [{ x, y, orient: 'v'|'h', state: 'open'|'closed'|'locked'|'secret', wide?, kind? }],
 *   objects: [{ kind, x, y, w, h, cover: 'full'|'half'|null }],
 *   lights: [{ x, y, kind: 'torch'|'brazier'|'altar', r }],
 *   zones: { party: [[x, y]…], enemy: [[x, y]…] }, note, caches, props, objective?
 * }
 * Отряд всегда у западной кромки, враги — у восточной.
 */

import { t } from "../core/i18n.js";

export const ROCK = 0, FLOOR = 1, WATER = 2, CHASM = 3, RUBBLE = 4, BRIDGE = 5;

/** Детерминированный генератор (как rng в scripts/arena/layout.js) */
export function rng(seed) {
    let h = 1779033703 ^ String(seed).length;
    for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    const next = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    next.range = (lo, hi) => lo + next() * (hi - lo);
    next.int = (lo, hi) => Math.floor(next.range(lo, hi + 1));
    next.pick = list => list[Math.floor(next() * list.length)];
    next.chance = p => next() < p;
    return next;
}

export const SCHEMES = ['hall', 'corridors', 'rooms', 'crypt', 'chasm', 'sanctum', 'gate'];
/**
 * Схема по узлу и врагам: Застава — всегда застава, Босс — святилище (изредка склеп или зал); стрелков много —
 * чаще провал и зал (длинные линии), ближний бой — коридоры и комнаты
 */
export function pickScheme(R, { node, ranged = 0.3 } = {}) {
    if (node === 'outpost') return 'gate';
    if (node === 'boss') return R() < 0.7 ? 'sanctum' : R.pick(['crypt', 'hall']);
    const w = { hall: 3 + ranged * 2, corridors: 1 + (1 - ranged) * 3, rooms: node === 'mob' ? 4 : 2, crypt: 3, chasm: 1 + ranged * 3 };
    let x = R() * Object.values(w).reduce((a, b) => a + b, 0);
    for (const [k, v] of Object.entries(w)) if ((x -= v) <= 0) return k;
    return 'hall';
}

export const SCHEME_NAMES = { hall: t('зал с колоннами'), corridors: t('коридоры'), rooms: t('связка комнат'), crypt: t('склеп'), chasm: t('провал'), sanctum: t('святилище'), gate: t('застава') };

class Plan {
    constructor(cols, rows, scheme, seed) {
        Object.assign(this, { cols, rows, scheme, seed });
        this.cells = new Uint8Array(cols * rows);
        this.doors = []; this.objects = []; this.lights = []; this.rooms = [];
        this.zones = { party: [], enemy: [] };
        this.note = '';
        this.caches = []; this.props = [];
    }
    in(x, y) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }
    get(x, y) { return this.in(x, y) ? this.cells[y * this.cols + x] : ROCK; }
    set(x, y, v) { if (this.in(x, y)) this.cells[y * this.cols + x] = v; }
    rect(x, y, w, h, v = FLOOR) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, v); }
    open(x, y) { const c = this.get(x, y); return c === FLOOR || c === RUBBLE || c === BRIDGE || c === WATER; }
    room(x, y, w, h, purpose) { this.rect(x, y, w, h); const r = { x, y, w, h, purpose }; this.rooms.push(r); return r; }
    door(x, y, orient, state = 'closed', wide = false) {
        this.set(x, y, FLOOR); if (wide) this.set(orient === 'v' ? x : x + 1, orient === 'v' ? y + 1 : y, FLOOR);
        const d = { x, y, orient, state, wide }; this.doors.push(d); return d;
    }
    obj(kind, x, y, w = 1, h = 1, cover = null) { const o = { kind, x, y, w, h, cover: cover ?? COVER[kind] ?? null }; this.objects.push(o); return o; }
    /** Клетка занята предметом, который держит шаг (колонна, саркофаг…) */
    blocked(x, y) { return this.objects.some(o => BLOCKS[o.kind] && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h); }
    free(x, y, w = 1, h = 1) {
        for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (this.get(i, j) !== FLOOR || this.blocked(i, j) || this.doorAt(i, j)) return false;
        return true;
    }
    doorAt(x, y) { return this.doors.find(d => (d.x === x && d.y === y) || (d.wide && (d.orient === 'v' ? d.x === x && d.y + 1 === y : d.x + 1 === x && d.y === y))); }
    /** Стена у пола: клетка породы рядом с полом (для факелов) */
    wallNextTo(x, y) { return this.get(x, y) === ROCK && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => this.get(x + dx, y + dy) === FLOOR); }
}

/** Что держит шаг (остальное — только укрытие или ничего) */
const BLOCKS = { pillar: 1, 'pillar-broken': 1, sarcophagus: 1, statue: 1, altar: 1, crates: 1, table: 1, rack: 1, niche: 1, 'bone-pile': 0, rubble: 0, barricade: 0, brazier: 1, portcullis: 0, carpet: 0, dais: 0 };
const COVER = { pillar: 'full', 'pillar-broken': 'half', sarcophagus: 'half', statue: 'full', altar: 'half', crates: 'half', table: 'half', rack: 'half', rubble: 'half', barricade: 'half', brazier: 'half' };

/* ---------- Общие куски ---------- */

/** Ниши в длинных стенах комнаты: углубления 1 клетка в породу (где порода есть) */
function niches(P, r, R, { step = 4, kind = null, sides = ['n', 's'] } = {}) {
    for (const side of sides) {
        for (let x = r.x + 1 + R.int(0, 1); x < r.x + r.w - 1; x += step) {
            const y = side === 'n' ? r.y - 1 : r.y + r.h, beyond = side === 'n' ? y - 1 : y + 1;
            if (P.get(x, y) !== ROCK || P.get(x, beyond) !== ROCK || !P.in(x, beyond)) continue;
            P.set(x, y, FLOOR);
            if (kind) P.obj(kind, x, y, 1, 1, null);
        }
    }
}

/** Факелы по стенам комнаты: через каждые ~5 клеток периметра */
function torches(P, r, R, step = 5) {
    const spots = [];
    for (let x = r.x + 1; x < r.x + r.w - 1; x += step) { spots.push([x, r.y - 1]); spots.push([x, r.y + r.h]); }
    for (let y = r.y + 1; y < r.y + r.h - 1; y += step) { spots.push([r.x - 1, y]); spots.push([r.x + r.w, y]); }
    // Место занято нишей или проёмом — факел сдвигается вдоль стены на соседнюю клетку; стена — порода, а клетка
    // прямо перед ней — пол комнаты (не ниша)
    const ok = (x, y) => P.wallNextTo(x, y) && x >= r.x - 1 && x <= r.x + r.w && y >= r.y - 1 && y <= r.y + r.h
        && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => x + dx >= r.x && x + dx < r.x + r.w && y + dy >= r.y && y + dy < r.y + r.h && P.get(x + dx, y + dy) === FLOOR);
    for (const [x, y] of spots) {
        if (!R.chance(0.75)) continue;
        const horiz = y === r.y - 1 || y === r.y + r.h;
        const at = [0, 1, -1, 2, -2].map(d => horiz ? [x + d, y] : [x, y + d]).find(([cx, cy]) => ok(cx, cy) && !P.lights.some(l => l.x === cx && l.y === cy));
        if (at) P.lights.push({ x: at[0], y: at[1], kind: 'torch', r: 4 });
    }
}

/** Боковая комната за стеной: ищет место в породе рядом с комнатой r, ставит дверь */
function sideRoom(P, r, R, { state = 'closed', purpose = 'storage' } = {}) {
    for (let tries = 0; tries < 30; tries++) {
        const side = R.pick(['n', 's']), w = R.int(3, 5), h = R.int(2, 3);
        const x = R.int(r.x + 2, r.x + r.w - w - 2);
        const y = side === 'n' ? r.y - 1 - h : r.y + r.h + 1;
        if (y < 1 || y + h > P.rows - 1) continue;
        let clear = true;
        for (let j = y - 1; j <= y + h; j++) for (let i = x - 1; i <= x + w; i++) if (P.get(i, j) !== ROCK) clear = false;
        if (!clear) continue;
        const sr = P.room(x, y, w, h, purpose);
        const dx = R.int(x, x + w - 1), dy = side === 'n' ? r.y - 1 : r.y + r.h;
        P.door(dx, dy, 'h', state);
        furnish(P, sr, R);
        return sr;
    }
    return null;
}

/** Обстановка по назначению комнаты (storage, armory, guard, tomb — идентификаторы): мелочь у стен и в углах */
function furnish(P, r, R) {
    const corner = () => R.pick([[r.x, r.y], [r.x + r.w - 1, r.y], [r.x, r.y + r.h - 1], [r.x + r.w - 1, r.y + r.h - 1]]);
    if (r.purpose === 'storage') { for (let i = 0; i < 2; i++) { const [x, y] = corner(); if (P.free(x, y)) P.obj('crates', x, y, 1, 1, 'half'); } }
    if (r.purpose === 'armory') { const x = r.x + 1, y = r.y; if (P.free(x, y, 2, 1)) P.obj('rack', x, y, 2, 1, 'half'); }
    if (r.purpose === 'guard') { const x = r.x + Math.floor(r.w / 2) - 1, y = r.y + Math.floor(r.h / 2); if (P.free(x, y, 2, 1)) P.obj('table', x, y, 2, 1, 'half'); }
    if (r.purpose === 'tomb') { const [x, y] = corner(); if (P.free(x, y)) P.obj('bone-pile', x, y); }
}

/** Мелочь у стен: кости, обломки — без укрытия */
function clutter(P, R, n = 6) {
    for (let i = 0, tries = 0; i < n && tries < 200; tries++) {
        const x = R.int(1, P.cols - 2), y = R.int(1, P.rows - 2);
        if (!P.free(x, y)) continue;
        const nearWall = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => P.get(x + dx, y + dy) === ROCK);
        if (!nearWall) continue;
        P.obj(R.chance(0.5) ? 'bone-pile' : 'debris', x, y); i++;
    }
}

/** Кромки: отряд — западные клетки пола, враги — восточные */
function zones(P, depth = 4) {
    let minX = P.cols, maxX = 0;
    for (let y = 0; y < P.rows; y++) for (let x = 0; x < P.cols; x++) if (P.get(x, y) === FLOOR) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    for (let y = 0; y < P.rows; y++) for (let x = 0; x < P.cols; x++) {
        if (P.get(x, y) !== FLOOR || P.blocked(x, y) || P.doorAt(x, y)) continue;
        if (x < minX + depth) P.zones.party.push([x, y]);
        if (x > maxX - depth) P.zones.enemy.push([x, y]);
    }
}

/* ---------- Схемы ---------- */

/** Зал с колоннами: 2–3 ряда колонн, ниши, боковые комнаты */
function hall(P, R) {
    const r = P.room(2, 4, P.cols - 4, P.rows - 8, 'hall');
    const lines = R.int(2, 3), xs = [];
    const step = R.pick([3, 4]);
    for (let x = r.x + 3; x <= r.x + r.w - 4; x += step) xs.push(x);
    for (let i = 0; i < lines; i++) {
        const y = Math.round(r.y + (r.h - 1) * (i + 1) / (lines + 1));
        for (const x of xs) { if (R.chance(0.12)) continue; P.obj(R.chance(0.15) ? 'pillar-broken' : 'pillar', x, y, 1, 1, null); }
    }
    sideRoom(P, r, R, { purpose: R.pick(['storage', 'armory']) });
    sideRoom(P, r, R, { purpose: 'tomb' });
    niches(P, r, R, { step: 4 });
    torches(P, r, R);
    P.note = t('зал, рядов колонн: {lines}', { lines });
}

/** Коридоры: 2–3 коридора от комнаты отряда к комнате врагов, перемычки, ниши */
function corridors(P, R) {
    const left = P.room(1, 3, 5, P.rows - 6, 'entry'), right = P.room(P.cols - 6, 3, 5, P.rows - 6, 'hall');
    const n = R.int(2, 3), ys = [];
    for (let i = 0; i < n; i++) ys.push(Math.round(left.y + 1 + (left.h - 3) * (i + 0.5) / n + R.int(-1, 1)));
    const lanes = [];
    for (const [i, y0] of ys.entries()) {
        const w = R.chance(0.5) ? 2 : 3, x0 = left.x + left.w + 1, x1 = right.x - 2, jog = R.int(-2, 2), mid = R.int(x0 + 3, x1 - 3);
        P.rect(x0, y0, mid - x0 + 1, w); P.rect(mid, Math.min(y0, y0 + jog), w, Math.abs(jog) + w); P.rect(mid, y0 + jog, x1 - mid + 1, w);
        lanes.push({ y0, y1: y0 + jog, w, mid });
        // Двери у комнат: первый коридор открыт, остальные закрыты
        P.door(left.x + left.w, y0, 'v', i === 0 ? 'open' : 'closed', w >= 2);
        P.door(right.x - 1, y0 + jog, 'v', i === 0 ? 'open' : 'closed', w >= 2);
    }
    // Перемычки между соседними коридорами
    for (let i = 1; i < lanes.length; i++) {
        const x = R.int(10, P.cols - 12), a = lanes[i - 1], b = lanes[i];
        const ya = (x < a.mid ? a.y0 : a.y1) + a.w, yb = x < b.mid ? b.y0 : b.y1;
        if (yb > ya) P.rect(x, ya, 2, yb - ya);
    }
    for (const L of lanes) { const x = R.int(10, P.cols - 11), y = (x < L.mid ? L.y0 : L.y1) + R.int(0, L.w - 1); if (P.free(x, y)) { P.obj('rubble', x, y, 1, 1, 'half'); P.set(x, y, RUBBLE); } }
    for (const L of lanes) for (let x = 9; x < P.cols - 9; x += R.int(4, 6)) { const y = (x < L.mid ? L.y0 : L.y1) - 1; if (P.get(x, y) === ROCK && P.get(x, y - 1) === ROCK) { P.set(x, y, FLOOR); } }
    torches(P, left, R); torches(P, right, R);
    for (const L of lanes) for (let x = 8; x < P.cols - 8; x += 6) { const y = (x < L.mid ? L.y0 : L.y1) - 1; if (P.wallNextTo(x, y) && R.chance(0.6)) P.lights.push({ x, y, kind: 'torch', r: 4 }); }
    sideRoom(P, right, R, { purpose: 'guard' });
    P.note = t('коридоров: {n}', { n });
}

/** Связка комнат: разбиение прямоугольниками, двери по остовному дереву и петля */
function rooms(P, R) {
    const leaves = [];
    const split = (x, y, w, h, depth) => {
        // 3–5 комнат: не мельче 7×6
        const canV = w >= 14, canH = h >= 12;
        if (depth >= 3 || (!canV && !canH) || (depth >= 2 && R.chance(0.5))) { leaves.push({ x, y, w, h }); return; }
        const vert = canV && (!canH || w / h > 1.2 || R.chance(0.5));
        if (vert) { const s = R.int(7, w - 7); split(x, y, s, h, depth + 1); split(x + s, y, w - s, h, depth + 1); }
        else { const s = R.int(6, h - 6); split(x, y, w, s, depth + 1); split(x, y + s, w, h - s, depth + 1); }
    };
    split(1, 1, P.cols - 1, P.rows - 1, 0);
    const purposes = ['storage', 'armory', 'guard', 'tomb'];
    const rs = leaves.map(l => P.room(l.x + 1, l.y + 1, l.w - 1, l.h - 1, R.pick(purposes)));
    // Соседи по общей стене: возможные двери
    const links = [];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        if (a.x + a.w + 1 === b.x || b.x + b.w + 1 === a.x) {
            const y0 = Math.max(a.y, b.y), y1 = Math.min(a.y + a.h, b.y + b.h) - 1;
            if (y1 - y0 >= 1) links.push({ i, j, x: a.x + a.w === b.x - 1 ? a.x + a.w : b.x + b.w, y: R.int(y0, y1), orient: 'v' });
        }
        if (a.y + a.h + 1 === b.y || b.y + b.h + 1 === a.y) {
            const x0 = Math.max(a.x, b.x), x1 = Math.min(a.x + a.w, b.x + b.w) - 1;
            if (x1 - x0 >= 1) links.push({ i, j, y: a.y + a.h === b.y - 1 ? a.y + a.h : b.y + b.h, x: R.int(x0, x1), orient: 'h' });
        }
    }
    // Остов (случайный порядок, объединение множеств) и 1–2 лишние двери — петля
    const parent = rs.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const order = links.map(l => [R(), l]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const used = [], spare = [];
    for (const l of order) { const a = find(l.i), b = find(l.j); if (a !== b) { parent[a] = b; used.push(l); } else spare.push(l); }
    for (const l of used) P.door(l.x, l.y, l.orient, 'closed');
    // Петля: лишние двери по одной, пока у отряда не будет двух путей (или кончатся)
    for (const l of spare) {
        zones(P); const a = audit(P); P.zones = { party: [], enemy: [] };
        if (a.ok && a.loop) break;
        P.door(l.x, l.y, l.orient, 'closed');
    }
    for (const r of rs) furnish(P, r, R);
    // Укрытия внутри комнат: 1–3 на комнату, не у дверей (проход не перекрыт)
    const nearDoor = (x, y) => P.doors.some(d => Math.abs(d.x - x) + Math.abs(d.y - y) <= 2);
    for (const r of rs) for (let i = 0, n = R.int(1, 3), tries = 0; i < n && tries < 30; tries++) {
        const x = R.int(r.x + 1, r.x + r.w - 2), y = R.int(r.y + 1, r.y + r.h - 2);
        if (!P.free(x, y) || nearDoor(x, y)) continue;
        const kind = R.pick(['crates', 'rubble', 'pillar', 'pillar-broken']);
        P.obj(kind, x, y, 1, 1, null); if (kind === 'rubble') P.set(x, y, RUBBLE); i++;
    }
    for (const r of rs) torches(P, r, R, 6);
    P.note = t('комнат: {n}', { n: rs.length });
}

/** Склеп: ряды саркофагов, ниши-лежанки по длинным стенам */
function crypt(P, R) {
    const r = P.room(2, 4, P.cols - 4, P.rows - 8, 'tomb');
    const cols = [];
    for (let x = r.x + 4; x <= r.x + r.w - 5; x += R.pick([3, 4])) cols.push(x);
    const rowsY = [r.y + 2, r.y + r.h - 4];
    if (r.h >= 12) rowsY.splice(1, 0, Math.round(r.y + r.h / 2 - 1));
    for (const y of rowsY) for (const x of cols) { if (R.chance(0.15)) continue; P.obj(R.chance(0.25) ? 'sarcophagus-open' : 'sarcophagus', x, y, 1, 2, 'half'); }
    sideRoom(P, r, R, { purpose: 'tomb' });
    niches(P, r, R, { step: 3, kind: 'niche' });
    for (const [x, y] of [[r.x + 1, r.y + 1], [r.x + r.w - 2, r.y + 1], [r.x + 1, r.y + r.h - 2], [r.x + r.w - 2, r.y + r.h - 2]]) if (R.chance(0.6)) P.obj('pillar', x, y, 1, 1, null);
    torches(P, r, R, 6);
    P.note = t('склеп: саркофагов {n}, ниши со скелетами', { n: P.objects.filter(o => o.kind.startsWith('sarcophagus')).length });
}

/** Провал поперёк зала: 1–2 моста, у мостов — укрытия */
function chasm(P, R) {
    const r = P.room(2, 4, P.cols - 4, P.rows - 8, 'hall');
    sideRoom(P, r, R, { purpose: 'storage' });
    const cx = Math.round(P.cols / 2 + R.int(-2, 2)), w = R.int(3, 4);
    // Карниз вдоль одной стены: провал не доходит до неё (узкий опасный обход)
    const bridges = R.int(1, 2);
    const ledge = bridges === 1 || R.chance(0.5) ? R.pick(['n', 's']) : null;
    let off = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
        if ((ledge === 'n' && y === r.y) || (ledge === 's' && y === r.y + r.h - 1)) continue;
        off = Math.max(-1, Math.min(1, off + R.int(-1, 1)));
        for (let x = cx + off; x < cx + off + w; x++) P.set(x, y, CHASM);
    }
    const ys = [];
    for (let i = 0; i < bridges; i++) ys.push(Math.round(r.y + 2 + (r.h - 5) * (bridges === 1 ? R.range(0.35, 0.65) : i ? R.range(0.65, 0.85) : R.range(0.15, 0.35))));
    for (const y of ys) {
        const bw = R.chance(0.5) ? 2 : 1;
        for (let x = cx - 2; x <= cx + w + 2; x++) for (let j = 0; j < bw; j++) if (P.get(x, y + j) === CHASM) P.set(x, y + j, BRIDGE);
        // Укрытия у мостов
        for (const sx of [cx - 3, cx + w + 2]) if (P.free(sx, y - 1)) P.obj(R.chance(0.5) ? 'rubble' : 'pillar-broken', sx, y - 1, 1, 1, 'half');
    }
    for (let i = 0; i < 4; i++) { const x = R.pick([R.int(r.x + 2, cx - 4), R.int(cx + w + 3, r.x + r.w - 3)]), y = R.int(r.y + 1, r.y + r.h - 2); if (P.free(x, y)) P.obj('pillar', x, y, 1, 1, null); }
    torches(P, r, R);
    P.note = bridges === 1 ? t('провал, один мост, карниз вдоль стены') : ledge ? t('провал, два моста, карниз вдоль стены') : t('провал, два моста');
}

/** Святилище (Босс): алтарь на возвышении у восточной стены, ковёр, колонны по бокам, жаровни */
function sanctum(P, R) {
    const r = P.room(2, 4, P.cols - 4, P.rows - 8, 'sanctum'), cy = r.y + Math.floor(r.h / 2);
    sideRoom(P, r, R, { purpose: R.pick(['armory', 'storage']) });
    sideRoom(P, r, R, { purpose: 'tomb' });
    const dw = R.int(4, 6);
    P.obj('dais', r.x + r.w - dw - 1, cy - 3, dw, 6, null);
    P.obj('altar', r.x + r.w - 3, cy - 1, 1, 2, 'half');
    if (R.chance(0.7)) P.obj('carpet', r.x + 1, cy - 1, r.w - dw - 2, 2, null);
    // Колонны по бокам: шаг, отступ от оси и обрушенные — свои у каждого святилища
    const step = R.pick([3, 4]), off = R.int(3, 4);
    for (let x = r.x + 3; x < r.x + r.w - dw - 2; x += step) for (const y of [cy - off, cy + off - 1]) {
        if (!P.free(x, y)) continue;
        if (R.chance(0.15)) { P.obj('rubble', x, y, 1, 1, 'half'); P.set(x, y, RUBBLE); }
        else P.obj(R.chance(0.12) ? 'pillar-broken' : 'pillar', x, y, 1, 1, null);
    }
    // Статуи-стражи у подхода к возвышению
    if (R.chance(0.6)) for (const y of [cy - 2, cy + 1]) if (P.free(r.x + r.w - dw - 3, y)) P.obj('statue', r.x + r.w - dw - 3, y, 1, 1, null);
    for (const y of [cy - 3, cy + 2]) { P.obj('brazier', r.x + r.w - 7, y, 1, 1, 'half'); P.lights.push({ x: r.x + r.w - 7, y, kind: 'brazier', r: 5 }); }
    P.lights.push({ x: r.x + r.w - 3, y: cy, kind: 'altar', r: 6 });
    niches(P, r, R, { step: 4, kind: R.chance(0.5) ? 'statue' : null });
    torches(P, r, R, 6);
    P.note = t('святилище: алтарь на возвышении, жаровни');
}

/** Застава: стена поперёк с решёткой и баррикадой, обход через запертую дверь, караульная за стеной */
function gate(P, R) {
    const wx = Math.round(P.cols / 2 + R.int(-2, 1));
    const yard = P.room(2, 3, wx - 2, P.rows - 6, 'yard');
    const guard = P.room(wx + 2, 3, P.cols - wx - 4, P.rows - 6, 'guard');
    const gy = R.int(yard.y + 3, yard.y + yard.h - 5);
    // Решётка: широкий проход в стене толщиной 2, решётка закрыта (поднимают)
    P.rect(wx, gy, 2, 2);
    P.door(wx, gy, 'v', 'closed', true).kind = 'portcullis';
    // Баррикада: второй проход, перекрыт завалом (укрытие, трудная местность)
    let by = gy > yard.y + yard.h / 2 ? R.int(yard.y + 1, gy - 4) : R.int(gy + 4, yard.y + yard.h - 2);
    P.rect(wx, by, 2, 2);
    P.obj('barricade', wx, by, 2, 2, 'half');
    for (let x = wx; x < wx + 2; x++) for (let y = by; y < by + 2; y++) P.set(x, y, RUBBLE);
    // Обход: коридор вокруг через запертую дверь
    const top = R.chance(0.5), cy = top ? 1 : P.rows - 2;
    P.rect(yard.x + 2, cy, guard.x + guard.w - yard.x - 4, 1);
    P.door(yard.x + 2, top ? yard.y - 1 : yard.y + yard.h, 'h', 'locked');
    P.door(guard.x + guard.w - 3, top ? guard.y - 1 : guard.y + guard.h, 'h', 'closed');
    for (let i = 0; i < 2; i++) { const x = R.int(guard.x + 1, guard.x + guard.w - 3), y = R.int(guard.y + 1, guard.y + guard.h - 2); if (P.free(x, y, 2, 1)) P.obj(i ? 'table' : 'rack', x, y, 2, 1, 'half'); }
    for (let i = 0; i < 3; i++) { const x = R.int(yard.x + 3, yard.x + yard.w - 2), y = R.int(yard.y + 1, yard.y + yard.h - 2); if (P.free(x, y)) P.obj(R.chance(0.5) ? 'crates' : 'rubble', x, y, 1, 1, 'half'); }
    // Бойницы: клетки стены, сквозь которые видно (Foundry: стена-окно)
    P.slits = [];
    for (let y = guard.y + 1; y < guard.y + guard.h - 1; y += 3) if (P.get(wx, y) === ROCK && P.get(wx + 1, y) === ROCK) P.slits.push({ x: wx, y });
    torches(P, yard, R, 6); torches(P, guard, R, 5);
    P.note = t('застава: решётка, баррикада, обход через запертую дверь');
}

const BUILD = { hall, corridors, rooms, crypt, chasm, sanctum, gate };

/* ---------- Сборка и проверки ---------- */

export function dungeon({ scheme = 'hall', cols = 28, rows = 20, seed = 'd' } = {}) {
    let P;
    // Пути от отряда к врагам нет — другой сид (как у леса)
    for (let i = 0; i < 20; i++) {
        const R = rng(`${seed}|${scheme}|${i}`);
        P = new Plan(cols, rows, scheme, seed);
        BUILD[scheme](P, R);
        clutter(P, R, 5);
        addSecretAndLocked(P, R);
        zones(P);
        P.lights = P.lights.filter((l, j, all) => all.findIndex(m => m.x === l.x && m.y === l.y) === j);
        // Хотя бы два пути между строями (кроме коридоров: там узость — и есть тактика)
        if (reach(P).ok && (scheme === 'corridors' || audit(P).loop)) break;
    }
    pointsOfInterest(P, rng(`${seed}|${scheme}|poi`));
    return P;
}

/**
 * Запертая и тайная двери: запертой становится закрытая дверь, без которой путь между строями остаётся;
 * тайная — новая короткая дверь сквозь тонкую стену между двумя частями (по возможности), не больше одной
 */
function addSecretAndLocked(P, R) {
    zones(P);
    const closed = P.doors.filter(d => d.state === 'closed' && d.kind !== 'portcullis');
    for (const d of closed.sort(() => R() - 0.5)) {
        if (P.doors.some(x => x.state === 'locked')) break;
        d.state = 'locked';
        if (!reach(P).ok) d.state = 'closed';
    }
    if (R.chance(0.55)) {
        // Тонкая стена: клетка породы между двумя клетками пола (по горизонтали или вертикали), не у кромок
        const spots = [];
        for (let y = 2; y < P.rows - 2; y++) for (let x = 6; x < P.cols - 6; x++) {
            if (P.get(x, y) !== ROCK) continue;
            if (P.get(x - 1, y) === FLOOR && P.get(x + 1, y) === FLOOR && P.get(x, y - 1) === ROCK && P.get(x, y + 1) === ROCK) spots.push([x, y, 'v']);
            if (P.get(x, y - 1) === FLOOR && P.get(x, y + 1) === FLOOR && P.get(x - 1, y) === ROCK && P.get(x + 1, y) === ROCK) spots.push([x, y, 'h']);
        }
        // Предпочесть ту, что даёт новый путь (сокращает обход), а не дверь между уже соседними клетками одной комнаты
        const scored = spots.map(([x, y, o]) => {
            const a = o === 'v' ? [x - 1, y] : [x, y - 1], b = o === 'v' ? [x + 1, y] : [x, y + 1];
            return { x, y, o, gain: walkDist(P, a, b) };
        }).filter(s => s.gain > 6).sort((p, q) => q.gain - p.gain);
        if (scored.length) { const s = scored[Math.min(scored.length - 1, R.int(0, 2))]; P.door(s.x, s.y, s.o, 'secret'); P.secretGain = s.gain; }
    }
    P.zones = { party: [], enemy: [] };
}

/** Проходима ли клетка: пол, завал, мост, вода; двери — кроме запертых и тайных (их надо найти или отпереть) */
function passable(P, x, y, { all = false } = {}) {
    if (!P.open(x, y) || P.blocked(x, y)) return false;
    const d = P.doorAt(x, y);
    return !d || all || (d.state !== 'locked' && d.state !== 'secret');
}

function bfs(P, starts, opts = {}) {
    const dist = new Int32Array(P.cols * P.rows).fill(-1), q = [];
    for (const [x, y] of starts) if (passable(P, x, y, opts)) { dist[y * P.cols + x] = 0; q.push([x, y]); }
    for (let i = 0; i < q.length; i++) {
        const [x, y] = q[i], d = dist[y * P.cols + x];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (!P.in(nx, ny) || dist[ny * P.cols + nx] >= 0 || !passable(P, nx, ny, opts) || (opts.skip && opts.skip(nx, ny))) continue;
            dist[ny * P.cols + nx] = d + 1; q.push([nx, ny]);
        }
    }
    return dist;
}
function walkDist(P, a, b) { const d = bfs(P, [a], { all: true })[b[1] * P.cols + b[0]]; return d < 0 ? 999 : d; }

/** Путь от отряда к врагам: есть ли, длина, и есть ли петля (нет одной клетки, без которой пути нет) */
export function reach(P) {
    const party = P.zones.party.length ? P.zones.party : [], enemy = P.zones.enemy;
    if (!party.length || !enemy.length) return { ok: false, dist: -1, loop: false };
    const d = bfs(P, party);
    let best = -1;
    for (const [x, y] of enemy) { const v = d[y * P.cols + x]; if (v >= 0 && (best < 0 || v < best)) best = v; }
    return { ok: best >= 0, dist: best };
}

/** Проверки тактики одной планировки */
export function audit(P) {
    const r = reach(P);
    // Петля: убираем по одной клетке на кратчайшем пути — если путь всё ещё есть при любой, обходов хотя бы два
    let loop = false;
    if (r.ok) {
        const d = bfs(P, P.zones.party), path = [];
        let cur = P.zones.enemy.map(([x, y]) => [x, y, d[y * P.cols + x]]).filter(c => c[2] >= 0).sort((a, b) => a[2] - b[2])[0];
        while (cur && cur[2] > 0) { path.push(cur); const [x, y, v] = cur; cur = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [x + dx, y + dy, d[(y + dy) * P.cols + x + dx]]).find(c => P.in(c[0], c[1]) && c[2] === v - 1); }
        const inner = path.filter(([x, y]) => !P.zones.party.some(p => p[0] === x && p[1] === y) && !P.zones.enemy.some(p => p[0] === x && p[1] === y));
        loop = inner.length > 0 && inner.every(([cx, cy]) => {
            const dd = bfs(P, P.zones.party, { skip: (x, y) => x === cx && y === cy });
            return P.zones.enemy.some(([x, y]) => dd[y * P.cols + x] >= 0);
        });
        P.path = path.map(([x, y]) => [x, y]);
    }
    const third = [P.cols / 3, (2 * P.cols) / 3];
    const cover = P.objects.filter(o => o.cover && o.x >= third[0] && o.x < third[1]);
    const doors = P.doors.reduce((m, d) => (m[d.state] = (m[d.state] ?? 0) + 1, m), {});
    return { ok: r.ok, dist: r.dist, loop, cover: cover.length, full: cover.filter(o => o.cover === 'full').length, doors, lights: P.lights.length };
}

export { COVER };

/* ---------- Тайники и предметы арены ---------- */

/** Подписи предметов для карточки встречи */
export const PROP_NAMES = {
    cracked: t('треснувшая колонна — обрушить на линию'), ceiling: t('шаткий свод — обвалить, коридор закрыт'),
    lid: t('саркофаг — сдвинуть крышку'), rope: t('верёвочный мост — обрубить'), edge: t('край провала — столкнуть'),
    brazier: t('жаровня — опрокинуть или погасить'), unlit: t('холодная жаровня — зажечь (свет в темноте)'),
    lever: t('рычаг решётки — за стеной'), chandelier: t('люстра на цепи — уронить')
};

/**
 * Тайники (1–2, у Босса 2) — вне главного пути: в тупиках и нишах, в боковых комнатах, за запертой или тайной
 * дверью, на карнизе над провалом; не на кромках строев и не рядом друг с другом. Предметы арены — по схеме
 */
function pointsOfInterest(P, R) {
    audit(P);
    const W = P.cols, idx = (x, y) => y * W + x;
    const path = P.path ?? [];
    // Как далеко от главного пути (по проходимым клеткам, двери открыты все)
    const fromPath = bfs(P, path, { all: true });
    // Что достижимо без запертых и тайных дверей
    const plain = bfs(P, P.zones.party);
    const inZone = (x, y) => P.zones.party.some(p => p[0] === x && p[1] === y) || P.zones.enemy.some(p => p[0] === x && p[1] === y);
    const spots = [];
    for (let y = 1; y < P.rows - 1; y++) for (let x = 1; x < W - 1; x++) {
        if (P.get(x, y) !== FLOOR || P.blocked(x, y) || P.doorAt(x, y) || inZone(x, y)) continue;
        const d = fromPath[idx(x, y)];
        if (d < 0) continue;
        const rock = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => P.get(x + dx, y + dy) === ROCK).length;
        const behind = plain[idx(x, y)] < 0;
        const ledge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => P.get(x + dx, y + dy) === CHASM) && rock >= 1;
        if (d < 3 && !behind) continue;
        const where = behind ? (P.doors.some(dd => dd.state === 'secret' && Math.abs(dd.x - x) + Math.abs(dd.y - y) < 8) ? t('за тайной дверью') : t('за запертой дверью'))
            : rock >= 3 ? t('в нише') : ledge ? t('на краю провала') : rock >= 1 ? t('у стены в стороне') : t('в стороне от пути');
        spots.push({ x, y, where, score: d + (behind ? 8 : 0) + (rock >= 3 ? 4 : 0) + (ledge ? 5 : 0) + R() * 3 });
    }
    spots.sort((a, b) => b.score - a.score);
    const want = P.scheme === 'sanctum' ? 2 : R.int(1, 2);
    for (const sp of spots) {
        if (P.caches.length >= want) break;
        if (P.caches.some(c => Math.abs(c.x - sp.x) + Math.abs(c.y - sp.y) < 6)) continue;
        P.caches.push({ x: sp.x, y: sp.y, where: sp.where });
    }
    PROPS[P.scheme]?.(P, R);
    // В полной темноте холодная жаровня в тёмной части поля — зажечь её значит открыть кусок карты
    if (['hall', 'crypt', 'rooms'].includes(P.scheme) && R.chance(0.6)) {
        for (let t = 0; t < 40; t++) {
            const x = R.int(Math.round(W * 0.4), Math.round(W * 0.75)), y = R.int(2, P.rows - 3);
            if (!P.free(x, y) || path.some(p => p[0] === x && p[1] === y) || P.lights.some(l => Math.hypot(l.x - x, l.y - y) < 4)) continue;
            P.obj('brazier', x, y, 1, 1, 'half').unlit = true;
            P.props.push({ kind: 'unlit', x, y });
            break;
        }
    }
}

const middle = (P, o) => o.x >= P.cols / 3 && o.x < (2 * P.cols) / 3;
const PROPS = {
    // 1–2 треснувшие колонны в средней трети — падают к врагам (на восток), за ними завал
    hall(P, R) {
        const list = P.objects.filter(o => o.kind === 'pillar' && middle(P, o)).sort(() => R() - 0.5).slice(0, R.int(1, 2));
        for (const o of list) { o.cracked = true; P.props.push({ kind: 'cracked', x: o.x, y: o.y, dx: 1, dy: 0 }); }
    },
    // Шаткий свод в одном из коридоров
    corridors(P, R) {
        for (let t = 0; t < 400; t++) {
            const x = R.int(Math.round(P.cols * 0.28), Math.round(P.cols * 0.72)), y = R.int(2, P.rows - 3);
            if (P.get(x, y) !== FLOOR || P.blocked(x, y)) continue;
            const narrow = (P.get(x, y - 1) === ROCK || P.get(x, y - 2) === ROCK) && (P.get(x, y + 1) === ROCK || P.get(x, y + 2) === ROCK);
            if (!narrow) continue;
            P.props.push({ kind: 'ceiling', x, y }); break;
        }
    },
    // Саркофаги с крышкой: в одном из них — тайник
    crypt(P, R) {
        const list = P.objects.filter(o => o.kind === 'sarcophagus' && middle(P, o)).sort(() => R() - 0.5).slice(0, 2);
        for (const o of list) P.props.push({ kind: 'lid', x: o.x, y: o.y });
        if (list.length && R.chance(0.6)) { const o = list[0]; P.caches.splice(0, P.caches.length > 1 ? 1 : 0, { x: o.x, y: o.y, where: t('в саркофаге') }); }
    },
    // Деревянный мост можно обрубить; край провала у моста — столкнуть
    chasm(P, R) {
        const bridges = [];
        for (let y = 0; y < P.rows; y++) { let x0 = -1; for (let x = 0; x < P.cols; x++) if (P.get(x, y) === BRIDGE) { if (x0 < 0) x0 = x; } else if (x0 >= 0) { bridges.push({ x: Math.round((x0 + x - 1) / 2), y }); x0 = -1; } }
        const rope = bridges.length ? R.pick(bridges) : null;
        if (rope) P.props.push({ kind: 'rope', x: rope.x, y: rope.y });
        for (let t = 0; t < 40; t++) {
            const x = R.int(Math.round(P.cols * 0.3), Math.round(P.cols * 0.7)), y = R.int(2, P.rows - 3);
            if (P.get(x, y) === FLOOR && !P.blocked(x, y) && [[1, 0], [-1, 0]].some(([dx]) => P.get(x + dx, y) === CHASM)) { P.props.push({ kind: 'edge', x, y }); break; }
        }
    },
    // Жаровни у возвышения: погасить их — Босс теряет защиту (цель боя); люстра над ковром
    sanctum(P, R) {
        for (const o of P.objects.filter(o => o.kind === 'brazier')) P.props.push({ kind: 'brazier', x: o.x, y: o.y });
        const carpet = P.objects.find(o => o.kind === 'carpet');
        if (carpet && R.chance(0.7)) P.props.push({ kind: 'chandelier', x: carpet.x + Math.round(carpet.w * 0.55), y: carpet.y });
        P.objective = t('погасить жаровни у алтаря, пока Босс под защитой');
    },
    // Рычаг решётки — на стороне врагов, у стены; дотянуться — через обход или прорвавшись
    gate(P, R) {
        const d = P.doors.find(x => x.kind === 'portcullis');
        if (!d) return;
        for (const [x, y] of [[d.x + 2, d.y - 1], [d.x + 2, d.y + 2], [d.x + 3, d.y - 1], [d.x + 3, d.y + 2]]) if (P.free(x, y)) { P.props.push({ kind: 'lever', x, y }); break; }
    },
    // Связка комнат: люстра в самой большой комнате
    rooms(P, R) {
        const big = [...P.rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0];
        if (big && R.chance(0.6)) P.props.push({ kind: 'chandelier', x: big.x + Math.floor(big.w / 2), y: big.y + Math.floor(big.h / 2) });
    }
};
