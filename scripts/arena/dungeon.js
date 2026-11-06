/**
 * Генератор арен — подземелье (катакомбы, docs/dungeon-floor.md): из планировки dungeon-layout.js — картинка,
 * стены и двери Foundry, свет и темнота, регионы, клетки для токенов. Сборку сцены (загрузка, токены, погода)
 * делает arena.js, как для леса.
 *
 * Картинка: пол — плиты двух видов пятнами, завал своей текстурой; стена — почти чёрная масса с тонкой кромкой и
 * мягкой тенью на полу вдоль неё; провал — чёрный с синеватым краем, мосты поверх; предметы — картинки биома
 * (assets/battlemap/crypt). Двери — настоящие двери Foundry четырёх видов, тайная на картинке — просто стена.
 * Темнота двух видов: полная (видно только освещённое) и условная (картинка ночная, видно всё).
 */

import { t } from "../core/i18n.js";
import { dungeon, pickScheme, rng, ROCK, FLOOR, WATER, CHASM, RUBBLE, BRIDGE, PROP_NAMES } from "./dungeon-layout.js";

/** Биомы подземелья — арена строится этим генератором; пещеры пока на схемах катакомб */
export const DUNGEON_BIOMES = new Set(['crypt', 'caves']);
/** Арт подземелья — катакомбы */
export const DUNGEON_ART = 'crypt';

const WALL = { NONE: 0, LIMITED: 10, NORMAL: 20 };
const DOOR = { NONE: 0, DOOR: 1, SECRET: 2 };
const DOOR_STATE = { CLOSED: 0, OPEN: 1, LOCKED: 2 };
// Темнота: полная — без общего света; условная — общий свет при ночной темноте сцены
export const DARK = {
    full: { darknessLevel: 1, globalLight: { enabled: false } },
    cond: { darknessLevel: 0.6, globalLight: { enabled: true, darkness: { min: 0, max: 1 } } }
};
export const DARK_NAMES = { full: t('полная темнота'), cond: t('условная темнота') };

/** Детерминированный «шум» клетки: какие факелы погашены, разброс мелочи */
const hash = (x, y, k = 0) => { let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/**
 * Куда смотрит факел: на клетку пола рядом — но не в нишу (клетка пола, зажатая породой с трёх сторон): из ниши свет
 * бьёт клином. Только ниша рядом — факела нет
 */
function torchDir(P, L) {
    const floor = (x, y) => [FLOOR, RUBBLE, BRIDGE].includes(P.get(x, y)) && !secretAt(P, x, y);
    const niche = (x, y) => DIRS.filter(([dx, dy]) => P.get(x + dx, y + dy) === ROCK).length >= 3;
    return DIRS.find(([dx, dy]) => floor(L.x + dx, L.y + dy) && !niche(L.x + dx, L.y + dy)) ?? null;
}
/**
 * Какие источники горят. Условная темнота — все. Полная — треть настенных факелов погашена, но огней не меньше
 * одного на 70 клеток пола (и не меньше трёх): иначе в склепе с редкими факелами темно, как в погребе
 */
function litLights(P) {
    if (P._lit) return P._lit;
    const usable = P.lights.filter(L => L.kind !== 'torch' || torchDir(P, L));
    if (P.dark !== 'full') return (P._lit = new Set(usable));
    const lit = new Set(usable.filter(L => L.kind !== 'torch' || hash(L.x, L.y, 7) > 0.35));
    let floor = 0;
    for (let i = 0; i < P.cells.length; i++) if (P.cells[i] === FLOOR) floor++;
    const need = Math.max(3, Math.round(floor / 70));
    for (const L of usable.filter(L => !lit.has(L)).sort((a, b) => hash(b.x, b.y, 7) - hash(a.x, a.y, 7))) {
        if (lit.size >= need) break;
        lit.add(L);
    }
    return (P._lit = lit);
}
const torchLit = (L, P) => litLights(P).has(L);

/**
 * Планировка и темнота по встрече. Темнота «по встрече»: Монстры — условная, Элита — то так, то так, Застава и
 * Босс — чаще полная; настройка мира может задать одну на все бои
 */
export function planDungeon({ cols, rows, seed, scheme, encounter = {}, dark = 'auto' }) {
    const R = rng(`${seed}|dungeon`);
    scheme ??= pickScheme(R, encounter);
    const plan = dungeon({ scheme, cols, rows, seed });
    if (dark === 'auto' || !DARK[dark]) {
        const node = encounter.node, D = rng(`${seed}|dark`)();
        dark = node === 'mob' ? 'cond' : node === 'elite' ? (D < 0.5 ? 'full' : 'cond') : node ? (D < 0.8 ? 'full' : 'cond') : 'cond';
    }
    plan.dark = dark;
    plan.dungeon = true;
    return plan;
}

/* ---------- Картинка ---------- */

// Тень — холодная тёмно-синяя, как в лесу (paint.js): тень меняет оттенок, а не только яркость. Свет сверху слева
const SHADE = '20,30,58';
/**
 * Высота предметов в клетках: длина падающей тени. Плоское (ковёр, кости) — без тени, только посадка;
 * колонны и статуи — длинная тень, мебель — короткая
 */
const HEIGHT = { pillar: 0.55, statue: 0.5, 'pillar-broken': 0.22, sarcophagus: 0.16, 'sarcophagus-open': 0.14, altar: 0.14, crates: 0.2,
    table: 0.12, rack: 0.22, brazier: 0.16, barricade: 0.18, rubble: 0.12, 'bone-pile': 0.05, niche: 0, debris: 0.04, door: 0.06, portcullis: 0.1, torch: 0.08 };

/**
 * Предметы приглушены под пол: картинки нарисованы при ярком ровном свете, а пол подземелья тёмный и холодный —
 * без этого предмет светится вставкой. Свой фильтр (погашенная жаровня) ложится поверх
 */
const TONE = 'brightness(.78) saturate(.82) sepia(.08)';

/** Предмет в свой холст: картинка вписана в w×h (поворот, если лежит не той стороной), с полями под тень */
function sprite(img, w, h, { pad = 0.06, filter = null, rot = 0 } = {}) {
    const turn = (img.width >= img.height) !== (w >= h) && Math.abs(w - h) > 0.01;
    const iw = turn ? img.height : img.width, ih = turn ? img.width : img.height;
    const k = Math.min(w * (1 - pad * 2) / iw, h * (1 - pad * 2) / ih);
    const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h);
    const l = c.getContext('2d');
    l.translate(w / 2, h / 2); l.rotate((turn ? Math.PI / 2 : 0) + rot);
    l.filter = filter ? `${TONE} ${filter}` : TONE;
    l.drawImage(img, -img.width * k / 2, -img.height * k / 2, img.width * k, img.height * k);
    // Затенение к нижнему правому краю самого предмета: свет сверху слева
    l.filter = 'none'; l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = 'source-atop';
    const g = l.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, 'rgba(255,235,200,0.06)'); g.addColorStop(0.55, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(${SHADE},0.35)`);
    l.fillStyle = g; l.fillRect(0, 0, c.width, c.height);
    return c;
}

/** Силуэт цветом тени */
function silhouette(c) {
    const s = document.createElement('canvas'); s.width = c.width; s.height = c.height;
    const l = s.getContext('2d'); l.drawImage(c, 0, 0); l.globalCompositeOperation = 'source-in'; l.fillStyle = `rgb(${SHADE})`; l.fillRect(0, 0, s.width, s.height);
    return s;
}

/**
 * Поставить предмет: посадка (затенение под основанием — стоит на полу, а не лежит поверх), падающая тень вправо
 * вниз по высоте, сам предмет
 */
function place(l, spr, x, y, height, cell) {
    const w = spr.width, h = spr.height, sil = silhouette(spr);
    l.save();
    l.filter = `blur(${cell * 0.07}px)`; l.globalAlpha = 0.7;
    l.drawImage(sil, x - w * 0.05, y - h * 0.03, w * 1.1, h * 1.1);
    if (height > 0) {
        const off = height * cell;
        l.filter = `blur(${cell * (0.05 + height * 0.12)}px)`; l.globalAlpha = 0.5;
        for (let i = 1; i <= 3; i++) l.drawImage(sil, x + off * i / 3, y + off * 1.15 * i / 3);
    }
    l.restore();
    l.drawImage(spr, x, y);
}

/** Картинка в прямоугольник клеток: держит пропорции; лежит не той стороной — поворот на 90° */
function drawFit(l, img, x, y, w, h, { pad = 0.06, filter = null, rot = 0 } = {}) {
    if (!img) return false;
    const turn = (img.width >= img.height) !== (w >= h) && Math.abs(w - h) > 0.01;
    const iw = turn ? img.height : img.width, ih = turn ? img.width : img.height;
    const k = Math.min(w * (1 - pad * 2) / iw, h * (1 - pad * 2) / ih);
    l.save();
    l.translate(x + w / 2, y + h / 2);
    l.rotate((turn ? Math.PI / 2 : 0) + rot);
    if (filter) l.filter = filter;
    l.drawImage(img, -img.width * k / 2, -img.height * k / 2, img.width * k, img.height * k);
    l.restore();
    return true;
}

/** Узор текстуры: одна текстура (1024) — на `span` клеток */
function pattern(l, img, cell, span = 4) {
    const p = l.createPattern(img, 'repeat');
    p.setTransform?.(new DOMMatrix().scale(span * cell / img.width));
    return p;
}

/**
 * Нарисовать подземелье
 * @returns {HTMLCanvasElement}
 */
export function paintDungeon(P, { cell = 140, art = {} } = {}) {
    const W = P.cols * cell, H = P.rows * cell, C = cell;
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const out = mk(), l = out.getContext('2d');
    const R = rng(`${P.seed}|paint`);
    const at = (x, y) => P.get(x, y);
    const isOpen = (x, y) => at(x, y) !== ROCK;
    // Пол — то, на чём лежат плиты; мост висит над провалом
    const isFloor = (x, y) => [FLOOR, RUBBLE, WATER].includes(at(x, y)) && !secretAt(P, x, y);

    // Маски: пол и порода (тайная дверь — порода)
    const floorMask = mk(), fm = floorMask.getContext('2d');
    fm.fillStyle = '#fff';
    for (let y = 0; y < P.rows; y++) for (let x = 0; x < P.cols; x++) if (isFloor(x, y)) fm.fillRect(x * C, y * C, C, C);

    // Порода: фактура стены, ещё темнее
    l.fillStyle = art['wall-top-1'] ? pattern(l, art['wall-top-1'], C, 4) : '#141110';
    l.fillRect(0, 0, W, H);
    l.fillStyle = 'rgba(0,0,0,.35)'; l.fillRect(0, 0, W, H);

    // Пол: плиты, пятнами — выбитые плиты второго вида; завал — своей текстурой
    const floor = mk(), f = floor.getContext('2d');
    f.fillStyle = art['ground-flagstone-1'] ? pattern(f, art['ground-flagstone-1'], C) : '#5f564a';
    f.fillRect(0, 0, W, H);
    if (art['ground-flagstone-2']) {
        const patch = mk(), p = patch.getContext('2d');
        p.fillStyle = pattern(p, art['ground-flagstone-2'], C); p.fillRect(0, 0, W, H);
        const m = mk(), mm = m.getContext('2d');
        mm.filter = `blur(${C * 0.6}px)`; mm.fillStyle = '#fff';
        for (let i = 0, n = Math.round(P.cols * P.rows / 40); i < n; i++) { mm.beginPath(); mm.arc(R() * W, R() * H, C * R.range(0.8, 2.2), 0, 7); mm.fill(); }
        p.globalCompositeOperation = 'destination-in'; p.drawImage(m, 0, 0);
        f.drawImage(patch, 0, 0);
    }
    if (art['ground-rubble-1']) {
        const rub = mk(), r = rub.getContext('2d');
        r.fillStyle = pattern(r, art['ground-rubble-1'], C, 3); r.fillRect(0, 0, W, H);
        const m = mk(), mm = m.getContext('2d');
        mm.filter = `blur(${C * 0.15}px)`; mm.fillStyle = '#fff';
        for (let y = 0; y < P.rows; y++) for (let x = 0; x < P.cols; x++) if (at(x, y) === RUBBLE) mm.fillRect(x * C - C * 0.1, y * C - C * 0.1, C * 1.2, C * 1.2);
        r.globalCompositeOperation = 'destination-in'; r.drawImage(m, 0, 0);
        f.drawImage(rub, 0, 0);
    }
    f.globalCompositeOperation = 'destination-in'; f.drawImage(floorMask, 0, 0);
    l.drawImage(floor, 0, 0);

    // Провал: чернота, у краёв — синеватый отсвет уходящих вниз стен
    const pit = mk(), pc = pit.getContext('2d');
    pc.fillStyle = '#fff';
    for (let y = 0; y < P.rows; y++) for (let x = 0; x < P.cols; x++) if (at(x, y) === CHASM || at(x, y) === BRIDGE) pc.fillRect(x * C, y * C, C, C);
    if (P.cells.includes(CHASM)) {
        const rim = mk(), rc = rim.getContext('2d');
        rc.fillStyle = '#040507'; rc.fillRect(0, 0, W, H);
        rc.filter = `blur(${C * 0.35}px)`; rc.globalAlpha = 0.7; rc.drawImage(floorMask, 0, 0); rc.filter = 'none'; rc.globalAlpha = 1;
        rc.globalCompositeOperation = 'multiply'; rc.fillStyle = '#2c4258'; rc.fillRect(0, 0, W, H);
        rc.globalCompositeOperation = 'destination-in'; rc.drawImage(pit, 0, 0);
        l.drawImage(rim, 0, 0);
    }

    // Светотень пола: крупные мягкие пятна светлее и темнее — живой камень без мелкого шума
    const clouds = mk(), cl = clouds.getContext('2d');
    for (let i = 0, n = Math.round(P.cols * P.rows / 5); i < n; i++) {
        const x = R() * W, y = R() * H, r = C * R.range(1.2, 3.2), light = R() < 0.45;
        const g = cl.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, light ? 'rgba(255,236,200,0.08)' : `rgba(${SHADE},0.16)`); g.addColorStop(1, 'rgba(0,0,0,0)');
        cl.fillStyle = g; cl.beginPath(); cl.arc(x, y, r, 0, 7); cl.fill();
    }
    // Сырость и грязь у стен: тёмные пятна с зеленцой вдоль подножия; трещины в плитах
    const wallFoot = [];
    for (let y = 0; y < P.rows; y++) for (let x = 0; x < P.cols; x++) {
        if (!isFloor(x, y)) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (at(x + dx, y + dy) === ROCK) wallFoot.push([x + 0.5 + dx * 0.4, y + 0.5 + dy * 0.4]);
    }
    for (const [x, y] of wallFoot) {
        if (R() > 0.35) continue;
        const r = C * R.range(0.4, 1.1), g = cl.createRadialGradient(x * C, y * C, 0, x * C, y * C, r), moss = R() < 0.35;
        g.addColorStop(0, moss ? 'rgba(48,62,30,0.35)' : 'rgba(30,22,14,0.32)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        cl.fillStyle = g; cl.beginPath(); cl.ellipse(x * C, y * C, r, r * 0.7, R() * 3, 0, 7); cl.fill();
    }
    cl.strokeStyle = 'rgba(16,10,6,0.55)'; cl.lineCap = 'round';
    for (let i = 0, n = Math.round(P.cols * P.rows / 14); i < n; i++) {
        let x = R() * W, y = R() * H, a = R() * 6.28;
        cl.lineWidth = R.range(1.2, 2.4); cl.beginPath(); cl.moveTo(x, y);
        for (let j = 0, m = R.int(3, 6); j < m; j++) { a += R.range(-0.7, 0.7); x += Math.cos(a) * C * 0.18; y += Math.sin(a) * C * 0.18; cl.lineTo(x, y); }
        cl.stroke();
    }
    cl.globalCompositeOperation = 'destination-in'; cl.drawImage(floorMask, 0, 0);
    l.drawImage(clouds, 0, 0);

    // Стены высокие: падающая тень на пол вправо вниз и мягкое затенение вдоль подножия со всех сторон
    const rockMask = mk(), rk = rockMask.getContext('2d');
    rk.fillStyle = '#000';
    for (let y = -1; y <= P.rows; y++) for (let x = -1; x <= P.cols; x++) if (!isFloor(x, y) && at(x, y) !== CHASM && at(x, y) !== BRIDGE) rk.fillRect(x * C, y * C, C, C);
    const shade = mk(), sh = shade.getContext('2d');
    sh.filter = `blur(${C * 0.3}px)`; sh.globalAlpha = 0.85;
    sh.drawImage(rockMask, C * 0.35, C * 0.42);
    sh.filter = `blur(${C * 0.12}px)`; sh.globalAlpha = 0.6; sh.drawImage(rockMask, 0, 0);
    sh.filter = 'none'; sh.globalAlpha = 1;
    sh.globalCompositeOperation = 'source-in'; sh.fillStyle = `rgb(${SHADE})`; sh.fillRect(0, 0, W, H);
    sh.globalCompositeOperation = 'destination-in'; sh.drawImage(floorMask, 0, 0);
    l.globalAlpha = 0.8; l.drawImage(shade, 0, 0); l.globalAlpha = 1;

    // Кромка: тонкая тёмная линия по границе пола и стены; у провала — синеватая
    l.lineCap = 'round';
    for (let y = 0; y < P.rows; y++) for (let x = 0; x < P.cols; x++) {
        if (!isFloor(x, y)) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy, n = at(nx, ny);
            if (isFloor(nx, ny)) continue;
            const chasm = n === CHASM || n === BRIDGE;
            l.strokeStyle = chasm ? 'rgba(70,110,150,.55)' : 'rgba(8,6,5,.9)'; l.lineWidth = chasm ? 3 : 4;
            l.beginPath();
            if (dx) { const X = (x + (dx > 0 ? 1 : 0)) * C; l.moveTo(X, y * C); l.lineTo(X, y * C + C); }
            else { const Y = (y + (dy > 0 ? 1 : 0)) * C; l.moveTo(x * C, Y); l.lineTo(x * C + C, Y); }
            l.stroke();
            // Гребень стены, обращённый к свету (стена справа или снизу от пола), — тусклый блик на кромке породы
            if (!chasm && (dx > 0 || dy > 0)) {
                l.strokeStyle = 'rgba(150,135,110,.22)'; l.lineWidth = 3; l.beginPath();
                if (dx) { const X = (x + 1) * C + 4; l.moveTo(X, y * C + 2); l.lineTo(X, y * C + C - 2); }
                else { const Y = (y + 1) * C + 4; l.moveTo(x * C + 2, Y); l.lineTo(x * C + C - 2, Y); }
                l.stroke();
            }
        }
    }

    // Мосты: отрезки клеток моста по рядам; одинаковые в соседних рядах — один широкий мост. Верёвочный — если
    // его можно обрубить
    const rope = P.props.some(p => p.kind === 'rope'), runs = [];
    for (let y = 0; y < P.rows; y++) {
        let x0 = -1;
        for (let x = 0; x <= P.cols; x++) {
            if (x < P.cols && at(x, y) === BRIDGE) { if (x0 < 0) x0 = x; continue; }
            if (x0 >= 0) {
                const prev = runs.find(r => r.x0 === x0 && r.x1 === x && r.y + r.h === y);
                if (prev) prev.h++; else runs.push({ x0, x1: x, y, h: 1 });
                x0 = -1;
            }
        }
    }
    for (const r of runs) {
        const img = art[rope ? 'bridge-wood-1' : 'bridge-1'];
        if (img) drawFit(l, img, r.x0 * C - C * 0.25, r.y * C, (r.x1 - r.x0) * C + C * 0.5, r.h * C, { pad: 0 });
        else { l.fillStyle = '#6b4e2c'; l.fillRect(r.x0 * C, r.y * C + C * 0.15, (r.x1 - r.x0) * C, r.h * C - C * 0.3); }
    }

    // Возвышение и ковёр святилища
    for (const o of P.objects.filter(o => o.kind === 'dais')) {
        const x = o.x * C, y = o.y * C, w = o.w * C, h = o.h * C;
        l.fillStyle = 'rgba(0,0,0,.45)'; l.fillRect(x + C * 0.12, y + C * 0.12, w, h);
        l.fillStyle = art['ground-flagstone-2'] ? pattern(l, art['ground-flagstone-2'], C, 3) : '#7a6e5c'; l.fillRect(x, y, w, h);
        l.fillStyle = 'rgba(255,240,210,.12)'; l.fillRect(x, y, w, h);
        l.strokeStyle = 'rgba(20,14,8,.9)'; l.lineWidth = 4; l.strokeRect(x + 2, y + 2, w - 4, h - 4);
    }
    for (const o of P.objects.filter(o => o.kind === 'carpet')) {
        const x = o.x * C, y = o.y * C + C * 0.12, w = o.w * C, h = o.h * C - C * 0.24;
        l.fillStyle = 'rgba(96,18,22,.92)'; l.fillRect(x, y, w, h);
        l.strokeStyle = 'rgba(190,140,60,.7)'; l.lineWidth = 3; l.strokeRect(x + C * 0.08, y + C * 0.08, w - C * 0.16, h - C * 0.16);
    }

    // Мелочь у стен: кости и обломки (россыпь)
    const pieces = kind => Object.keys(art).filter(k => k.startsWith(`scatter-${kind}-1-`)).map(k => art[k]);
    const bones = pieces('bones'), debris = pieces('debris');
    for (let y = 0; y < P.rows; y++) for (let x = 0; x < P.cols; x++) {
        if (at(x, y) !== FLOOR || P.blocked(x, y) || P.doorAt(x, y)) continue;
        const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => at(x + dx, y + dy) === ROCK).length;
        if (!walls || R() > 0.16 * walls) continue;
        const list = R() < 0.5 ? bones : debris;
        if (!list.length) continue;
        // Кучка: 2–4 штуки рядом, к стене
        for (let i = 0, n = R.int(2, 4); i < n; i++) {
            const img = R.pick(list), sz = C * R.range(0.2, 0.36);
            const spr = sprite(img, sz, sz, { pad: 0, rot: R() * 6.28 });
            place(l, spr, x * C + R.range(0.05, 0.75) * C, y * C + R.range(0.05, 0.75) * C, 0.03, C);
        }
    }

    // Предметы
    const IMG = { pillar: 'pillar-round-1', 'pillar-broken': 'pillar-round-1', statue: 'statue-1', sarcophagus: 'sarcophagus-1', 'sarcophagus-open': 'sarcophagus-open-1',
        niche: 'niche-1', 'bone-pile': 'bone-pile-1', crates: 'crates-1', table: 'table-1', rack: 'weapon-rack-1', altar: 'altar-1', brazier: 'brazier-1', rubble: 'rubble-1', barricade: 'barricade-1' };
    for (const o of P.objects) {
        const x = o.x * C, y = o.y * C, w = o.w * C, h = o.h * C, H = HEIGHT[o.kind] ?? 0.1;
        if (o.kind === 'debris') { if (debris.length) place(l, sprite(R.pick(debris), C * 0.6, C * 0.6, { rot: R() * 6.28 }), x + C * 0.2, y + C * 0.2, H, C); continue; }
        const img = art[IMG[o.kind]];
        if (!img) continue;
        if (o.kind === 'pillar-broken') {
            place(l, sprite(img, C * 0.76, C * 0.76, { filter: 'brightness(.85)' }), x + C * 0.12, y + C * 0.12, H, C);
            if (debris.length) place(l, sprite(R.pick(debris), C * 0.5, C * 0.5, { rot: R() * 6.28 }), x + C * 0.45, y + C * 0.45, 0.04, C);
            continue;
        }
        place(l, sprite(img, w, h, { filter: o.unlit ? 'grayscale(1) brightness(.55)' : null }), x, y, H, C);
        // Треснувшая колонна: трещины поперёк
        if (o.cracked) {
            l.strokeStyle = 'rgba(20,12,6,.9)'; l.lineWidth = 3; l.beginPath();
            l.moveTo(x + C * 0.3, y + C * 0.25); l.lineTo(x + C * 0.5, y + C * 0.48); l.lineTo(x + C * 0.42, y + C * 0.62); l.lineTo(x + C * 0.66, y + C * 0.8);
            l.stroke();
        }
    }

    // Двери: полотно в проёме; открытая — распахнута у косяка; тайная — порода
    for (const d of P.doors) {
        const len = d.wide ? 2 : 1, v = d.orient === 'v', x = d.x * C, y = d.y * C;
        if (d.state === 'secret') {
            l.save(); l.fillStyle = art['wall-top-1'] ? pattern(l, art['wall-top-1'], C, 4) : '#141110';
            l.fillRect(x, y, v ? C : C * len, v ? C * len : C); l.fillStyle = 'rgba(0,0,0,.35)'; l.fillRect(x, y, v ? C : C * len, v ? C * len : C); l.restore();
            continue;
        }
        const img = d.kind === 'portcullis' ? art['portcullis-1'] : d.state === 'locked' ? art['door-locked-1'] : art['door-1'];
        // Полотно: поперёк прохода (v — вертикально), толщина ~0.4 клетки
        if (!img) continue;
        const H = HEIGHT[d.kind === 'portcullis' ? 'portcullis' : 'door'];
        if (d.state === 'open') {
            if (v) place(l, sprite(img, C, C * 0.4, { pad: 0 }), x, y - C * 0.05, H, C);
            else place(l, sprite(img, C * 0.4, C, { pad: 0 }), x - C * 0.05, y, H, C);
            continue;
        }
        if (v) place(l, sprite(img, C * 0.4, C * len, { pad: 0 }), x + C * 0.3, y, H, C);
        else place(l, sprite(img, C * len, C * 0.4, { pad: 0 }), x, y + C * 0.3, H, C);
    }

    // Факелы на кромке стены: держатель вбит в стену, пламя — над полом; на полу под ним тёплое пятно (только на
    // полу — порода не светится; погашенные — без пятна)
    const glow = mk(), gl = glow.getContext('2d');
    for (const L of P.lights) {
        if (L.kind !== 'torch') continue;
        const dir = torchDir(P, L);
        if (!dir) continue;
        const lit = torchLit(L, P);
        const ex = (L.x + 0.5 + dir[0] * 0.5) * C, ey = (L.y + 0.5 + dir[1] * 0.5) * C;
        if (lit) {
            const fx = ex + dir[0] * C * 0.6, fy = ey + dir[1] * C * 0.6, r = C * 2.2;
            const g = l.createRadialGradient(fx, fy, 0, fx, fy, r);
            g.addColorStop(0, 'rgba(255,170,90,0.20)'); g.addColorStop(0.5, 'rgba(255,140,60,0.08)'); g.addColorStop(1, 'rgba(255,140,60,0)');
            gl.fillStyle = g; gl.beginPath(); gl.arc(fx, fy, r, 0, 7); gl.fill();
        }
    }
    gl.globalCompositeOperation = 'destination-in'; gl.drawImage(floorMask, 0, 0);
    l.save(); l.globalCompositeOperation = 'lighter'; l.drawImage(glow, 0, 0); l.restore();
    for (const L of P.lights) {
        if (L.kind !== 'torch' || !art['torch-1']) continue;
        const dir = torchDir(P, L);
        if (!dir) continue;
        const lit = torchLit(L, P);
        const ex = (L.x + 0.5 + dir[0] * 0.5) * C, ey = (L.y + 0.5 + dir[1] * 0.5) * C;
        // Картинка: держатель сверху — «верх» картинки смотрит в стену; центр — чуть над полом, держатель на кромке
        const rot = Math.atan2(-dir[1], -dir[0]) + Math.PI / 2, sz = C * 0.75;
        const spr = sprite(art['torch-1'], sz, sz, { pad: 0, rot, filter: lit ? null : 'brightness(.6) grayscale(.6)' });
        place(l, spr, ex + dir[0] * sz * 0.32 - sz / 2, ey + dir[1] * sz * 0.32 - sz / 2, HEIGHT.torch, C);
    }

    // Общая подача: края поля темнее (взгляд — в середину), лёгкий холодный оттенок теней
    const vg = l.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(${SHADE},0.35)`);
    l.fillStyle = vg; l.fillRect(0, 0, W, H);
    return out;
}

const secretAt = (P, x, y) => P.doors.some(d => d.state === 'secret' && ((d.x === x && d.y === y) || (d.wide && (d.orient === 'v' ? d.x === x && d.y + 1 === y : d.x + 1 === x && d.y === y))));

/* ---------- Стены, свет, регионы ---------- */

/** Стены Foundry по краю пола (соседние отрезки слиты), двери, колонны и мебель */
export function dungeonWalls(P, cell = 140) {
    const C = cell, walls = [];
    const solid = { move: WALL.NORMAL, sight: WALL.NORMAL, light: WALL.NORMAL, sound: WALL.NORMAL };
    const low = { move: WALL.NORMAL, sight: WALL.LIMITED, light: WALL.LIMITED, sound: WALL.NONE };
    const step = { move: WALL.NORMAL, sight: WALL.NONE, light: WALL.NONE, sound: WALL.NONE };
    // Открытое для стен: всё, кроме породы (провал — яма, не стена); за краем карты — порода
    const open = (x, y) => P.in(x, y) && P.get(x, y) !== ROCK;
    // Вертикальные границы: между (x−1, y) и (x, y)
    for (let x = 0; x <= P.cols; x++) {
        let y0 = -1;
        for (let y = 0; y <= P.rows; y++) {
            const edge = y < P.rows && open(x - 1, y) !== open(x, y);
            if (edge && y0 < 0) y0 = y;
            if (!edge && y0 >= 0) { walls.push({ c: [x * C, y0 * C, x * C, y * C], ...solid }); y0 = -1; }
        }
    }
    for (let y = 0; y <= P.rows; y++) {
        let x0 = -1;
        for (let x = 0; x <= P.cols; x++) {
            const edge = x < P.cols && open(x, y - 1) !== open(x, y);
            if (edge && x0 < 0) x0 = x;
            if (!edge && x0 >= 0) { walls.push({ c: [x0 * C, y * C, x * C, y * C], ...solid }); x0 = -1; }
        }
    }
    // Двери — поперёк проёма посередине клетки
    for (const d of P.doors) {
        const len = d.wide ? 2 : 1, v = d.orient === 'v';
        const c = v ? [(d.x + 0.5) * C, d.y * C, (d.x + 0.5) * C, (d.y + len) * C] : [d.x * C, (d.y + 0.5) * C, (d.x + len) * C, (d.y + 0.5) * C];
        if (d.kind === 'portcullis') { walls.push({ c, move: WALL.NORMAL, sight: WALL.NONE, light: WALL.NONE, sound: WALL.NONE, door: DOOR.DOOR, ds: DOOR_STATE.CLOSED }); continue; }
        walls.push({ c, ...solid, door: d.state === 'secret' ? DOOR.SECRET : DOOR.DOOR,
            ds: d.state === 'open' ? DOOR_STATE.OPEN : d.state === 'locked' ? DOOR_STATE.LOCKED : DOOR_STATE.CLOSED });
    }
    // Предметы: колонны и статуи закрывают обзор, мебель держит только шаг
    const box = (o, inset, flags) => {
        const x0 = (o.x + inset) * C, y0 = (o.y + inset) * C, x1 = (o.x + o.w - inset) * C, y1 = (o.y + o.h - inset) * C;
        for (const c of [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]]) walls.push({ c: c.map(Math.round), ...flags });
    };
    for (const o of P.objects) {
        if (o.kind === 'pillar' || o.kind === 'statue') box(o, 0.12, solid);
        else if (['pillar-broken', 'sarcophagus', 'sarcophagus-open', 'altar', 'crates', 'table', 'rack', 'brazier', 'niche'].includes(o.kind)) box(o, 0.1, step);
    }
    // Бойницы заставы: окно в толще стены — видно и светит насквозь, пройти нельзя
    for (const s of P.slits ?? []) walls.push({ c: [s.x * C, (s.y + 0.5) * C, (s.x + 2) * C, (s.y + 0.5) * C], ...low });
    return walls.map(w => ({ ...w, c: w.c.map(Math.round) }));
}

/** Свет: факелы (в полной темноте треть погашена), жаровни, алтарь; над провалом — «живая муть» */
export function dungeonLights(P, cell = 140) {
    const C = cell, lights = [];
    const isFloor = (x, y) => [FLOOR, RUBBLE, BRIDGE].includes(P.get(x, y));
    for (const L of P.lights) {
        if (!torchLit(L, P)) continue;
        let x = L.x + 0.5, y = L.y + 0.5;
        if (L.kind === 'torch') {
            const dir = torchDir(P, L);
            // Источник — на четверть клетки от стены: стена у самого источника режет свет прямой и щелью у угла
            if (dir) { x += dir[0] * 0.75; y += dir[1] * 0.75; }
        }
        const conf = {
            // Мягкий край: яркий круг маленький, тусклый — широкий, затухание сильное — свет тает, а не обрывается дугой
            torch: { dim: 25, bright: 5, color: '#ff9a3c', animation: { type: 'torch', speed: 4, intensity: 4 } },
            brazier: { dim: 30, bright: 5, color: '#ff8a2a', animation: { type: 'torch', speed: 3, intensity: 5 } },
            altar: { dim: 35, bright: 5, color: '#9f7bff', animation: { type: 'pulse', speed: 2, intensity: 3 } }
        }[L.kind] ?? {};
        lights.push({ x: Math.round(x * C), y: Math.round(y * C), walls: true, config: { alpha: 0.45, luminosity: 0.45, attenuation: 0.9, coloration: 1, ...conf }, flags: { gachadnd: { dungeonLight: L.kind } } });
    }
    // Над провалом — тусклая синеватая муть: провал «дышит»
    for (let y = 1; y < P.rows - 1; y += 3) for (let x = 1; x < P.cols - 1; x++) {
        if (P.get(x, y) !== CHASM || P.get(x - 1, y) === CHASM) continue;
        lights.push({ x: Math.round((x + 1.5) * C), y: Math.round((y + 0.5) * C), walls: true, config: { dim: 10, bright: 0, color: '#0b1a2a', alpha: 0.5, luminosity: 0.5, attenuation: 0.5, coloration: 1, animation: { type: 'ghost', speed: 3, intensity: 3 } } });
    }
    return lights;
}

/** Регионы: провал (без автоматики — падение решает Мастер), завал — трудная местность (камни) */
export function dungeonRegions(P, cell = 140, MODULE_ID = 'gachadnd') {
    const C = cell, runs = kind => {
        const shapes = [];
        for (let y = 0; y < P.rows; y++) {
            let x0 = -1;
            for (let x = 0; x <= P.cols; x++) {
                const hit = x < P.cols && P.get(x, y) === kind;
                if (hit && x0 < 0) x0 = x;
                if (!hit && x0 >= 0) { shapes.push({ type: 'rectangle', x: x0 * C, y: y * C, width: (x - x0) * C, height: C }); x0 = -1; }
            }
        }
        return shapes;
    };
    const out = [];
    const chasm = runs(CHASM), rubble = runs(RUBBLE);
    if (chasm.length) out.push({ name: t('Провал'), color: '#1b2a3a', shapes: chasm, locked: true, behaviors: [], flags: { [MODULE_ID]: { terrain: 'chasm' } } });
    if (rubble.length) {
        const dnd = !!CONFIG.RegionBehavior?.dataModels?.['dnd5e.difficultTerrain'];
        out.push({ name: t('Завал'), color: '#7a6450', shapes: rubble, locked: true,
            behaviors: [dnd ? { name: t('Трудная местность'), type: 'dnd5e.difficultTerrain', system: { types: ['rocks'] } }
                : { name: t('Трудная местность'), type: 'modifyMovementCost', system: { difficulties: Object.fromEntries(Object.keys(CONFIG.Token.movement?.actions ?? { walk: 1 }).map(a => [a, 2])) } }],
            flags: { [MODULE_ID]: { terrain: 'rubble' } } });
    }
    return out;
}

/**
 * Клетки для токенов: open[y][x] — можно встать; отряд — кромка отряда от середины; враги по ролям: ближний бой —
 * передняя часть кромки врагов, стрелки — задняя, вожак — в глубине по центру; запас — правая половина поля
 */
export function dungeonCells(P) {
    const open = Array.from({ length: P.rows }, (_, y) => Array.from({ length: P.cols }, (_, x) =>
        [FLOOR, RUBBLE, BRIDGE].includes(P.get(x, y)) && !P.blocked(x, y) && !P.doorAt(x, y)));
    const cells = list => list.map(([x, y]) => ({ x, y })).filter(c => open[c.y][c.x]);
    const mid = list => { const n = list.length || 1; return { x: list.reduce((s, c) => s + c.x, 0) / n, y: list.reduce((s, c) => s + c.y, 0) / n }; };
    const party = cells(P.zones.party), enemy = cells(P.zones.enemy);
    const pc = mid(party), ec = mid(enemy), maxX = Math.max(...enemy.map(c => c.x), 0);
    const by = (list, f) => [...list].sort((a, b) => f(a) - f(b));
    const half = [];
    for (let y = 0; y < P.rows; y++) for (let x = Math.floor(P.cols / 2); x < P.cols; x++) if (open[y][x]) half.push({ x, y });
    return {
        open,
        party: by(party, c => Math.hypot(c.x - pc.x, c.y - pc.y)),
        enemy: {
            melee: by(enemy, c => c.x * 3 + Math.abs(c.y - ec.y)),
            ranged: by(enemy, c => -c.x * 3 + Math.abs(c.y - ec.y)),
            leader: by(enemy, c => Math.hypot(c.x - (maxX - 1), c.y - ec.y)),
            flankTop: [], flankBottom: [],
            any: by(half, c => -c.x + Math.abs(c.y - ec.y) * 0.3)
        }
    };
}

/** Строка о месте для карточки встречи: схема, темнота, предметы арены */
export function dungeonNote(P) {
    const props = [...new Set(P.props.map(p => PROP_NAMES[p.kind]))].join('; ');
    return [P.note, DARK_NAMES[P.dark], props].filter(Boolean).join('; ');
}
