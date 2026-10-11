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
const COLOR = { fist: '#f7ece8', old: '#a99f9b', ink: '#1c1212', crack: '#ffe4dc', glow: 'rgba(255,140,130,0.35)', puff: '255,236,230' };
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

function seeded(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const easeIn = t => t * t * t;
const easeOut = t => 1 - (1 - t) ** 3;
const clamp01 = t => Math.min(1, Math.max(0, t));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
// Затухающее колебание около нуля: x — время в долях, 0 → 1
const wobble = x => x >= 1 || x < 0 ? 0 : Math.exp(-4 * x) * Math.cos(x * Math.PI * 4);

// ==========================================
// КУЛАК
// ==========================================

/**
 * Кулак анфас, костяшками в экран: почти квадратный, сверху — мягкие бугры пальцев, внизу —
 * подвёрнутый большой палец. Координаты — в долях ширины кулака, центр в (0, 0).
 * У каждого кулака свои мелкие неровности.
 */
function fistShape(seed) {
    const rnd = seeded(seed);
    const peaks = [-0.4, -0.46, -0.45, -0.39].map(y => y + (rnd() - 0.5) * 0.02);
    return { peaks, valley: -0.33 + (rnd() - 0.5) * 0.015, tilt: (rnd() - 0.5) * 0.04 };
}

function fistPath(ctx, shape) {
    const { peaks, valley, tilt } = shape;
    ctx.beginPath();
    ctx.moveTo(-0.5, -0.24);
    // Бугры пальцев — невысокие: кулак сжат, пальцы прижаты
    for (let i = 0; i < 4; i++) {
        const x0 = -0.5 + i * 0.25, x1 = x0 + 0.25, y1 = i === 3 ? -0.24 + tilt : valley;
        ctx.bezierCurveTo(x0 + 0.02, peaks[i], x1 - 0.02, peaks[i], x1, y1);
    }
    // Правый край почти прямой, низ — подвёрнутый большой палец, левый край чуть скруглён
    ctx.bezierCurveTo(0.54, 0.0, 0.52, 0.28, 0.4, 0.38);
    ctx.bezierCurveTo(0.2, 0.46, -0.25, 0.47, -0.42, 0.38);
    ctx.bezierCurveTo(-0.56, 0.28, -0.54, -0.02, -0.5, -0.24);
    ctx.closePath();
}

// Шум значений: плавные пятна — штриховка ложится клочьями, как печать на шершавой бумаге
function valueNoise(seed, cells = 9) {
    const rnd = seeded(seed), grid = Array.from({ length: (cells + 1) ** 2 }, () => rnd());
    return (u, v) => {
        const x = (u + 0.75) / 1.5 * cells, y = (v + 0.75) / 1.5 * cells;
        const ix = Math.max(0, Math.min(cells - 1, Math.floor(x))), iy = Math.max(0, Math.min(cells - 1, Math.floor(y)));
        const fx = x - ix, fy = y - iy, at = (a, b) => grid[(iy + b) * (cells + 1) + ix + a];
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        return (at(0, 0) * (1 - sx) + at(1, 0) * sx) * (1 - sy) + (at(0, 1) * (1 - sx) + at(1, 1) * sx) * sy;
    };
}

/**
 * Рисунок кулака — один раз, заранее, как кадр аниме-импакта:
 *  - белое тело с неровным мягким краем, как мазок мела, и лёгкий объём (светлее сверху справа);
 *  - зернистая штриховка печати в тени — слева, снизу и у края, клочьями;
 *  - линии пальцев сухим углём: три штриха сверху вниз, сходящиеся в линию у основания пальцев.
 * Второй рисунок — размытое белое пятно той же формы: так кулак выглядит издалека, пока летит.
 * В кадре рисунки только масштабируются и поворачиваются — подробно, но дёшево.
 * @param {object} shape  Форма из fistShape.
 * @param {number} size   Ширина кулака в рисунке, пиксели.
 * @returns {{canvas: HTMLCanvasElement, blob: HTMLCanvasElement, size: number}}
 */
function fistSprite(shape, size, seed) {
    const S = Math.ceil(size * 1.5);
    const make = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
    const c = make(), x = c.getContext('2d');
    const rnd = seeded(seed);
    const toPx = (u, v) => [S / 2 + u * size, S / 2 + v * size];
    x.setTransform(size, 0, 0, size, S / 2, S / 2);
    const px = 1 / size;

    // Контур — отдельным путём: штрихи и точки рисуются своими путями
    const body = new Path2D();
    fistPath({ beginPath() {}, moveTo: (...a) => body.moveTo(...a), bezierCurveTo: (...a) => body.bezierCurveTo(...a), closePath: () => body.closePath() }, shape);
    // Точки края лучами из центра — для неровного края и расстояния до края
    const edge = [];
    for (let i = 0; i < 240; i++) {
        const a = i / 240 * Math.PI * 2;
        let r = 0.05;
        while (r < 0.8 && x.isPointInPath(body, ...toPx(Math.cos(a) * r, Math.sin(a) * r + 0.02))) r += 0.003;
        edge.push({ u: Math.cos(a) * r, v: Math.sin(a) * r + 0.02, a });
    }
    // Неровный край мелом: контур по точкам края с плавной случайной волной
    const wave = valueNoise(seed + 5, 24);
    const ragged = new Path2D();
    edge.forEach((p, i) => {
        const j = (wave(Math.cos(p.a) * 0.7, Math.sin(p.a) * 0.7) - 0.5) * 0.045 + (rnd() - 0.5) * 0.008;
        const u = p.u + Math.cos(p.a) * j, v = p.v + Math.sin(p.a) * j;
        i ? ragged.lineTo(u, v) : ragged.moveTo(u, v);
    });
    ragged.closePath();

    // Тело: мягкий светящийся ореол и белая заливка
    x.save();
    x.filter = `blur(${Math.max(1, size * 0.012)}px)`;
    x.fillStyle = 'rgba(255,250,248,0.9)';
    x.fill(ragged);
    x.restore();
    x.fillStyle = '#fbf7f4';
    x.fill(ragged);
    // Объём: к низу и влево чуть серее
    x.save();
    x.clip(ragged);
    const shade = x.createLinearGradient(0.35, -0.4, -0.45, 0.45);
    shade.addColorStop(0, 'rgba(255,255,255,0)');
    shade.addColorStop(0.55, 'rgba(200,190,186,0.12)');
    shade.addColorStop(1, 'rgba(150,140,136,0.35)');
    x.fillStyle = shade;
    x.fillRect(-0.8, -0.8, 1.6, 1.6);

    // Штриховка печати: мелкие тёмные точки и чёрточки, гуще в тени и у края, клочьями
    const patch = valueNoise(seed + 11, 10);
    const coarse = edge.filter((_, i) => i % 6 === 0);
    for (let i = 0; i < 45000; i++) {
        const u = (rnd() - 0.5) * 1.15, v = (rnd() - 0.5) * 1.0;
        // Тень — слева и снизу; у края гуще только на теневой стороне: светлый край остаётся белым
        const side = Math.max(0, -u * 0.9 + v * 0.8 + 0.05);
        if (side < 0.05 && rnd() > 0.1) continue;
        let near = 1;
        for (const p of coarse) near = Math.min(near, Math.hypot(p.u - u, p.v - v));
        const tone = (Math.max(0, 1 - near / 0.12) * 0.5 * Math.min(1, side * 2) + side * 0.7) * (0.3 + patch(u, v) * 1.2);
        if (rnd() > tone * 0.5) continue;
        const d = px * (0.7 + rnd() * 1.1);
        x.fillStyle = `rgba(50,40,40,${0.35 + rnd() * 0.35})`;
        // Чёрточки печати — горизонтальные, как в отсканированной манге
        if (rnd() < 0.3) x.fillRect(u, v, d * (2 + rnd() * 3), d * 0.8);
        else x.fillRect(u, v, d, d);
    }
    x.restore();

    // Линии пальцев сухим углём: несколько дрожащих проходов, часть с разрывами
    x.lineCap = 'round';
    x.lineJoin = 'round';
    const charcoal = (points, width) => {
        for (let pass = 0; pass < 5; pass++) {
            const j = () => (rnd() - 0.5) * 0.009;
            x.strokeStyle = `rgba(30,20,20,${0.45 + rnd() * 0.3})`;
            x.lineWidth = width * (0.35 + rnd() * 0.65);
            x.setLineDash(pass > 2 ? [0.02 + rnd() * 0.05, 0.004 + rnd() * 0.012] : []);
            x.beginPath();
            x.moveTo(points[0][0] + j(), points[0][1] + j());
            for (let i = 1; i < points.length; i++) x.lineTo(points[i][0] + j(), points[i][1] + j());
            x.stroke();
        }
        x.setLineDash([]);
    };
    const w = 0.022;
    // Три штриха между пальцами, чуть веером: сверху крючок, внизу короткий загиб вдоль основания
    // пальца — штрихи не сливаются в одну линию
    for (const [mx, lean, top, bottom, foot] of [[-0.23, -0.05, -0.24, 0.2, 0.09], [0.02, 0, -0.29, 0.18, 0.1], [0.26, 0.06, -0.26, 0.15, 0.07]]) {
        charcoal([[mx - 0.025, top + 0.02], [mx, top], [mx + lean * 0.4, top + (bottom - top) * 0.45], [mx + lean, bottom], [mx + lean + foot, bottom + 0.012]], w);
    }
    // Сгиб большого пальца — короткий штрих снизу слева
    charcoal([[-0.44, 0.0], [-0.43, 0.16], [-0.36, 0.25]], w * 0.75);

    // Размытое пятно той же формы — кулак издалека
    const blob = make(), bx = blob.getContext('2d');
    bx.setTransform(size, 0, 0, size, S / 2, S / 2);
    bx.filter = `blur(${Math.max(2, size * 0.05)}px)`;
    bx.fillStyle = '#fbf7f4';
    bx.fill(ragged);
    bx.fill(ragged);
    return { canvas: c, blob, size };
}

// Рисунки кулаков между показами: размер экрана обычно не меняется
const spriteCache = new Map();

// Рисунки всех пяти кулаков для экрана W×H — из запаса или заново
function fistSprites(W, H) {
    return layout(W, H).map((spot, i) => {
        const size = Math.ceil(spot.size * 1.2), key = `${i}:${size}`;
        if (!spriteCache.has(key)) spriteCache.set(key, fistSprite(fistShape(31 + i * 17), size, 31 + i * 17));
        return spriteCache.get(key);
    });
}

/** Нарисовать кулаки заранее (≈0,3 с), чтобы показ начался без задержки: зовётся при взводе навыка */
export function prepareFists() {
    fistSprites(Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio));
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
// ВОЛНЫ
// ==========================================

/**
 * Волны на воде: кадр выводится кольцами вокруг точки удара, каждое кольцо — со своим
 * масштабом. Масштаб колеблется вдоль радиуса бегущей волной: изображение то растягивается,
 * то сжимается, и по кадру расходятся круги. За фронтом волны и к концу — спокойно.
 * @param {number} age  Доля времени волн, 0 → 1.
 */
function ripple(out, image, cx, cy, age, unit) {
    const W = image.width, H = image.height;
    const reach = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
    const front = reach * (0.15 + 0.95 * easeOut(age));
    const wavelength = unit * 0.11, rings = 36, calmDown = (1 - age) ** 1.5;
    out.drawImage(image, 0, 0);
    for (let i = rings - 1; i >= 0; i--) {
        const r0 = front * i / rings, r1 = front * (i + 1) / rings, r = (r0 + r1) / 2;
        // Сильнее у фронта, к центру гаснет; к концу показа — всё спокойнее
        const strength = 0.05 * calmDown * (0.25 + 0.75 * (r / front));
        const s = 1 + strength * Math.sin((r - front) / wavelength * Math.PI * 2);
        out.save();
        out.beginPath();
        out.arc(cx, cy, r1, 0, Math.PI * 2);
        out.arc(cx, cy, r0, 0, Math.PI * 2, true);
        out.clip();
        out.drawImage(image, cx - cx * s, cy - cy * s, W * s, H * s);
        out.restore();
    }
    // Гребни волн — тонкие светлые круги
    out.lineWidth = unit * 0.003;
    for (let k = 0; k < 4; k++) {
        const r = front - k * wavelength * 1.3;
        if (r <= 0) continue;
        out.strokeStyle = `rgba(255,255,255,${0.35 * calmDown * (1 - k / 4)})`;
        out.beginPath();
        out.arc(cx, cy, r, 0, Math.PI * 2);
        out.stroke();
    }
}

// ==========================================
// ПОКАЗ
// ==========================================

/**
 * @param {object} options
 * @param {boolean} options.calm  Без инверсий и белой вспышки.
 * @param {number} options.slow   Замедление.
 * @param {(final: boolean, index: number) => void} options.onHit  Звук удара; final — пятый кулак.
 * @returns {Promise<void>}  Когда сцена вернулась.
 */
// quick — кулаки сразу после кадров света и молний: экран уже тёмный, затемнение мгновенное
export function playFists({ calm = false, slow = 1, onHit = () => {}, quick = false } = {}) {
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
        const sprites = fistSprites(W, H);
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
        const setNegative = on => {
            if (on === negative) return;
            negative = on;
            // Негатив всего кадра: и рисунка, и сцены под ним
            cv.style.filter = on ? 'invert(1)' : '';
            cv.style.backdropFilter = on ? 'invert(1)' : '';
        };

        const t0 = performance.now();
        const frame = now => {
          // Ошибка в кадре не должна оставить экран закрытым, а показ — незавершённым
          try {
            const t = (now - t0) / slow;
            if (t >= end) { cv.remove(); return resolve(); }
            // Удары: звук и тряска — один раз на кулак
            schedule.forEach((s, i) => {
                if (t >= s.hit && !struck.has(i)) {
                    struck.add(i);
                    onHit(i === 4, i);
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
                const w = after >= 0 ? wobble(after / T.pop) : 0, creep = after >= 0 ? 1 + 0.04 * clamp01(after / 1200) : 1;
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
            if (finale && rippleAge < 1) ripple(out, buffer, flights[4].x, flights[4].y, rippleAge, unit);
            else out.drawImage(buffer, 0, 0);
            requestAnimationFrame(frame);
          } catch (error) {
            cv.remove();
            console.error('gachadnd | кулаки', error);
            resolve();
          }
        };
        requestAnimationFrame(frame);
    });
}
