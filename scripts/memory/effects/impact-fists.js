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
const T = { dark: 220, fly: 170, hold: 90, firstFly: 230, cracks: 170, flash: 200, fade: 380, crack: 140, shake: 300, puff: 600, pop: 280 };
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
// Затухающее колебание около нуля: x — время в долях, 0 → 1
const wobble = x => x >= 1 || x < 0 ? 0 : Math.exp(-4 * x) * Math.cos(x * Math.PI * 4);

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
        const rnd = seeded(101);
        const rays = Array.from({ length: 90 }, () => ({ a: rnd() * Math.PI * 2, w: 0.002 + rnd() ** 2 * 0.012 }));
        // Полёт каждого кулака: откуда (рядом с центром), изгиб дуги, начальный поворот;
        // трещины и пыль удара — вокруг места попадания
        const spots = layout(W, H);
        const flights = FISTS.map((f, i) => {
            const { size, x, y } = spots[i];
            const from = { x: W * (0.5 + (rnd() - 0.5) * 0.12), y: H * (0.5 + (rnd() - 0.5) * 0.12) };
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
        let clock = T.dark;
        FISTS.forEach((_, i) => {
            const fly = i === 0 ? T.firstFly : T.fly;
            schedule.push({ start: clock, hit: clock + fly });
            clock += fly + T.hold;
        });
        const lastHit = schedule[4].hit;
        const end = lastHit + T.cracks + T.flash + T.fade;
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
                    onHit(i === 4);
                    shake = { a: rnd() * Math.PI * 2, power: unit * (i === 4 ? SHAKE.final : SHAKE.hit), at: s.hit };
                }
            });
            const hitting = schedule.findIndex(s => t >= s.hit && t < s.hit + T.hold);
            const finale = t >= lastHit;
            setNegative(!calm && (hitting >= 0 || (finale && t < lastHit + T.cracks)));

            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, W, H);
            const fade = t > lastHit + T.cracks + T.flash ? 1 - (t - lastHit - T.cracks - T.flash) / T.fade : 1;
            ctx.globalAlpha = Math.max(0, fade);
            // Фон: сцена темнеет и такой остаётся; негатив делает её светлой
            ctx.fillStyle = `rgba(0,0,0,${0.9 * Math.min(1, t / T.dark)})`;
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
                        drawFist(ctx, shapes[i], g.x, g.y, g.size, g.rot, COLOR.fist, COLOR.ink);
                        ctx.restore();
                    }
                }
                const p = place(fl, k);
                // Попадание: кулак пружинит, потом медленно наезжает дальше — кадр не замирает
                const pop = after >= 0 ? 1 + 0.12 * wobble(after / T.pop) + 0.04 * clamp01(after / 1200) : 1;
                drawFist(ctx, shapes[i], p.x, p.y, p.size * pop, p.rot, old ? COLOR.old : COLOR.fist, COLOR.ink);
            });

            // После пятого удара — вспышка и сквозь неё сцена
            if (finale && !calm && t >= lastHit + T.cracks) {
                const p = (t - lastHit - T.cracks) / T.flash;
                drawFlash(ctx, W, H, Math.min(1, p * 1.6), rays);
            }
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
