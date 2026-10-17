/**
 * Gacha Roguelike dnd5e — Зарисовки дневника
 *
 * Зарисовка — то, что видно в событии, набросанное пером в дневнике Разлома живыми чернилами (core/ink.js):
 * штрихи проступают по порядку, как будто рисунок делают на глазах, а потом медленно «дышат».
 * Каждая сцена — функция, которая раскладывает примитивы по листу 600 × 420. Зерно — событие: у всех
 * рисунок одинаковый.
 *
 * Два вида примитивов:
 *   линия (line)  — контур или деталь от руки, у каждой своя дрожь и течение;
 *   тон (tone)    — штриховка области: параллельные короткие штрихи с разрывами, слой за слоем; так строится
 *                   тёмное небо, масса леса, вода, тень коры. Пустые места (луна, огоньки, отражения) —
 *                   чистая бумага: их не штрихуют.
 * Слои рисуются по порядку: построение, контуры, детали, тон, тёмный тон, акценты. Свет (огоньки) — не чернила:
 * акварельные пятна поверх, проступают после рисунка.
 */

import { seeded, stroke, inkSvgPath, inkValues, inkMotion, resetInkClock, fmt } from "../core/ink.js";

export const SKETCH = { w: 600, h: 420 };

// ---------- Примитивы

/** Линия от руки. kind: faint — построение, main — контур, detail — деталь, accent — акцент поверх тона */
const line = (points, kind = 'main') => ({ points, kind });

/** Плавный шум: сумма синусов со случайными фазами, −1…1 */
function makeNoise(rand) {
    const waves = Array.from({ length: 4 }, (_, i) => ({ f: 0.6 + i * 1.7 + rand(), p: rand() * 10, a: 1 / (i + 1) }));
    const norm = waves.reduce((s, w) => s + w.a, 0);
    return x => waves.reduce((s, w) => s + Math.sin(x * w.f + w.p) * w.a, 0) / norm;
}

/** Волна: от x0 до x1 на высоте y */
function wave(x0, x1, y, amp, period, rand) {
    const pts = [];
    const phase = rand() * Math.PI * 2;
    for (let x = x0; x <= x1; x += 6) pts.push({ x, y: y + Math.sin(x / period * Math.PI * 2 + phase) * amp });
    return pts;
}

/**
 * Тон: штриховка области параллельными короткими штрихами с разрывами.
 * @param {(x, y) => boolean} inside  Где штриховать
 * @param {number[]} box              [x0, y0, x1, y1] — где искать
 * @param {object} o  angle — наклон штрихов (рад), gap — шаг между рядами, seg — длина штриха [от, до],
 *                    skip — разрыв [от, до], prob(x, y) — плотность 0…1, kind — tone | dark
 */
function tone(inside, [x0, y0, x1, y1], rand, { angle = -1, gap = 4.5, seg = [7, 20], skip = [2, 7], prob = () => 1, kind = 'tone', jitter = 0.7, turn = 0 } = {}) {
    const ca = Math.cos(angle), sa = Math.sin(angle), nx = -sa, ny = ca;
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
    const ds = corners.map(([x, y]) => x * nx + y * ny), ts = corners.map(([x, y]) => x * ca + y * sa);
    const tMin = Math.min(...ts), tMax = Math.max(...ts);
    const at = (d, t) => ({ x: nx * d + ca * t, y: ny * d + sa * t });
    const ok = p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && inside(p.x, p.y);
    const segs = [];
    for (let d = Math.min(...ds); d <= Math.max(...ds); d += gap * (0.8 + rand() * 0.4)) {
        let t = tMin + rand() * seg[1];
        while (t < tMax) {
            const L = seg[0] + rand() * (seg[1] - seg[0]);
            const a = at(d, t), b = at(d, t + L), m = at(d, t + L / 2);
            if (ok(a) && ok(b) && ok(m) && rand() < prob(m.x, m.y)) {
                const j = () => (rand() - 0.5) * 2 * jitter;
                // Рука не держит угол: штрих чуть повёрнут вокруг середины
                const r = (rand() - 0.5) * 2 * turn, c = Math.cos(r), s = Math.sin(r);
                const rot = p => ({ x: m.x + (p.x - m.x) * c - (p.y - m.y) * s + j(), y: m.y + (p.x - m.x) * s + (p.y - m.y) * c + j() });
                segs.push([rot(a), rot(b)]);
            }
            t += L + skip[0] + rand() * (skip[1] - skip[0]);
        }
    }
    return { segs, kind };
}

/** Камыш: изогнутый стебель и початок или лист */
function reed(x, base, h, lean, rand, out) {
    const top = { x: x + lean, y: base - h };
    out.push(line([{ x, y: base }, { x: x + lean * 0.35, y: base - h * 0.55 }, top], 'detail'));
    if (rand() < 0.65) {
        const cx = x + lean * 0.8, cy = base - h * 0.82, ry = 8 + rand() * 5, rx = 2.6;
        out.push(line(Array.from({ length: 13 }, (_, i) => {
            const a = i / 12 * Math.PI * 2;
            return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
        }), 'main'));
    } else {
        const s = rand() < 0.5 ? -1 : 1;
        out.push(line([{ x: x + lean * 0.3, y: base - h * 0.45 }, { x: x + lean * 0.3 + s * 14, y: base - h * 0.62 }, { x: x + lean * 0.3 + s * 26, y: base - h * 0.48 }], 'detail'));
    }
}

/** Пучок травы: короткие штрихи веером */
function tuft(x, y, rand, out, n = 5) {
    for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / (n - 1) - 0.5) * 1.2 + (rand() - 0.5) * 0.2, l = 7 + rand() * 9;
        out.push(line([{ x: x + (i - n / 2) * 1.5, y }, { x: x + (i - n / 2) * 1.5 + Math.cos(a) * l, y: y + Math.sin(a) * l }], 'detail'));
    }
}

/** Ель силуэтом: ярусы-зигзаги по кромке леса */
function spruce(x, base, h, rand, out) {
    const pts = [{ x: x - h * 0.22, y: base }];
    const tiers = 4 + Math.floor(rand() * 3);
    for (let i = 1; i <= tiers; i++) {
        const t = i / tiers, w = h * 0.22 * (1 - t * 0.85);
        pts.push({ x: x - w * 0.5, y: base - h * (t - 0.12) }, { x: x - w, y: base - h * (t - 0.05) });
    }
    pts.push({ x, y: base - h - 4 });
    for (let i = tiers; i >= 1; i--) {
        const t = i / tiers, w = h * 0.22 * (1 - t * 0.85);
        pts.push({ x: x + w, y: base - h * (t - 0.05) }, { x: x + w * 0.5, y: base - h * (t - 0.12) });
    }
    pts.push({ x: x + h * 0.22, y: base });
    out.push(line(pts, 'detail'));
}

/** Сухое дерево: ствол сужается к верхушке, кора — тоном с теневой стороны, ветви, мох свисает */
function deadTree(x, base, h, rand, out, { shade = 1, moss = 0.5, depth = 4 } = {}) {
    const lean = (rand() - 0.5) * 26;
    const edge = (s, t) => x + lean * t * t + s * (11 - 9.5 * t);
    const trunk = s => [0, 0.2, 0.4, 0.6, 0.8, 1].map(t => ({ x: edge(s, t) + (t > 0 && t < 1 ? (rand() - 0.5) * 3 : 0), y: base - h * t }));
    out.push(line(trunk(-1)), line(trunk(1)));
    // Кора: тон с теневой (правой) стороны ствола
    out.push(tone((px, py) => {
        const t = (base - py) / h;
        if (t < 0 || t > 0.92) return false;
        const mid = x + lean * t * t, right = edge(1, t);
        return px > mid - 1 && px < right - 0.5;
    }, [x - 20, base - h, x + 40, base], rand, { angle: -1.35, gap: 2.4 * shade, seg: [5, 14], skip: [1, 4], kind: 'dark' }));
    // Сучки и трещины коры
    for (let i = 0; i < 6; i++) {
        const t = 0.1 + rand() * 0.6, cx = x + lean * t * t + (rand() - 0.6) * 6 * (1 - t);
        out.push(line([{ x: cx, y: base - h * t }, { x: cx + (rand() - 0.5) * 2, y: base - h * t - 6 - rand() * 12 }], 'detail'));
    }
    // Корни в воду
    for (const s of [-1, 1]) out.push(line([{ x: x + s * 11, y: base }, { x: x + s * 24, y: base + 5 }, { x: x + s * 38, y: base + 3 }], 'detail'));
    const tips = [];
    const branch = (p, angle, len, d) => {
        if (d > depth || len < 7) { tips.push(p); return; }
        const end = { x: p.x + Math.cos(angle) * len, y: p.y + Math.sin(angle) * len };
        const mid = { x: (p.x + end.x) / 2 + (rand() - 0.5) * 7, y: (p.y + end.y) / 2 + (rand() - 0.5) * 7 };
        out.push(line([p, mid, end], d < 2 ? 'main' : 'detail'));
        branch(end, angle - 0.35 - rand() * 0.45, len * 0.66, d + 1);
        if (rand() < 0.75) branch(end, angle + 0.3 + rand() * 0.45, len * 0.58, d + 1);
        if (rand() < moss && d >= 1) tips.push(mid);
    };
    const at = t => ({ x: x + lean * t * t, y: base - h * t });
    branch(at(0.5), -Math.PI / 2 - 1.05, h * 0.34, 0);
    branch(at(0.66), -Math.PI / 2 + 0.8, h * 0.3, 0);
    branch(at(0.82), -Math.PI / 2 - 0.55, h * 0.22, 1);
    branch(at(0.97), -Math.PI / 2 + 0.15, h * 0.2, 1);
    // Мох: волнистые пряди с ветвей
    for (const p of tips.filter(() => rand() < moss * 0.6)) {
        const l = 12 + rand() * 26, pts = [];
        for (let k = 0; k <= 5; k++) pts.push({ x: p.x + Math.sin(k * 1.4 + rand()) * 2.4, y: p.y + l * k / 5 });
        out.push(line(pts, 'detail'));
    }
}

/** Кольцо от руки: чуть незамкнутое */
function ring(cx, cy, r, rand, kind = 'detail', sy = 1) {
    const start = rand() * Math.PI * 2, turn = Math.PI * 2 * (1.04 + rand() * 0.08);
    return line(Array.from({ length: 21 }, (_, i) => {
        const a = start + turn * i / 20, rr = r * (1 + (rand() - 0.5) * 0.1);
        return { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr * sy };
    }), kind);
}

// ---------- Сцены

const SCENES = {
    /** Болото ночью: тёмное небо и луна, ельник на горизонте, туман, сухие деревья, огоньки над водой */
    swampLights(rand) {
        const out = [], lights = [];
        const N = makeNoise(rand);
        const forestTop = x => 150 + N(x / 23 + 3) * 13 + N(x / 7 + 9) * 4;
        const horizon = x => 203 + N(x / 50) * 3;
        const moon = { x: 470, y: 70, r: 24 };
        const spots = [[292, 226, 1], [352, 192, 0.8], [420, 238, 0.95], [470, 178, 0.6]];
        const nearLight = (x, y, pad = 0) => spots.some(([lx, ly, k]) => Math.hypot(x - lx, y - ly) < 18 * k + pad);
        const leftBank = x => 268 + N(x / 30 + 1) * 4 + (x > 200 ? (x - 200) * 0.3 : 0);
        const rightBank = x => 276 + N(x / 30 + 5) * 4 + (x < 420 ? (420 - x) * 0.3 : 0);
        const pads = [[300, 352, 15], [362, 388, 12], [246, 398, 13], [432, 362, 11], [520, 396, 14]];
        const onPad = (x, y) => pads.some(([px, py, r]) => Math.hypot((x - px) / r, (y - py) / (r * 0.38)) < 1.15);

        // Построение: кромка леса, горизонт, берега
        out.push(line(Array.from({ length: 61 }, (_, i) => ({ x: i * 10, y: forestTop(i * 10) })), 'faint'));
        out.push(line(Array.from({ length: 31 }, (_, i) => ({ x: i * 20, y: horizon(i * 20) })), 'faint'));
        out.push(line(Array.from({ length: 27 }, (_, i) => ({ x: i * 10, y: leftBank(i * 10) }))));
        out.push(line(Array.from({ length: 21 }, (_, i) => ({ x: 400 + i * 10, y: rightBank(400 + i * 10) }))));

        // Луна — бумага в кольце, пара пятен
        out.push(ring(moon.x, moon.y, moon.r, rand, 'main'));
        out.push(ring(moon.x - 7, moon.y - 4, 5, rand), ring(moon.x + 8, moon.y + 7, 3.5, rand));
        // Небо: тон гуще к верху, луну и огоньки не трогает; у самого верха — второй слой крест-накрест
        out.push(tone((x, y) => y < forestTop(x) - 3 && Math.hypot(x - moon.x, y - moon.y) > moon.r + 7 && !nearLight(x, y, 10),
            [0, 0, 600, 175], rand, { angle: -0.8, gap: 4.6, seg: [4, 12], skip: [2, 6], turn: 0.16, prob: (x, y) => 0.12 + 0.62 * Math.pow(1 - y / 175, 1.1) }));
        out.push(tone((x, y) => y < 70 && Math.hypot(x - moon.x, y - moon.y) > moon.r + 34,
            [0, 0, 600, 70], rand, { angle: 0.45, gap: 6, seg: [4, 10], skip: [3, 8], turn: 0.18, prob: (x, y) => 0.6 * (1 - y / 70), kind: 'dark' }));

        // Ельник: ели по кромке, масса леса — плотный тон
        for (let x = 6; x < 600; x += 14 + rand() * 18) spruce(x, forestTop(x) + 16, 22 + rand() * 20, rand, out);
        out.push(tone((x, y) => y > forestTop(x) + 4 && y < horizon(x) && !nearLight(x, y, 8), [0, 130, 600, 210], rand, { angle: -1.48, gap: 2.4, seg: [5, 12], skip: [1, 3], prob: () => 0.95 }));
        out.push(tone((x, y) => y > forestTop(x) + 10 && y < horizon(x) - 2 && !nearLight(x, y, 12), [0, 130, 600, 210], rand, { angle: -0.6, gap: 3.6, seg: [5, 12], skip: [2, 5], prob: () => 0.7, kind: 'dark' }));

        // Туман над водой — бумага с парой бледных волн
        for (const [x0, x1, y] of [[40, 300, 214], [240, 570, 222], [100, 470, 236]]) out.push(line(wave(x0, x1, y, 2.6, 90, rand), 'faint'));

        // Вода: горизонтальный тон гуще к переднему плану; отражения огоньков и луны — бумага
        const reflect = (x, y) => spots.some(([lx, , k]) => Math.abs(x - lx) < (9 * k + 2) * (1 - (y - 250) / 170) && y < 380)
            || (Math.abs(x - moon.x) < 9 && y > 246 && Math.sin(y * 0.9) > -0.3);
        out.push(tone((x, y) => y > 244 && y < 418 && y > (x < 270 ? leftBank(x) + 4 : 0) && y > (x > 400 ? rightBank(x) + 4 : 0) && !reflect(x, y) && !onPad(x, y),
            [0, 240, 600, 420], rand, { angle: 0.02, gap: 4.4, seg: [8, 26], skip: [3, 10], prob: (x, y) => 0.3 + 0.6 * (y - 240) / 180 }));
        // Берега — тёмная масса
        out.push(tone((x, y) => x < 270 && y > leftBank(x) && y < leftBank(x) + 26 - x * 0.05, [0, 255, 270, 300], rand, { angle: -0.8, gap: 2.6, seg: [5, 12], skip: [1, 3], kind: 'dark' }));
        out.push(tone((x, y) => x > 400 && y > rightBank(x) && y < rightBank(x) + 22, [400, 262, 600, 305], rand, { angle: -0.8, gap: 2.6, seg: [5, 12], skip: [1, 3], kind: 'dark' }));

        // Сухие деревья: большое слева, малое справа; отражения — ломаные вертикали
        deadTree(150, 272, 210, rand, out, { moss: 0.7 });
        deadTree(552, 282, 120, rand, out, { moss: 0.5, depth: 3 });
        for (const [tx, h] of [[150, 90], [552, 55]]) for (let i = 0; i < 9; i++) {
            const y = 286 + i * (h / 9), w = 3 + rand() * 4;
            out.push(line([{ x: tx - w + (rand() - 0.5) * 4, y }, { x: tx + w + (rand() - 0.5) * 4, y: y + 1 }], 'accent'));
        }

        // Камыш и трава по берегам
        for (let i = 0; i < 14; i++) reed(18 + i * 8 + rand() * 6, 276 + rand() * 6, 55 + rand() * 55, (rand() - 0.3) * 20, rand, out);
        for (let i = 0; i < 6; i++) reed(214 + i * 9 + rand() * 5, 284 + rand() * 5, 40 + rand() * 30, (rand() - 0.5) * 16, rand, out);
        for (let i = 0; i < 11; i++) reed(438 + i * 9 + rand() * 6, 288 + rand() * 6, 50 + rand() * 45, (rand() - 0.6) * 20, rand, out);
        for (const [x, y] of [[80, 272], [190, 276], [470, 284], [585, 282]]) tuft(x, y, rand, out);

        // Передний план: коряга с кольцами на срезе
        out.push(line([{ x: 8, y: 392 }, { x: 90, y: 384 }, { x: 176, y: 372 }]), line([{ x: 10, y: 410 }, { x: 96, y: 402 }, { x: 178, y: 392 }]));
        out.push(ring(182, 382, 10, rand, 'main', 1.05), ring(182, 382, 6, rand), ring(182, 382, 2.5, rand));
        out.push(tone((x, y) => x < 172 && y > 392 - x * 0.12 && y < 410 - x * 0.1, [0, 370, 180, 412], rand, { angle: -0.25, gap: 2.4, seg: [8, 18], skip: [1, 4], kind: 'dark' }));
        // Кувшинки: овал с вырезом
        for (const [px, py, r] of pads) {
            out.push(ring(px, py, r, rand, 'detail', 0.38));
            out.push(line([{ x: px, y: py }, { x: px + r * 0.8, y: py - r * 0.18 }], 'detail'));
        }

        // Огоньки: кольцо пером, искры, пунктир следа, свет поверх
        spots.forEach(([x, y, k], i) => {
            out.push(ring(x, y, 6 * k + 2, rand, 'accent'));
            for (let s = 0; s < 4; s++) {
                const a = s * Math.PI / 2 + Math.PI / 4 + (rand() - 0.5) * 0.3, r0 = 10 * k + 3, r1 = r0 + 4 + rand() * 4;
                out.push(line([{ x: x + Math.cos(a) * r0, y: y + Math.sin(a) * r0 }, { x: x + Math.cos(a) * r1, y: y + Math.sin(a) * r1 }], 'accent'));
            }
            lights.push({ x, y, r: 26 * k });
            if (i) {
                const [px, py] = spots[i - 1];
                for (let t = 0.22; t < 0.8; t += 0.14) out.push(line([{ x: px + (x - px) * t, y: py + (y - py) * t }, { x: px + (x - px) * (t + 0.05), y: py + (y - py) * (t + 0.05) }], 'accent'));
            }
        });
        return { strokes: out, lights };
    }
};

// ---------- Отрисовка

// Порядок слоёв и вид штриха
const STAGE = { faint: 0, main: 1, detail: 2, tone: 3, dark: 4, accent: 5 };
const WIDTH = { faint: 1.3, main: 2.3, detail: 1.5, tone: 1.0, dark: 1.05, accent: 1.6 };
const TONE_CHUNK = 45;

/** Тон: штрихи пачками по TONE_CHUNK в один путь (меньше узлов в разметке); две формы — штрихи чуть дышат */
function tonePaths(t, rand) {
    const out = [];
    for (let i = 0; i < t.segs.length; i += TONE_CHUNK) {
        const chunk = t.segs.slice(i, i + TONE_CHUNK);
        const form = k => chunk.map(([a, b]) => {
            const j = () => (rand() - 0.5) * k;
            return `M ${fmt(a.x + j())} ${fmt(a.y + j())} L ${fmt(b.x + j())} ${fmt(b.y + j())}`;
        }).join(' ');
        out.push({ forms: [form(0), form(0.9), form(0.9)], n: chunk.length });
    }
    return out;
}

/**
 * Зарисовка как SVG. Слои проступают по порядку (draw: at, dur), свет — после рисунка.
 * @param {string} scene  Имя сцены
 * @param {string} seed   Зерно — у всех одинаковый рисунок
 * @returns {{ svg: string, duration: number }} duration — сколько секунд рисуется
 */
export function renderSketch(scene, seed = scene) {
    const rand = seeded(`${scene}|${seed}`);
    const { strokes, lights = [] } = SCENES[scene](rand);
    resetInkClock();
    const items = strokes.map((s, i) => ({ ...s, i })).sort((a, b) => STAGE[a.kind] - STAGE[b.kind] || a.i - b.i);
    // Время пера: у каждого слоя своя скорость; слои немного перекрываются
    const SPEED = { faint: 0.02, main: 0.055, detail: 0.018, tone: 0.06, dark: 0.06, accent: 0.035 };
    let t = 0.2, stage = -1;
    const ink = [], tones = [];
    for (const s of items) {
        if (STAGE[s.kind] !== stage) { stage = STAGE[s.kind]; t = Math.max(0.2, t - 0.4); }
        if (s.segs) {
            for (const p of tonePaths(s, rand)) {
                const dur = 0.35 + p.n * 0.008;
                tones.push(inkSvgPath(p.forms, rand, { cls: `gd-sk-${s.kind}`, style: `stroke-width: ${WIDTH[s.kind]}px`, draw: { at: t, dur } }));
                t += SPEED[s.kind];
            }
            continue;
        }
        const { forms, points } = stroke(s.points, rand, { wobble: s.kind === 'main' ? 1.3 : 0.9, flow: s.kind === 'main' ? 1.2 : 0.8, spacing: 9 });
        let len = 0;
        for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        const dur = Math.min(0.6, Math.max(0.08, len / 480));
        (s.kind === 'accent' ? tones : ink).push(inkSvgPath(forms, rand, { cls: `gd-sk-${s.kind}`, style: `stroke-width: ${WIDTH[s.kind]}px`, draw: { at: t, dur } }));
        t += SPEED[s.kind];
    }
    const glow = lights.map((l, i) => `<circle class="gd-sk-light" cx="${l.x}" cy="${l.y}" r="${l.r}" style="--at: ${(t + 0.2 + i * 0.25).toFixed(2)}s; --pulse: ${(2.6 + i * 0.5).toFixed(1)}s"/>`).join('');
    // Контуры — под фильтром расплывания чернил; тон и акценты — без него (тонкий штрих фильтр съел бы); свет — поверх
    const svg = `<svg class="gd-sketch" viewBox="0 0 ${SKETCH.w} ${SKETCH.h}">
        <defs><filter id="gd-ink-bleed" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="0.8"/><feComponentTransfer><feFuncA type="table" tableValues="0 0 1 1"/></feComponentTransfer></filter>
        <radialGradient id="gd-sk-light"><stop offset="0" stop-color="#d9fff2" stop-opacity="0.95"/><stop offset="0.3" stop-color="#6fd3bb" stop-opacity="0.55"/><stop offset="1" stop-color="#4fb9a2" stop-opacity="0"/></radialGradient></defs>
        <g class="gd-ink">${ink.join('')}</g><g class="gd-sk-tones">${tones.join('')}</g>${glow}</svg>`;
    return { svg, duration: t + 0.2 + lights.length * 0.25 + 0.8 };
}

export const sketchScenes = () => Object.keys(SCENES);

/**
 * Стрелка пером от пометки к месту на рисунке (координаты зарисовки): изогнутое древко и два уса.
 * @returns {string} <path>-ы с прорисовкой через at секунд
 */
export function sketchArrow(from, to, seed, at, scale = 1) {
    const rand = seeded(`arrow|${seed}`);
    const mid = { x: (from.x + to.x) / 2 + (rand() - 0.5) * 40, y: (from.y + to.y) / 2 - 20 - rand() * 20 };
    const shaft = stroke([from, mid, to], rand, { wobble: 1.2, flow: 1, spacing: 10 });
    const a = Math.atan2(to.y - mid.y, to.x - mid.x);
    const tip = s => ({ x: to.x - Math.cos(a + s * 0.5) * 12 * scale, y: to.y - Math.sin(a + s * 0.5) * 12 * scale });
    const heads = [-1, 1].map(s => stroke([tip(s), to], rand, { wobble: 0.6, flow: 0.6, spacing: 6 }));
    return [shaft, ...heads].map((st, i) => inkSvgPath(st.forms, rand, { cls: 'gd-sk-note', style: `stroke-width: ${(1.8 * scale).toFixed(2)}px`, draw: { at: at + (i ? 0.45 + i * 0.08 : 0), dur: i ? 0.12 : 0.45 } })).join('');
}

// ---------- Зарисовка-картинка: рисунок автора, проявленный пером

/**
 * Готовый рисунок (монохромный набросок на белом фоне) как страница дневника:
 *   — бумага: белый фон убран, графит становится чернилами с прозрачностью по тону — сквозь него виден пергамент;
 *   — проявление: сначала самые тёмные линии, потом штриховка, потом растушёвка (порог по тону уходит вниз),
 *     и не ровно по листу, а участками: к тону добавлен медленный шум, к концу он сходит на нет;
 *   — живые чернила: готовый рисунок едва колышется (смещение по медленному шуму на 1–2 пикселя);
 *   — края: рисунок обрывается неровно (овал, порванный шумом) и светлеет к периферии — подробности в центре;
 *   — свет: акварельные пятна поверх в точках lights, после рисунка.
 * @param {object} o  src — путь картинки; w, h — её размер; lights — [{ x, y, r }] в пикселях картинки;
 *                    seed — зерно; live — анимировать (иначе рисунок сразу целиком)
 * @returns {{ svg: string, duration: number }}
 */
export function renderImageSketch({ src, w, h, lights = [], seed = src, live = true }) {
    const rand = seeded(`image|${seed}`);
    const id = `gd-sk-${Math.floor(rand() * 1e9).toString(36)}`;
    const REVEAL = 6.5;
    const motion = inkMotion(rand);
    // Порог по тону ведёт код (revealImageSketch): SMIL-анимация фильтра в Chrome перерисовывается ненадёжно
    const glow = lights.map((l, i) => `<circle class="gd-sk-light" cx="${l.x}" cy="${l.y}" r="${(l.r * 1.7).toFixed(1)}" style="--at: ${(live ? REVEAL - 0.6 + i * 0.25 : 0).toFixed(2)}s; --pulse: ${(2.6 + i * 0.5).toFixed(1)}s"/>`).join('');
    const svg = `<svg class="gd-sketch gd-sketch-image" viewBox="0 0 ${w} ${h}">
        <defs>
            <filter id="${id}-ink" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
                <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0.08  0 0 0 0 0.07  0 0 0 0 0.06  -0.299 -0.587 -0.114 0 1" result="ink"/>
                <feTurbulence type="fractalNoise" baseFrequency="0.007" numOctaves="2" seed="${Math.floor(rand() * 100)}" result="noise"/>
                <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="patch"/>
                <feComposite class="gd-sk-patch" in="ink" in2="patch" operator="arithmetic" k1="0" k2="1" k3="${live ? 0.55 : 0}" k4="${live ? -0.27 : 0}" result="mix"/>
                <feComponentTransfer in="mix"><feFuncA class="gd-sk-threshold" type="linear" slope="${live ? 6 : 1.12}" intercept="${live ? -6.3 : -0.06}"/></feComponentTransfer>
            </filter>
            <filter id="${id}-live" x="-2%" y="-2%" width="104%" height="104%">
                <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="2" seed="${Math.floor(rand() * 100)}">
                    <animate attributeName="baseFrequency" values="0.011;0.0135;0.011" dur="${(9 + rand() * 4).toFixed(1)}s" begin="${motion.begin}s" repeatCount="indefinite"/>
                </feTurbulence>
                <feDisplacementMap in="SourceGraphic" scale="2.2" xChannelSelector="R" yChannelSelector="G"/>
            </filter>
            <filter id="${id}-rag" x="-15%" y="-15%" width="130%" height="130%">
                <feTurbulence type="fractalNoise" baseFrequency="0.009" numOctaves="4" seed="${Math.floor(rand() * 100)}" result="rag"/>
                <feDisplacementMap in="SourceGraphic" in2="rag" scale="${Math.round(w * 0.12)}" xChannelSelector="R" yChannelSelector="G"/>
            </filter>
            <radialGradient id="${id}-fade" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0" stop-color="#fff"/><stop offset="0.62" stop-color="#fff"/><stop offset="0.8" stop-color="#b8b8b8"/>
                <stop offset="0.9" stop-color="#3a3a3a"/><stop offset="1" stop-color="#000"/>
            </radialGradient>
            <mask id="${id}-edge" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">
                <ellipse cx="${w * 0.5}" cy="${h * 0.49}" rx="${w * 0.55}" ry="${h * 0.58}" fill="url(#${id}-fade)" filter="url(#${id}-rag)"/>
            </mask>
            <radialGradient id="gd-sk-light"><stop offset="0" stop-color="#e9fff8" stop-opacity="0.95"/><stop offset="0.3" stop-color="#7fe0c8" stop-opacity="0.55"/><stop offset="1" stop-color="#4fb9a2" stop-opacity="0"/></radialGradient>
        </defs>
        <g filter="url(#${id}-live)"><g mask="url(#${id}-edge)"><image href="${src}" width="${w}" height="${h}" filter="url(#${id}-ink)"/></g></g>
        ${glow}</svg>`;
    return { svg, duration: live ? REVEAL + lights.length * 0.25 + 0.6 : 0, reveal: REVEAL };
}

// Порог проявления по времени (доля 0…1): крутой наклон — открытое сразу тёмное: сначала линии темнее 0,6,
// потом темнее 0,3; к концу наклон мягкий — возвращаются полутона растушёвки
const THRESHOLD = [[0, 6, -6.3], [0.35, 6, -3.6], [0.72, 4, -1.2], [1, 1.12, -0.06]];
function thresholdAt(k) {
    const i = Math.max(1, THRESHOLD.findIndex(([t]) => t >= k));
    const [t0, s0, c0] = THRESHOLD[i - 1], [t1, s1, c1] = THRESHOLD[Math.min(i, THRESHOLD.length - 1)];
    const u = t1 > t0 ? Math.min(1, Math.max(0, (k - t0) / (t1 - t0))) : 1;
    const e = u * u * (3 - 2 * u);
    return { slope: s0 + (s1 - s0) * e, intercept: c0 + (c1 - c0) * e };
}

/**
 * Проявление рисунка-картинки по тону. root — элемент, где лежит SVG зарисовки.
 * @returns {{ seek(k): void, stop(): void }} seek — поставить долю проявления (проверки), stop — остановить
 */
export function revealImageSketch(root, seconds, { delay = 0.1 } = {}) {
    const funcs = [...root.querySelectorAll('.gd-sk-threshold')];
    const patches = [...root.querySelectorAll('.gd-sk-patch')];
    if (!funcs.length) return { seek() {}, stop() {} };
    const set = k => {
        const { slope, intercept } = thresholdAt(k);
        for (const f of funcs) { f.setAttribute('slope', slope.toFixed(3)); f.setAttribute('intercept', intercept.toFixed(3)); }
        // Участки: шум сильнее в начале, к последней трети гаснет — рисунок становится ровно таким, как нарисован
        const p = Math.max(0, 1 - Math.max(0, k - 0.6) / 0.4);
        for (const c of patches) { c.setAttribute('k3', (0.55 * p).toFixed(3)); c.setAttribute('k4', (-0.27 * p).toFixed(3)); }
    };
    let frame = null, stopped = false;
    const start = performance.now() + delay * 1000;
    const step = now => {
        if (stopped) return;
        const k = Math.min(1, Math.max(0, (now - start) / (seconds * 1000)));
        set(k);
        if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return { seek(k) { stopped = true; cancelAnimationFrame(frame); set(k); }, stop() { stopped = true; cancelAnimationFrame(frame); } };
}
