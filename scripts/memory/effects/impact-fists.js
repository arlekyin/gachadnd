/**
 * Gacha Roguelike dnd5e — Импакт-кадр «Кулаки» (Сайтама)
 *
 * После применения урона экран темнеет, и в экран один за другим летят пять кулаков. Каждый
 * удар — звук и инверсия кадра: белые кулаки на чёрном становятся чёрными на светлом. Пятый
 * кулак — по центру и крупнее всех: от него разбегаются трещины, кадр заливает белая вспышка,
 * и сквозь неё возвращается сцена. Всё рисуется векторами в разрешении экрана поверх живой сцены.
 * «Без вспышек» убирает инверсии и белую вспышку: остаются кулаки, звук и толчки.
 */

// Хронометраж, мс: затемнение, полёт кулака к экрану, удержание удара; после пятого —
// трещины, вспышка и возвращение сцены
const T = { dark: 220, fly: 140, hold: 80, firstFly: 190, cracks: 170, flash: 200, fade: 380 };
// Куда прилетают кулаки: доли экрана, размер — доля меньшей стороны экрана, поворот
const FISTS = [
    { x: 0.3, y: 0.36, size: 0.55, rot: -0.22 },
    { x: 0.72, y: 0.62, size: 0.6, rot: 0.26 },
    { x: 0.69, y: 0.3, size: 0.5, rot: 0.1 },
    { x: 0.27, y: 0.7, size: 0.56, rot: -0.32 },
    { x: 0.5, y: 0.52, size: 1.05, rot: 0 }
];

function seeded(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const easeIn = t => t * t * t;

// ==========================================
// КУЛАК
// ==========================================

/**
 * Кулак анфас, костяшками в экран: сверху четыре бугра пальцев, поперёк низа — большой палец.
 * Координаты — в долях ширины кулака, центр в (0, 0). У каждого кулака свои мелкие неровности.
 */
function fistShape(seed) {
    const rnd = seeded(seed);
    const peaks = [-0.34, -0.42, -0.41, -0.33].map(y => y + (rnd() - 0.5) * 0.03);
    return { peaks, valley: -0.24 + (rnd() - 0.5) * 0.02 };
}

function fistPath(ctx, shape) {
    const { peaks, valley } = shape;
    ctx.beginPath();
    ctx.moveTo(-0.5, -0.12);
    // Бугры пальцев: от впадины к впадине через вершину
    for (let i = 0; i < 4; i++) {
        const x0 = -0.5 + i * 0.25, x1 = x0 + 0.25, y0 = i ? valley : -0.12, y1 = i === 3 ? -0.1 : valley;
        ctx.bezierCurveTo(x0, peaks[i] - 0.02, x1, peaks[i] - 0.02, x1, y1);
    }
    // Правый край, низ кулака и большой палец слева
    ctx.bezierCurveTo(0.53, 0.05, 0.52, 0.3, 0.36, 0.4);
    ctx.bezierCurveTo(0.12, 0.47, -0.3, 0.46, -0.44, 0.36);
    ctx.bezierCurveTo(-0.58, 0.24, -0.56, 0.02, -0.5, -0.12);
    ctx.closePath();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} shape   Форма из fistShape.
 * @param {number} x, y    Центр, пиксели.
 * @param {number} size    Ширина кулака, пиксели.
 * @param {string} fill, ink  Цвет кулака и линий.
 */
function drawFist(ctx, shape, x, y, size, rot, fill, ink) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(size, size);
    const px = 1 / size;
    // Кайма цвета линий отделяет кулак от фона и от соседних кулаков
    fistPath(ctx, shape);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.045;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
    // Линии пером: толще в середине, тоньше к концам
    ctx.fillStyle = ink;
    const stroke = (x0, y0, cx, cy, x1, y1, w) => {
        const len = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / len * w, ny = (x1 - x0) / len * w;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(cx + nx, cy + ny, x1, y1);
        ctx.quadraticCurveTo(cx - nx, cy - ny, x0, y0);
        ctx.fill();
    };
    const w = Math.max(0.011, 2.5 * px);
    // Между пальцами — от впадины вниз, к большому пальцу
    for (const [i, mx] of [[0, -0.25], [1, 0], [2, 0.25]].map(([i, m]) => [i, m])) {
        stroke(mx, shape.valley + 0.03, mx + 0.01, 0.0, mx + 0.02 - i * 0.01, 0.12 + i * 0.02, w);
    }
    // Большой палец: сгиб поперёк низа и его кончик под средними пальцами
    stroke(-0.5, 0.06, -0.15, 0.1, 0.2, 0.17, w * 1.1);
    stroke(0.2, 0.17, 0.25, 0.22, 0.22, 0.3, w * 0.8);
    // Складка у основания большого пальца
    stroke(-0.42, 0.28, -0.3, 0.32, -0.16, 0.3, w * 0.7);
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

function drawCracks(ctx, segments, progress, color) {
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    for (const s of segments) {
        if (s.at > progress) continue;
        ctx.lineWidth = s.width;
        ctx.beginPath();
        ctx.moveTo(s.x0, s.y0);
        ctx.lineTo(s.x1, s.y1);
        ctx.stroke();
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
 * @param {(final: boolean) => void} options.onHit  Звук удара; final — пятый кулак.
 * @returns {Promise<void>}  Когда сцена вернулась.
 */
export function playFists({ calm = false, slow = 1, onHit = () => {} } = {}) {
    return new Promise(resolve => {
        const cv = document.createElement('canvas');
        cv.className = 'gd-impact';
        cv.width = Math.round(innerWidth * devicePixelRatio);
        cv.height = Math.round(innerHeight * devicePixelRatio);
        document.body.append(cv);
        const ctx = cv.getContext('2d');
        const W = cv.width, H = cv.height, unit = Math.min(W, H);
        const shapes = FISTS.map((_, i) => fistShape(31 + i * 17));
        const crackSet = cracks(W / 2, H * FISTS[4].y, unit * 0.75, 77);
        const rnd = seeded(101);
        const rays = Array.from({ length: 90 }, () => ({ a: rnd() * Math.PI * 2, w: 0.002 + rnd() ** 2 * 0.012 }));

        // Расписание: начало полёта и момент удара каждого кулака
        const schedule = [];
        let clock = T.dark;
        FISTS.forEach((_, i) => {
            const fly = i === 0 ? T.firstFly : T.fly;
            schedule.push({ start: clock, hit: clock + fly });
            clock += fly + T.hold;
        });
        const lastHit = schedule[4].hit;
        const end = lastHit + T.cracks + T.flash + T.fade;
        const struck = new Set();
        let shake = { x: 0, y: 0, until: 0 };

        const t0 = performance.now();
        const frame = now => {
            const t = (now - t0) / slow;
            if (t >= end) { cv.remove(); return resolve(); }
            // Удары: звук и толчок — один раз на кулак
            schedule.forEach((s, i) => {
                if (t >= s.hit && !struck.has(i)) {
                    struck.add(i);
                    onHit(i === 4);
                    const power = (i === 4 ? 30 : 16) * unit / 1000;
                    shake = { x: (rnd() - 0.5) * power, y: (rnd() - 0.5) * power, until: s.hit + T.hold * 0.8 };
                }
            });
            const hitting = schedule.findIndex(s => t >= s.hit && t < s.hit + T.hold);
            const finale = t >= lastHit;
            // Инверсия на удар: кулаки чёрные на светлом; «без вспышек» — без неё
            const inverted = !calm && (hitting >= 0 || (finale && t < lastHit + T.cracks));
            const fill = inverted ? '#0a0a0a' : '#f4f1ee', ink = inverted ? '#f4f1ee' : '#0a0a0a';

            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, W, H);
            const fade = t > lastHit + T.cracks + T.flash ? 1 - (t - lastHit - T.cracks - T.flash) / T.fade : 1;
            ctx.globalAlpha = Math.max(0, fade);
            // Фон: сцена темнеет; на ударе — светлый кадр
            ctx.fillStyle = inverted ? '#e9e6e2' : `rgba(0,0,0,${0.9 * Math.min(1, t / T.dark)})`;
            ctx.fillRect(0, 0, W, H);
            if (t < shake.until) ctx.translate(shake.x, shake.y);

            // Кулаки: прилетевшие остаются, текущий летит к экрану — растёт с ускорением
            schedule.forEach((s, i) => {
                if (t < s.start) return;
                const f = FISTS[i], k = Math.min(1, (t - s.start) / (s.hit - s.start)), e = easeIn(k);
                const x = W * (0.5 + (f.x - 0.5) * e), y = H * (0.5 + (f.y - 0.5) * e);
                const size = unit * f.size * (0.06 + 0.94 * e) * (i === 4 && finale ? 1 + Math.min(1, (t - lastHit) / 300) * 0.08 : 1);
                // Прилетевшие раньше в обычном кадре — серые: внимание на последнем
                const old = i < schedule.findLastIndex(q => t >= q.start);
                const body = old && !inverted ? '#9a9692' : fill;
                drawFist(ctx, shapes[i], x, y, size, f.rot * e, body, ink);
            });

            // Пятый удар: трещины разбегаются, затем вспышка и сквозь неё — сцена
            if (finale) {
                const k = Math.min(1, (t - lastHit) / T.cracks);
                drawCracks(ctx, crackSet, k, inverted ? '#0a0a0a' : '#f4f1ee');
                if (!calm && t >= lastHit + T.cracks) {
                    const p = (t - lastHit - T.cracks) / T.flash;
                    drawFlash(ctx, W, H, Math.min(1, p * 1.6), rays);
                }
            }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    });
}
