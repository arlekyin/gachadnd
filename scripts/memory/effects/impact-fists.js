/**
 * Gacha Roguelike dnd5e — Импакт-кадр «Кулаки» (Сайтама)
 *
 * После применения урона экран темнеет, и в экран один за другим летят пять кулаков: по дуге,
 * с вращением и следами, на попадании пружинят и потом медленно наезжают дальше. Каждый удар —
 * звук, тряска экрана, светящиеся трещины и клубы пыли от кулака и негатив кадра: инвертируется
 * всё, и кулаки, и сцена под ними. Пятый кулак — по центру и крупнее всех: после него кадр
 * заливает белая вспышка, и сквозь неё возвращается сцена. Всё рисуется векторами в разрешении
 * экрана поверх живой сцены. «Без вспышек» убирает негатив и белую вспышку.
 */

import { seeded, valueNoise, lerp, clamp01, smooth, easeIn, easeOut, wobble } from "../../cutscene/math.js";
import { setNegative as applyNegative } from "../../cutscene/overlay.js";
import { rippleFor } from "../../cutscene/ripple.js";

// Хронометраж, мс: затемнение, полёт кулака к экрану, удержание удара; после пятого —
// трещины, вспышка и возвращение сцены
// crack — трещины удара разбегаются; shake — тряска от удара; puff — клубы пыли; pop — пружина кулака
// Первые четыре удара — очередью: короткий полёт и удержание; перед пятым — пауза (pause),
// и он летит дольше (finalFly)
const T = {
    dark: 220, firstFly: 180, fly: 115, hold: 75, pause: 280, finalFly: 160,
    cracks: 170, flash: 200, fade: 380, finalHold: 420, finalNegative: 120, crack: 120, shake: 240, puff: 600, pop: 280,
    ripple: 520
};
// Тряска от удара, доля меньшей стороны экрана: обычного и пятого
const SHAKE = { hit: 0.028, final: 0.05 };
// Цвета обычного кадра: тёплый белый и тёмный; негатив делает их холодными, как в аниме
const COLOR = { crack: '#ffe4dc', glow: 'rgba(255,140,130,0.35)', puff: '255,236,230' };
// Куда прилетают кулаки: первые четыре — по углам экрана, пятый — в центре; поворот у каждого свой.
// Размеры подобраны так, чтобы кулаки не перекрывали друг друга
const FISTS = [
    { corner: [-1, -1], rot: -0.22 },
    { corner: [1, 1], rot: 0.26 },
    { corner: [1, -1], rot: 0.14 },
    { corner: [-1, 1], rot: -0.3 },
    { corner: null, rot: 0 }
];
// Угловой кулак — доля меньшей стороны экрана; отступ от края и зазор до центрального — тоже
const CORNER = { size: 0.42, pad: 0.03, gap: 0.03 };

// Места и размеры кулаков на экране W×H, пиксели
function layout(W, H) {
    const unit = Math.min(W, H), size = unit * CORNER.size, pad = unit * CORNER.pad;
    // Высота кулака — около 0,9 ширины
    const corners = FISTS.slice(0, 4).map(({ corner: [cx, cy] }) => ({
        x: cx < 0 ? pad + size / 2 : W - pad - size / 2,
        y: cy < 0 ? pad + size * 0.45 : H - pad - size * 0.45,
        size
    }));
    // Центральный — во всю ширину между угловыми, но не больше 0,75 и не меньше 0,4 меньшей стороны
    const free = W - 2 * (pad + size + unit * CORNER.gap);
    const center = { x: W / 2, y: H * 0.52, size: Math.min(unit * 0.75, Math.max(unit * 0.4, free)) };
    return [...corners, center];
}

// ==========================================
// КУЛАК ИЗ РИСУНКА (assets/impact/fist.svg)
// ==========================================

// Рисунок кулака: белое тело и тёмные линии, без фона. Загружается один раз
const ART_URL = new URL('../../../assets/impact/fist.svg', import.meta.url).href;
let art = null;

/** Загрузить рисунок и найти его рамку (рисунок в файле не по центру). null — рисунка нет */
function loadFistArt() {
    art ??= new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            // Рамка рисунка — по непрозрачным пикселям
            const probe = document.createElement('canvas');
            probe.width = img.naturalWidth || 535; probe.height = img.naturalHeight || 423;
            const px = probe.getContext('2d', { willReadFrequently: true });
            px.drawImage(img, 0, 0, probe.width, probe.height);
            const d = px.getImageData(0, 0, probe.width, probe.height).data;
            let x0 = probe.width, y0 = probe.height, x1 = 0, y1 = 0;
            for (let y = 0; y < probe.height; y++) for (let x = 0; x < probe.width; x++) {
                if (d[(y * probe.width + x) * 4 + 3] < 20) continue;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            resolve(x1 > x0 ? { img, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, W: probe.width, H: probe.height } } : null);
        };
        img.onerror = () => { console.warn('gachadnd | рисунок кулака не загружен', ART_URL); resolve(null); };
        img.src = ART_URL;
    });
    return art;
}

/**
 * Кулак из рисунка — один раз на размер, поверх — эффекты как в рисованном оригинале; они же
 * прячут огрехи трассировки:
 *  - свечение: широкий мягкий ореол вокруг силуэта и пересвет — белое «выжигает» часть тела
 *    сверху справа, линии там бледнеют;
 *  - штрих печати: короткие горизонтальные чёрточки и точки лентами вдоль линий и по теневой
 *    стороне (слева и снизу), клочьями, только по телу;
 *  - мыло: несколько мягких пятен, где рисунок размыт, — края и части кулака не в фокусе;
 *  - размытое белое пятно силуэта — кулак издалека, пока летит.
 * @param {number} size  Ширина кулака, пиксели.
 */
function artSprite({ img, box }, size, seed) {
    const k = size / box.w, w = Math.ceil(box.w * k), h = Math.ceil(box.h * k);
    const S = Math.ceil(Math.max(w, h) * 1.5), ox = (S - w) / 2, oy = (S - h) / 2;
    const make = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
    const rnd = seeded(seed);
    // Сам рисунок в нужном размере: вектор — резкий при любом увеличении
    const drawing = make(), dx = drawing.getContext('2d', { willReadFrequently: true });
    dx.drawImage(img, box.x, box.y, box.w, box.h, ox, oy, w, h);
    // Силуэт — белым
    const silhouette = make(), sx = silhouette.getContext('2d');
    sx.drawImage(drawing, 0, 0);
    sx.globalCompositeOperation = 'source-in';
    sx.fillStyle = '#fbf7f4';
    sx.fillRect(0, 0, S, S);

    // Где линии: тёмные пиксели рисунка, размытые — плотность штриха рядом с ними
    const ink = make(), ix = ink.getContext('2d', { willReadFrequently: true });
    {
        const src = dx.getImageData(0, 0, S, S), d = src.data;
        for (let i = 0; i < d.length; i += 4) {
            const dark = d[i + 3] > 40 && d[i] + d[i + 1] + d[i + 2] < 300;
            d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = dark ? 255 : 0;
        }
        const tmp = make(); tmp.getContext('2d').putImageData(src, 0, 0);
        ix.filter = `blur(${Math.max(2, size * 0.035)}px)`;
        ix.drawImage(tmp, 0, 0);
    }
    const near = ix.getImageData(0, 0, S, S).data;

    const body = make(), x = body.getContext('2d');
    x.drawImage(drawing, 0, 0);
    // Пересвет сверху справа: белое поверх рисунка, линии там бледнеют
    {
        const g = x.createRadialGradient(ox + w * 0.78, oy + h * 0.18, 0, ox + w * 0.78, oy + h * 0.18, Math.max(w, h) * 0.55);
        g.addColorStop(0, 'rgba(255,253,250,0.75)');
        g.addColorStop(0.5, 'rgba(255,253,250,0.3)');
        g.addColorStop(1, 'rgba(255,253,250,0)');
        x.save();
        x.globalCompositeOperation = 'source-atop';
        x.fillStyle = g;
        x.fillRect(0, 0, S, S);
        x.restore();
    }
    // Штрих печати
    const grain = make(), gx = grain.getContext('2d');
    const patch = valueNoise(seed + 11, 12);
    const count = Math.round(w * h * 0.11);
    const dot = Math.max(1, size * 0.0032);
    for (let i = 0; i < count; i++) {
        const u = rnd(), v = rnd(), px = Math.round(ox + u * w), py = Math.round(oy + v * h);
        const nearInk = near[(py * S + px) * 4 + 3] / 255;
        const side = Math.max(0, (1 - u) * 0.8 + v * 0.9 - 0.8);
        const tone = Math.min(1, nearInk * 1.6 + side) * (0.25 + patch(u * 1.5 - 0.75, v * 1.5 - 0.75) * 1.35);
        if (rnd() > tone * 0.7) continue;
        const d = dot * (0.7 + rnd() * 0.8);
        gx.fillStyle = `rgba(40,32,32,${0.4 + rnd() * 0.4})`;
        if (rnd() < 0.55) gx.fillRect(px, py, d * (2.5 + rnd() * 4), d * 0.75);
        else gx.fillRect(px, py, d, d);
    }
    gx.globalCompositeOperation = 'destination-in';
    gx.drawImage(silhouette, 0, 0);
    x.drawImage(grain, 0, 0);

    // Мыло: размытая копия сквозь мягкие пятна — у краёв и в паре мест на теле
    {
        const soft = make(), fx = soft.getContext('2d');
        fx.filter = `blur(${Math.max(1.5, size * 0.012)}px)`;
        fx.drawImage(body, 0, 0);
        fx.filter = 'none';
        const mask = make(), mx = mask.getContext('2d');
        const spots = [[0.05 + rnd() * 0.15, 0.3 + rnd() * 0.5], [0.85 + rnd() * 0.12, 0.2 + rnd() * 0.6], [0.3 + rnd() * 0.4, 0.88 + rnd() * 0.1], [rnd(), rnd() * 0.3], [0.25 + rnd() * 0.5, 0.3 + rnd() * 0.4]];
        for (const [u, v] of spots) {
            const cx = ox + u * w, cy = oy + v * h, r = Math.max(w, h) * (0.14 + rnd() * 0.14);
            const g = mx.createRadialGradient(cx, cy, 0, cx, cy, r);
            g.addColorStop(0, 'rgba(0,0,0,1)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            mx.fillStyle = g;
            mx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
        fx.globalCompositeOperation = 'destination-in';
        fx.drawImage(mask, 0, 0);
        x.drawImage(soft, 0, 0);
    }

    // Итог: свечение под телом — широкое мягкое и плотное узкое
    const c = make(), cx = c.getContext('2d');
    cx.filter = `blur(${Math.max(3, size * 0.05)}px)`;
    cx.globalAlpha = 0.85;
    cx.drawImage(silhouette, 0, 0);
    cx.filter = `blur(${Math.max(1, size * 0.012)}px)`;
    cx.globalAlpha = 1;
    cx.drawImage(silhouette, 0, 0);
    cx.filter = 'none';
    cx.drawImage(body, 0, 0);

    const blob = make(), bx = blob.getContext('2d');
    bx.filter = `blur(${Math.max(2, size * 0.05)}px)`;
    bx.drawImage(silhouette, 0, 0);
    bx.drawImage(silhouette, 0, 0);
    return { canvas: c, blob, size };
}

// Без рисунка (файл не загрузился) — белое скруглённое пятно вместо кулака
function plainSprite(size) {
    const S = Math.ceil(size * 1.5), c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    x.fillStyle = '#fbf7f4';
    x.beginPath();
    x.roundRect((S - size) / 2, (S - size * 0.8) / 2, size, size * 0.8, size * 0.2);
    x.fill();
    return { canvas: c, blob: c, size };
}

// Рисунки кулаков между показами: размер экрана обычно не меняется
const spriteCache = new Map();

// Рисунки всех пяти кулаков для экрана W×H — из запаса или заново
// С рисунком из файла — он; без него — нарисованный кодом кулак
function fistSprites(W, H, drawn = null) {
    return FISTS.map((_, i) => fistSprite_(W, H, drawn, i));
}

// Рисунок одного кулака — из запаса или заново
function fistSprite_(W, H, drawn, i) {
    const size = Math.ceil(layout(W, H)[i].size * 1.2), key = `${drawn ? 'art' : 'gen'}:${i}:${size}`;
    if (!spriteCache.has(key)) spriteCache.set(key, drawn ? artSprite(drawn, size, 31 + i * 17) : plainSprite(size));
    return spriteCache.get(key);
}

/** Нарисовать кулаки заранее (≈0,3 с), чтобы показ начался без задержки: зовётся при взводе навыка */
/**
 * Подготовить всё заранее: рисунки пяти кулаков под текущий экран и шейдер волн. Работа делится
 * на куски с паузами между ними — экран не замирает. Повторный вызов для того же размера
 * экрана ничего не делает.
 */
export async function prepareFists() {
    const drawn = await loadFistArt();
    const W = Math.round(innerWidth * devicePixelRatio), H = Math.round(innerHeight * devicePixelRatio);
    const idle = () => new Promise(resolve => (globalThis.requestIdleCallback ?? (f => setTimeout(f, 30)))(() => resolve(), { timeout: 500 }));
    for (let i = 0; i < FISTS.length; i++) {
        await idle();
        fistSprite_(W, H, drawn, i);
    }
    await idle();
    rippleFor(W, H);
}


// Нарисовать заготовку кулака: центр (x, y), ширина size, поворот, растяжение вдоль осей кулака
function drawSprite(ctx, sprite, x, y, size, rot, sx = 1, sy = 1, image = sprite.canvas) {
    const k = size / sprite.size, S = image.width;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(k * sx, k * sy);
    ctx.drawImage(image, -S / 2, -S / 2);
    ctx.restore();
}

// ==========================================
// ТРЕЩИНЫ И ВСПЫШКА
// ==========================================

// Трещины от точки удара: ветвящиеся ломаные; у каждого отрезка — порядок появления
function cracks(cx, cy, reach, seed) {
    const rnd = seeded(seed), segments = [];
    const grow = (x, y, angle, length, width, order, depth) => {
        let px = x, py = y;
        const steps = 4 + Math.floor(rnd() * 4);
        for (let i = 0; i < steps; i++) {
            angle += (rnd() - 0.5) * 0.7;
            const step = length / steps * (0.7 + rnd() * 0.6);
            const nx = px + Math.cos(angle) * step, ny = py + Math.sin(angle) * step;
            const at = order + i / steps;
            segments.push({ x0: px, y0: py, x1: nx, y1: ny, width: width * (1 - i / steps * 0.6), at });
            if (depth < 3 && rnd() < 0.3) grow(nx, ny, angle + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6), length * 0.55, width * 0.6, at, depth + 1);
            px = nx; py = ny;
        }
    };
    for (let i = 0, n = 14; i < n; i++) {
        const angle = i / n * Math.PI * 2 + rnd() * 0.4;
        grow(cx + Math.cos(angle) * reach * 0.25, cy + Math.sin(angle) * reach * 0.22, angle, reach * (0.6 + rnd() * 0.5), reach * 0.012, 0, 0);
    }
    const last = Math.max(...segments.map(s => s.at));
    segments.forEach(s => s.at /= last);
    return segments;
}

// Трещины одним путём; свет — тот же путь широкой полупрозрачной линией под основной
// (размытие тени на сотнях линий в каждом кадре тормозит показ)
function drawCracks(ctx, segments, progress, color, glow = null, glowWidth = 0) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const visible = segments.filter(s => s.at <= progress);
    const path = width => {
        ctx.beginPath();
        for (const s of visible) { ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1); }
        ctx.lineWidth = width;
        ctx.stroke();
    };
    const width = visible.length ? visible.reduce((sum, s) => sum + s.width, 0) / visible.length : 0;
    if (glow && glowWidth > 0) { ctx.strokeStyle = glow; path(width + glowWidth); }
    ctx.strokeStyle = color;
    path(width);
    ctx.restore();
}

// Клубы пыли от удара: мягкие пятна, разлетаются от кулака и тают
function drawPuffs(ctx, puffs, cx, cy, k, color) {
    if (k <= 0 || k >= 1) return;
    for (const p of puffs) {
        const d = p.dist * easeOut(k), r = p.size * (0.6 + 0.6 * k);
        const x = cx + Math.cos(p.a) * d, y = cy + Math.sin(p.a) * d;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${color},${0.85 * (1 - k)})`);
        g.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
}

// Вспышка: белый центр с лучами, по углам — тёмно-красное и чёрное
function drawFlash(ctx, W, H, power, rays) {
    const cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2;
    const corners = ctx.createRadialGradient(cx, cy, R * 0.35, cx, cy, R);
    corners.addColorStop(0, 'rgba(255,255,255,0)');
    corners.addColorStop(0.6, `rgba(150,20,20,${0.55 * power})`);
    corners.addColorStop(1, `rgba(20,0,0,${0.95 * power})`);
    ctx.fillStyle = corners;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `rgba(255,255,255,${0.35 * power})`;
    for (const r of rays) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(r.a - r.w) * R, cy + Math.sin(r.a - r.w) * R);
        ctx.lineTo(cx + Math.cos(r.a + r.w) * R, cy + Math.sin(r.a + r.w) * R);
        ctx.fill();
    }
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (0.55 + 0.35 * power));
    core.addColorStop(0, `rgba(255,255,255,${power})`);
    core.addColorStop(0.55, `rgba(255,250,250,${0.92 * power})`);
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, W, H);
}

// ==========================================
// ПОКАЗ
// ==========================================

/**
 * @param {object} options
 * @param {boolean} options.calm  Без инверсий и белой вспышки.
 * @param {number} options.slow   Замедление.
 * @param {(final: boolean, index: number, pan: number) => void} options.onHit  Звук удара; final — пятый
 *        кулак; pan — место кулака на экране, −1 слева … 1 справа.
 * @returns {Promise<void>}  Когда сцена вернулась.
 */
// quick — кулаки сразу после кадров света и молний: экран уже тёмный, затемнение мгновенное
export async function playFists(options = {}) {
    const drawn = await loadFistArt();
    return runFists({ ...options, drawn });
}

function runFists({ calm = false, slow = 1, onHit = () => {}, quick = false, drawn = null } = {}) {
    const dark = quick ? 40 : T.dark;
    return new Promise(resolve => {
        const cv = document.createElement('canvas');
        cv.className = 'gd-impact';
        cv.width = Math.round(innerWidth * devicePixelRatio);
        cv.height = Math.round(innerHeight * devicePixelRatio);
        document.body.append(cv);
        const out = cv.getContext('2d');
        const W = cv.width, H = cv.height, unit = Math.min(W, H);
        // Кадр рисуется в буфер, на экран — целиком или кольцами волн после пятого удара
        const buffer = document.createElement('canvas');
        buffer.width = W; buffer.height = H;
        const ctx = buffer.getContext('2d');
        const rnd = seeded(101);
        const rays = Array.from({ length: 90 }, () => ({ a: rnd() * Math.PI * 2, w: 0.002 + rnd() ** 2 * 0.012 }));
        // Полёт каждого кулака: откуда (рядом с центром), изгиб дуги, начальный поворот;
        // трещины и пыль удара — вокруг места попадания
        const spots = layout(W, H);
        // Рисунки кулаков — заранее, в размере попадания с запасом на пружину
        const sprites = fistSprites(W, H, drawn);
        const flights = FISTS.map((f, i) => {
            const { size, x, y } = spots[i];
            // Вылетает издалека рядом со своим местом, чуть ближе к центру экрана
            const from = { x: lerp(x, W / 2, 0.3) + (rnd() - 0.5) * size * 0.3, y: lerp(y, H / 2, 0.3) + (rnd() - 0.5) * size * 0.3 };
            const bend = (rnd() < 0.5 ? -1 : 1) * (0.12 + rnd() * 0.12) * unit;
            const dx = x - from.x, dy = y - from.y, len = Math.hypot(dx, dy) || 1;
            return {
                size, x, y, from, rot0: f.rot + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.5),
                control: { x: (from.x + x) / 2 - dy / len * bend, y: (from.y + y) / 2 + dx / len * bend },
                cracks: cracks(x, y, size * (i === 4 ? 0.9 : 1), 77 + i * 13),
                puffs: Array.from({ length: 5 }, () => ({ a: rnd() * Math.PI * 2, dist: size * (0.55 + rnd() * 0.5), size: size * (0.06 + rnd() * 0.06) }))
            };
        });
        // Где кулак при доле полёта k: по дуге, растёт с ускорением, доворачивается
        const place = (fl, k) => {
            const e = easeIn(k), u = 1 - e;
            return {
                x: u * u * fl.from.x + 2 * u * e * fl.control.x + e * e * fl.x,
                y: u * u * fl.from.y + 2 * u * e * fl.control.y + e * e * fl.y,
                size: fl.size * (0.06 + 0.94 * e),
                rot: fl.rot0 + (FISTS[flights.indexOf(fl)].rot - fl.rot0) * easeOut(k)
            };
        };

        // Расписание: начало полёта и момент удара каждого кулака
        const schedule = [];
        let clock = dark;
        FISTS.forEach((_, i) => {
            if (i === 4) clock += T.pause;
            const fly = i === 0 ? T.firstFly : i === 4 ? T.finalFly : T.fly;
            schedule.push({ start: clock, hit: clock + fly });
            // Следующий вылетает сразу, ещё во время негатива этого удара
            clock += fly;
        });
        const lastHit = schedule[4].hit;
        // В ударе Сайтамы (quick) после пятого — короткий негатив, и сразу полёт цели; без сцены
        // кулаки сами возвращают её — через вспышку
        const end = quick ? lastHit + T.finalHold : lastHit + T.cracks + T.flash + T.fade;
        const struck = new Set();
        let shake = { a: 0, power: 0, at: -1e9 };
        let negative = null;
        // Трещины прежних ударов — готовый слой: рисуются один раз, а не в каждом кадре
        const baked = document.createElement('canvas');
        baked.width = W; baked.height = H;
        const bakedCtx = baked.getContext('2d');
        const bakedSet = new Set();
        const bake = i => {
            if (bakedSet.has(i)) return;
            bakedSet.add(i);
            drawCracks(bakedCtx, flights[i].cracks, 1, COLOR.crack, COLOR.glow, unit * 0.006);
        };
        // Волны — отдельным холстом WebGL поверх, на время волн; без WebGL волн нет
        const rippleGL = rippleFor(W, H);
        if (rippleGL) {
            rippleGL.canvas.className = 'gd-impact';
            rippleGL.canvas.style.display = 'none';
            document.body.append(rippleGL.canvas);
        }
        const setNegative = on => {
            if (on === negative) return;
            negative = on;
            // Негатив всего кадра: и рисунка, и сцены под ним
            applyNegative([cv, rippleGL?.canvas], on);
        };

        const t0 = performance.now();
        const frame = now => {
          // Ошибка в кадре не должна оставить экран закрытым, а показ — незавершённым
          try {
            const t = (now - t0) / slow;
            if (t >= end) { cv.remove(); rippleGL?.canvas.remove(); if (rippleGL) rippleGL.canvas.style.filter = rippleGL.canvas.style.backdropFilter = ''; return resolve(); }
            // Удары: звук и тряска — один раз на кулак
            schedule.forEach((s, i) => {
                if (t >= s.hit && !struck.has(i)) {
                    struck.add(i);
                    onHit(i === 4, i, (flights[i].x / W * 2 - 1) * 0.85);
                    shake = { a: rnd() * Math.PI * 2, power: unit * (i === 4 ? SHAKE.final : SHAKE.hit), at: s.hit };
                }
            });
            const hitting = schedule.findIndex(s => t >= s.hit && t < s.hit + T.hold);
            const finale = t >= lastHit;
            setNegative(!calm && (hitting >= 0 || (finale && t < lastHit + (quick ? T.finalNegative : T.cracks))));

            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, W, H);
            const fade = t > lastHit + T.cracks + T.flash ? 1 - (t - lastHit - T.cracks - T.flash) / T.fade : 1;
            ctx.globalAlpha = Math.max(0, fade);
            // Фон: сцена темнеет и такой остаётся; негатив делает её светлой
            ctx.fillStyle = `rgba(0,0,0,${0.9 * Math.min(1, t / dark)})`;
            ctx.fillRect(0, 0, W, H);
            // Тряска: экран бросает туда-обратно, размах быстро гаснет
            const sk = (t - shake.at) / T.shake;
            if (sk >= 0 && sk < 1) {
                const j = shake.power * (1 - sk) ** 2 * Math.cos(sk * Math.PI * 7);
                ctx.translate(Math.cos(shake.a) * j, Math.sin(shake.a) * j);
            }

            const current = schedule.findLastIndex(q => t >= q.start);
            // Трещины прежних кулаков — из готового слоя, тусклее
            for (let i = 0; i < current; i++) if (t >= schedule[i].hit) bake(i);
            if (bakedSet.size) {
                ctx.save();
                ctx.globalAlpha *= 0.5;
                ctx.drawImage(baked, 0, 0);
                ctx.restore();
            }
            schedule.forEach((s, i) => {
                if (t < s.start) return;
                const fl = flights[i], k = clamp01((t - s.start) / (s.hit - s.start)), after = t - s.hit;
                const old = i < current;
                // Трещины и свет удара — под кулаком; у прежних кулаков тусклее
                if (after >= 0) {
                    ctx.save();
                    // Вспышка света из места удара
                    const flash = 1 - clamp01(after / 260);
                    if (flash > 0) {
                        const g = ctx.createRadialGradient(fl.x, fl.y, 0, fl.x, fl.y, fl.size * 1.1);
                        g.addColorStop(0, `rgba(255,220,210,${0.55 * flash})`);
                        g.addColorStop(1, 'rgba(255,220,210,0)');
                        ctx.fillStyle = g;
                        ctx.fillRect(fl.x - fl.size * 1.2, fl.y - fl.size * 1.2, fl.size * 2.4, fl.size * 2.4);
                    }
                    if (!bakedSet.has(i)) drawCracks(ctx, fl.cracks, clamp01(after / T.crack), COLOR.crack, COLOR.glow, unit * 0.006 * (1 + 2 * flash));
                    drawPuffs(ctx, fl.puffs, fl.x, fl.y, after / T.puff, COLOR.puff);
                    ctx.restore();
                }
                // Следы полёта: тот же кулак чуть раньше, полупрозрачный
                if (k < 1) {
                    for (const [lag, alpha] of [[0.16, 0.22], [0.3, 0.1]]) {
                        if (k - lag <= 0) continue;
                        const g = place(fl, k - lag);
                        ctx.save();
                        ctx.globalAlpha *= alpha;
                        drawSprite(ctx, sprites[i], g.x, g.y, g.size, g.rot, 1, 1, sprites[i].blob);
                        ctx.restore();
                    }
                }
                const p = place(fl, k);
                // Попадание: кулак сплющивается и пружинит (шире и ниже, потом наоборот), потом медленно наезжает
                const w = after >= 0 ? wobble(after / T.pop, 4, 2) : 0, creep = after >= 0 ? 1 + 0.04 * clamp01(after / 1200) : 1;
                // Пока летит, кулак сначала — размытое белое пятно, и только на подлёте проступает рисунок
                const formed = smooth(clamp01((k - 0.45) / 0.45));
                if (formed < 1) {
                    ctx.save();
                    ctx.globalAlpha *= 1 - formed * 0.6;
                    drawSprite(ctx, sprites[i], p.x, p.y, p.size * (1.06 - 0.06 * formed), p.rot, 1, 1, sprites[i].blob);
                    ctx.restore();
                }
                if (formed > 0) {
                    ctx.save();
                    ctx.globalAlpha *= formed;
                    drawSprite(ctx, sprites[i], p.x, p.y, p.size * creep, p.rot, 1 + 0.2 * w, 1 - 0.16 * w);
                    ctx.restore();
                }
            });

            // После пятого удара — вспышка и сквозь неё сцена
            if (finale && !quick && !calm && t >= lastHit + T.cracks) {
                const p = (t - lastHit - T.cracks) / T.flash;
                drawFlash(ctx, W, H, Math.min(1, p * 1.6), rays);
            }
            // На экран: после пятого удара — волнами, как от камня в воде; иначе целиком
            out.setTransform(1, 0, 0, 1, 0, 0);
            out.clearRect(0, 0, W, H);
            const rippleAge = (t - lastHit) / T.ripple;
            const rippling = finale && rippleAge < 1 && rippleGL;
            if (rippling) rippleGL.draw(buffer, flights[4].x, flights[4].y, rippleAge, unit);
            else out.drawImage(buffer, 0, 0);
            if (rippleGL) {
                rippleGL.canvas.style.display = rippling ? '' : 'none';
                cv.style.visibility = rippling ? 'hidden' : '';
            }
            requestAnimationFrame(frame);
          } catch (error) {
            cv.remove();
            rippleGL?.canvas.remove();
            console.error('gachadnd | кулаки', error);
            resolve();
          }
        };
        requestAnimationFrame(frame);
    });
}
