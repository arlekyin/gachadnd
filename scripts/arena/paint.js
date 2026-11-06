/**
 * Генератор арен — отрисовка планировки в картинку (2D canvas, в браузере)
 *
 * Земля — бесшовные текстуры, смешанные по маскам с рваными краями; вода — поверх дна; предметы — спрайты с
 * мягкой падающей тенью (свет сверху слева); затем свет — одно солнечное место, лес по краям темнее, тени
 * холодные, свет тёплый; в конце — настроение (ночь, туман, порча, кровь).
 * Пока арта нет, текстуры и спрайты рисуются здесь же в рисованном стиле: крупные пятна, мазок, тонкий тёмный
 * контур; положите картинки в assets/battlemap/<биом>/ (имена — docs/battlemap-assets.md) — подставятся они.
 *
 * paint(plan, { cell, mood, art }) → HTMLCanvasElement
 */

import { rng, distToPath, VIGNETTES } from "./layout.js";

// ---------- Шум: бесшовный (на торе) и обычный

function makeNoise(seed, period = 0) {
    const R = rng(`noise|${seed}`), N = 256, perm = Array.from({ length: N }, (_, i) => i).sort(() => R() - 0.5), vals = Array.from({ length: N }, () => R());
    const h = (x, y) => vals[perm[(perm[((x % N) + N) % N] + y) & 255]];
    const v = (x, y, p) => {
        const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
        const w = k => (p ? ((k % p) + p) % p : k);
        const a = h(w(ix), w(iy)), b = h(w(ix + 1), w(iy)), c = h(w(ix), w(iy + 1)), d = h(w(ix + 1), w(iy + 1));
        return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
    };
    return (x, y, oct = 4) => { let s = 0, amp = 0.5, f = 1, norm = 0; for (let i = 0; i < oct; i++) { s += amp * v(x * f, y * f, period ? period * f : 0); norm += amp; amp *= 0.5; f *= 2; } return s / norm; };
}

const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
const rgb = c => `rgb(${c.map(v => Math.round(Math.max(0, Math.min(255, v)))).join(',')})`;
const rgba = (c, a) => `rgba(${c.map(v => Math.round(v)).join(',')},${a})`;

// ---------- Текстуры земли: 3–4 тона ступенями (мазок), бесшовно

const GROUND = {
    grass: ['#7f9a4a', '#6e8a3e', '#94ab58', '#5f7a37'],
    forest: ['#566b33', '#4a5e2c', '#647a3b', '#3f5126'],
    moss: ['#6f9440', '#5e8236', '#82a64c', '#4f6f2e'],
    path: ['#a5845a', '#93744d', '#b6956a', '#7f6342'],
    mud: ['#6d5a3e', '#5e4d34', '#7c6848', '#4e3f2b'],
    rock: ['#8a877b', '#797669', '#9c998c', '#66645a'],
    bank: ['#7d6c4a', '#6d5d3f', '#8d7b56', '#5b4c34'],
    riverbed: ['#5d6a4c', '#4f5c41', '#6b7a57', '#43503a']
};

function groundTexture(type, seed, S = 512) {
    const c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d'), img = ctx.createImageData(S, S), tones = GROUND[type].map(hex);
    const n = makeNoise(`${type}|${seed}`, 8), d = makeNoise(`${type}|d|${seed}`, 32);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const big = n((x / S) * 8, (y / S) * 8, 4), fine = d((x / S) * 32, (y / S) * 32, 2);
        // Спокойная поверхность: два соседних тона плавно, мелкий шум — едва
        const v = big * 0.85 + fine * 0.15, k = Math.max(0, Math.min(1, (v - 0.35) / 0.3));
        const base = mix(mix(tones[3], tones[0], k), tones[2], Math.max(0, (v - 0.62) * 1.6) * 0.5);
        const o = (y * S + x) * 4;
        img.data[o] = base[0]; img.data[o + 1] = base[1]; img.data[o + 2] = base[2]; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Короткие мазки поверх — травинки и комочки, бесшовно (с повтором у краёв)
    const R = rng(`strokes|${type}|${seed}`);
    ctx.lineCap = 'round';
    for (let i = 0; i < (type === 'grass' || type === 'moss' || type === 'forest' ? 140 : 70); i++) {
        const x = R() * S, y = R() * S, len = R.range(6, 16), a = R.range(-1.2, -0.4), col = tones[R.int(0, 3)];
        ctx.strokeStyle = rgba(mix(col, [255, 255, 230], 0.1), 0.28); ctx.lineWidth = R.range(1.2, 2.2);
        for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) { ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len); ctx.stroke(); }
    }
    return c;
}

// ---------- Маски рельефа: поле значений с рваным шумом краёв

function masks(plan, cell, seed) {
    const { cols, rows, terrain } = plan;
    const n = makeNoise(`mask|${seed}`), out = {};
    // Выборка маски: 4 точки на клетку; у воды — 20 (граница тонов чёткая, рваная)
    const make = (fn, step = 4) => {
        const W = cols * step, H = rows * step;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d'), img = ctx.createImageData(W, H);
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
            const x = (i + 0.5) / step, y = (j + 0.5) / step, wob = (n(x * 0.45, y * 0.45, 3) - 0.5);
            const a = Math.max(0, Math.min(1, fn(x, y, wob)));
            const o = (j * W + i) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 255; img.data[o + 3] = a * 255;
        }
        ctx.putImageData(img, 0, 0);
        return c;
    };
    const edge = (d, w, soft = 0.35) => 1 - Math.max(0, Math.min(1, (d - w) / soft + 0.5));
    const patch = type => (x, y, wob) => Math.max(0, ...terrain.patches.filter(p => p.type === type).map(p => edge(Math.hypot(x - p.x, y - p.y) + wob * p.r * 0.9, p.r, 0.8)));
    out.forest = make(patch('forest'));
    out.moss = make(patch('moss'));
    out.rock = make(patch('rock'));
    out.dirt = make(patch('dirt'));
    out.litter = make(patch('litter'));
    out.path = make((x, y, wob) => edge(distToPath(terrain.path, x, y) + wob * 0.9, 0.85, 0.25));
    // Вода: ручей и озерца — одно поле «расстояние до кромки» (отрицательное — в воде)
    const pools = terrain.pools ?? [];
    if (terrain.stream || pools.length) {
        const s = terrain.stream;
        const wd = (x, y) => Math.min(s ? distToPath(s.path, x, y) - s.width / 2 : 99, ...pools.map(p => Math.hypot(p.x - x, p.y - y) - p.r), 99);
        const deepest = s ? s.width / 2 : 1.5;
        out.bank = make((x, y, wob) => edge(wd(x, y) + wob * 1.4, 0.9, 0.45));
        const shore = (x, y, wob) => wd(x, y) + wob * (pools.length ? 1.6 : 0.7);
        // У брода мелко: глубина «поднимается» к броду
        const ford = (x, y) => terrain.ford ? Math.max(0, 1.6 - Math.hypot(x - terrain.ford.x, y - terrain.ford.y)) : 0;
        // Мелкая рябь границы тонов — край рваный, а не ровная полоса вдоль берега
        const ripple = (x, y) => n(x * 1.7 + 31, y * 1.7 + 17, 2) - 0.5;
        out.riverbed = make((x, y, wob) => edge(shore(x, y, wob), 0, 0.22), 20);
        // Основной тон — всё, кроме узкой светлой полосы у берега
        out.waterMid = make((x, y, wob) => edge(shore(x, y, wob) + ripple(x, y) * 0.25 + ford(x, y) * 0.15, -0.3, 0.1), 20);
        // Глубь — не полоса вдоль берега, а мягкие пятна неправильной формы подальше от кромки (у брода их нет)
        out.waterDeep = make((x, y, wob) => {
            const inside = edge(shore(x, y, wob) + ford(x, y) * 1.5, -0.45, 0.35);
            const blot = Math.max(0, Math.min(1, (n(x * 0.9 + 7, y * 0.9 + 3, 2) - 0.48) * 6));
            return inside * blot;
        }, 8);
    }
    return out;
}

/** Слой текстуры по маске: текстура заполняет холст, маска растягивается сглаживанием */
function layer(ctx, tex, mask, W, H, alpha = 1) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const l = c.getContext('2d');
    l.fillStyle = l.createPattern(tex, 'repeat'); l.fillRect(0, 0, W, H);
    l.globalCompositeOperation = 'destination-in'; l.imageSmoothingQuality = 'high'; l.drawImage(mask, 0, 0, W, H);
    ctx.globalAlpha = alpha; ctx.drawImage(c, 0, 0); ctx.globalAlpha = 1;
    return c;
}

// ---------- Спрайты-заглушки в рисованном стиле

const OUTLINE = 'rgba(62,44,26,0.82)';

function blobs(ctx, R, r, n, spread) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + R.range(-0.3, 0.3), d = r * spread * R.range(0.55, 1); pts.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: r * R.range(0.42, 0.58) }); }
    pts.push({ x: 0, y: 0, r: r * 0.6 });
    return pts;
}
function lumpy(ctx, pts, fill, outline = OUTLINE, ow = 1.8) {
    ctx.fillStyle = outline; for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, p.r + ow, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = fill; for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }
}

const SPRITES = {
    tree(ctx, r, R) {
        const base = hex(R.pick(['#3f6b2a', '#4a7530', '#3a6230'])), pts = blobs(ctx, R, r, 8, 0.62);
        lumpy(ctx, pts, rgb(base));
        // Средний и светлый ярусы листвы — сдвинуты к свету (сверху слева)
        for (const [k, t, s] of [[0.72, 0.18, -0.12], [0.45, 0.38, -0.22]]) {
            ctx.fillStyle = rgb(mix(base, [210, 220, 120], t));
            for (const p of pts.slice(0, Math.ceil(pts.length * k))) { ctx.beginPath(); ctx.arc(p.x * k + r * s, p.y * k + r * s, p.r * k * 0.9, 0, Math.PI * 2); ctx.fill(); }
        }
        // Мазки листвы
        ctx.strokeStyle = rgba(mix(base, [20, 30, 10], 0.4), 0.55); ctx.lineWidth = r * 0.04; ctx.lineCap = 'round';
        for (let i = 0; i < 26; i++) { const a = R.range(0, 6.28), d = R.range(0.1, 0.9) * r; ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.09, a, a + 2.2); ctx.stroke(); }
    },
    pine(ctx, r, R) {
        const base = hex(R.pick(['#2f5a3a', '#335f3c', '#2a4f36']));
        for (const [k, t] of [[1, 0], [0.72, 0.18], [0.45, 0.35]]) {
            const n = 11, pts = [];
            for (let i = 0; i < n * 2; i++) { const a = (i / (n * 2)) * Math.PI * 2 + k, d = (i % 2 ? 0.55 : 1) * r * k; pts.push([Math.cos(a) * d - (1 - k) * r * 0.15, Math.sin(a) * d - (1 - k) * r * 0.15]); }
            ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
            ctx.fillStyle = rgb(mix(base, [170, 200, 120], t)); ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
            if (k === 1) ctx.stroke();
            ctx.fill();
        }
    },
    deadtree(ctx, r, R) {
        ctx.lineCap = 'round';
        const branch = (x, y, a, len, w, depth) => {
            const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
            ctx.strokeStyle = OUTLINE; ctx.lineWidth = w + 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
            ctx.strokeStyle = '#6b5440'; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
            if (depth) for (const s of [-0.5, 0.45]) branch(x2, y2, a + s + R.range(-0.2, 0.2), len * 0.62, w * 0.6, depth - 1);
        };
        for (let i = 0; i < 5; i++) branch(0, 0, (i / 5) * 6.28 + R.range(-0.3, 0.3), r * 0.5, r * 0.12, 2);
        ctx.fillStyle = '#5a4535'; ctx.beginPath(); ctx.arc(0, 0, r * 0.16, 0, 6.28); ctx.fill();
    },
    bush(ctx, r, R) {
        const base = hex(R.pick(['#557d33', '#4d7430', '#5f8638'])), pts = blobs(ctx, R, r, 6, 0.5);
        lumpy(ctx, pts, rgb(base), OUTLINE, 2.5);
        ctx.fillStyle = rgb(mix(base, [210, 220, 120], 0.3));
        for (const p of pts.slice(0, 4)) { ctx.beginPath(); ctx.arc(p.x * 0.6 - r * 0.15, p.y * 0.6 - r * 0.15, p.r * 0.55, 0, 6.28); ctx.fill(); }
    },
    rock(ctx, r, R) {
        const n = R.int(7, 10), pts = Array.from({ length: n }, (_, i) => { const a = (i / n) * 6.28 + R.range(-0.2, 0.2), d = r * R.range(0.75, 1); return [Math.cos(a) * d, Math.sin(a) * d * 0.85]; });
        const path = () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
        path(); ctx.fillStyle = '#6f6c64'; ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.fill(); ctx.stroke();
        // Светлая грань сверху слева и мох на макушке
        ctx.save(); path(); ctx.clip();
        ctx.fillStyle = '#9b988c'; ctx.beginPath(); ctx.ellipse(-r * 0.2, -r * 0.25, r * 0.65, r * 0.45, -0.5, 0, 6.28); ctx.fill();
        ctx.fillStyle = 'rgba(110,140,60,0.85)'; ctx.beginPath(); ctx.ellipse(-r * 0.1, -r * 0.35, r * 0.45, r * 0.25, R.range(-0.5, 0.5), 0, 6.28); ctx.fill();
        ctx.strokeStyle = 'rgba(40,36,30,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(r * 0.1, -r * 0.1); ctx.lineTo(r * 0.45, r * 0.3); ctx.stroke();
        ctx.restore();
    },
    boulder(ctx, r, R) { SPRITES.rock(ctx, r, R); },
    stump(ctx, r) {
        ctx.fillStyle = OUTLINE; ctx.beginPath(); ctx.arc(0, 0, r + 3, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#7a5c3e'; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#c9a77a'; ctx.beginPath(); ctx.arc(-r * 0.08, -r * 0.08, r * 0.72, 0, 6.28); ctx.fill();
        ctx.strokeStyle = 'rgba(110,80,50,0.7)'; ctx.lineWidth = 1.5; for (const k of [0.25, 0.45, 0.6]) { ctx.beginPath(); ctx.arc(-r * 0.08, -r * 0.08, r * k, 0, 6.28); ctx.stroke(); }
    },
    log(ctx, r, R) {
        const L = r * 2, w = r * 0.42;
        ctx.fillStyle = OUTLINE; ctx.beginPath(); ctx.roundRect(-L / 2 - 3, -w / 2 - 3, L + 6, w + 6, w / 2); ctx.fill();
        ctx.fillStyle = '#6e5137'; ctx.beginPath(); ctx.roundRect(-L / 2, -w / 2, L, w, w / 2); ctx.fill();
        ctx.fillStyle = '#8a6a48'; ctx.beginPath(); ctx.roundRect(-L / 2, -w / 2, L, w * 0.45, w / 3); ctx.fill();
        ctx.strokeStyle = 'rgba(50,35,22,0.6)'; ctx.lineWidth = 2; for (let i = 0; i < 6; i++) { const x = R.range(-L / 2 + w, L / 2 - w); ctx.beginPath(); ctx.moveTo(x, -w * 0.35); ctx.lineTo(x + R.range(8, 20), -w * 0.35); ctx.stroke(); }
        ctx.fillStyle = '#c9a77a'; ctx.beginPath(); ctx.ellipse(L / 2 - w * 0.25, 0, w * 0.28, w * 0.45, 0, 0, 6.28); ctx.fill();
        ctx.fillStyle = 'rgba(110,140,60,0.8)'; ctx.beginPath(); ctx.ellipse(-L * 0.15, -w * 0.1, L * 0.18, w * 0.3, 0, 0, 6.28); ctx.fill();
    },
    reeds(ctx, r, R) {
        ctx.lineCap = 'round';
        for (let i = 0; i < 9; i++) {
            const a = R.range(0, 6.28), d = R.range(0, r * 0.4), x = Math.cos(a) * d, y = Math.sin(a) * d, len = R.range(0.6, 1) * r, b = R.range(-2.4, -0.7);
            ctx.strokeStyle = '#3c4a22'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(b) * len, y + Math.sin(b) * len); ctx.stroke();
            ctx.strokeStyle = '#7c8f3e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(b) * len, y + Math.sin(b) * len); ctx.stroke();
            if (i % 3 === 0) { ctx.fillStyle = '#6b4a2c'; ctx.beginPath(); ctx.ellipse(x + Math.cos(b) * len, y + Math.sin(b) * len, 3, 6, b, 0, 6.28); ctx.fill(); }
        }
    },
    lilypad(ctx, r, R) {
        ctx.fillStyle = 'rgba(25,40,20,0.8)'; ctx.beginPath(); ctx.arc(0, 0, r + 2, 0.3, 6.0); ctx.lineTo(0, 0); ctx.fill();
        ctx.fillStyle = '#5f8a3a'; ctx.beginPath(); ctx.arc(0, 0, r, 0.3, 6.0); ctx.lineTo(0, 0); ctx.fill();
        if (R() < 0.4) { ctx.fillStyle = '#f2ede0'; ctx.beginPath(); ctx.arc(r * 0.2, -r * 0.2, r * 0.28, 0, 6.28); ctx.fill(); }
    },
    crystal(ctx, r, R) {
        ctx.save(); ctx.shadowColor = 'rgba(46,230,214,0.8)'; ctx.shadowBlur = r * 0.8;
        for (let i = 0; i < 5; i++) {
            const a = R.range(-2.6, -0.5), len = r * R.range(0.6, 1.1), w = r * R.range(0.16, 0.26), x = R.range(-r * 0.3, r * 0.3), y = R.range(-r * 0.1, r * 0.3);
            ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2);
            ctx.beginPath(); ctx.moveTo(0, -len); ctx.lineTo(w, -len * 0.75); ctx.lineTo(w * 0.8, 0); ctx.lineTo(-w * 0.8, 0); ctx.lineTo(-w, -len * 0.75); ctx.closePath();
            ctx.fillStyle = '#5fd6cc'; ctx.strokeStyle = '#0d3b38'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
            ctx.fillStyle = 'rgba(220,255,250,0.6)'; ctx.beginPath(); ctx.moveTo(0, -len); ctx.lineTo(-w, -len * 0.75); ctx.lineTo(-w * 0.8, 0); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();
            ctx.restore();
        }
        ctx.restore();
    },
    pillar(ctx, r, R) {
        ctx.fillStyle = OUTLINE; ctx.beginPath(); ctx.arc(0, 0, r + 3, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#9a958a'; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#b8b3a6'; ctx.beginPath(); ctx.arc(-r * 0.15, -r * 0.15, r * 0.7, 0, 6.28); ctx.fill();
        ctx.strokeStyle = 'rgba(60,55,48,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(-r * 0.15, -r * 0.15, r * 0.45, 0, 6.28); ctx.stroke();
        for (let i = 0; i < 4; i++) { ctx.fillStyle = '#8f8a7e'; ctx.beginPath(); ctx.arc(R.range(-r * 1.6, r * 1.6), R.range(-r * 1.6, r * 1.6), r * R.range(0.15, 0.3), 0, 6.28); ctx.fill(); }
    },
    ruin(ctx, r, R, o, cell) {
        // L-образный угол из каменных блоков: длина len клеток, толщина ~0.6 клетки
        const t = cell * 0.62, len = (o.len ?? 3) * cell;
        const wall = (x, y, w, h) => {
            ctx.fillStyle = OUTLINE; ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
            const along = w > h, n = Math.round((along ? w : h) / (cell * 0.45));
            for (let i = 0; i < n; i++) {
                const bx = along ? x + (i * w) / n : x, by = along ? y : y + (i * h) / n, bw = along ? w / n - 2 : w, bh = along ? h : h / n - 2;
                ctx.fillStyle = rgb(mix(hex('#8d877a'), hex('#a8a294'), R())); ctx.fillRect(bx + 1, by + 1, bw, bh);
                ctx.fillStyle = 'rgba(255,250,235,0.18)'; ctx.fillRect(bx + 1, by + 1, bw, bh * 0.35);
            }
            ctx.fillStyle = 'rgba(100,135,55,0.7)'; ctx.beginPath(); ctx.ellipse(x + w * R.range(0.2, 0.8), y + h * R.range(0.2, 0.8), Math.max(w, h) * 0.12, Math.min(w, h) * 0.45, 0, 0, 6.28); ctx.fill();
        };
        wall(-t / 2, -t / 2, len, t);
        wall(-t / 2, -t / 2, t, len * 0.75);
        // Обломки
        for (let i = 0; i < 7; i++) { ctx.fillStyle = '#8f8a7e'; ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1.5; const s = R.range(6, 14); const x = R.range(0, len), y = R.range(t, t * 2.2); ctx.fillRect(x, y, s, s * 0.8); ctx.strokeRect(x, y, s, s * 0.8); }
    }
};

// ---------- Свой арт: какую картинку взять для предмета

// Какие картинки годятся предмету: имя-номер или имя-номер-вариант (из листа вариантов): tree-1, rock-2-3 …
const ART_NAMES = { tree: ['tree'], pine: ['pine'], deadtree: ['deadtree'], bush: ['bush'], reeds: ['reeds'], rock: ['rock'], boulder: ['boulder'], log: ['log'], stump: ['stump'], ruin: ['ruin'], crystal: ['crystal'], pillar: ['pillar'], lilypad: ['lilypads'], roots: ['roots'] };
const artCache = new WeakMap();
function artFor(art, o) {
    const lists = artCache.get(art) ?? {};
    artCache.set(art, lists);
    lists[o.kind] ??= (ART_NAMES[o.kind] ?? []).flatMap(p => Object.keys(art).filter(k => new RegExp(`^${p}-[0-9]+(-[0-9]+)?$`).test(k))).sort();
    const have = lists[o.kind];
    if (!have.length && o.kind === 'boulder') return artFor(art, { ...o, kind: 'rock' });
    // Вариант — от места предмета: копии одного вида расходятся по всем картинкам
    return have.length ? art[have[Math.floor(rng(`${o.x.toFixed(2)}|${o.y.toFixed(2)}|art`)() * have.length)]] : null;
}
/** Стены руин из картинки прямой стены: вдоль оси и вторая — поперёк, от угла (как стены сцены в arena.js) */
function drawRuin(ctx, img, o, cell) {
    const t = cell * 0.62, len = (o.len ?? 3) * cell, h = Math.max(t * 1.1, (img.height / img.width) * len);
    ctx.drawImage(img, -t / 2, -h / 2, len, h);
    if (o.shape !== 'I') { ctx.save(); ctx.rotate(Math.PI / 2); ctx.drawImage(img, -t / 2, -h / 2, len * 0.75, h); ctx.restore(); }
}

// Разброс оттенка (градусы) у каждого экземпляра, пятно затенения под предметом (доля радиуса),
// пучки травы у подножия (сколько)
const VARIETY = { tree: 14, pine: 10, bush: 16, deadtree: 6, reeds: 10, rock: 5, boulder: 5, log: 6, stump: 6, crystal: 0 };
const GROUND_SHADE = { rock: 0.95, boulder: 0.95, stump: 0.9, log: 0.55, ruin: 0, pillar: 0.9, crystal: 0.7, bush: 0.85 };
const BASE_TUFTS = { rock: 4, boulder: 6, stump: 4, log: 4, pillar: 3, crystal: 3 };

/**
 * Виньетка: картинка целиком на свои клетки (без поворота — свет нарисован), мягкая тень, затенение под ней и
 * трава по краю — чтобы не лежала наклейкой
 */
function drawVignette(ctx, o, art, cell, tuftArt, seed) {
    const img = art[`vignette-${o.name}-1`] ?? art[`vignette-${o.name}`];
    if (!img) return;
    const J = rng(`${seed}|vg|${o.x.toFixed(2)}`);
    if (o.name === 'bridge') return drawBridge(ctx, o, img, cell);
    const w = o.w * cell, h = o.h * cell, k = Math.min(w / img.width, h / img.height), dw = img.width * k, dh = img.height * k;
    const x = o.x * cell - dw / 2, y = o.y * cell - dh / 2;
    const g = ctx.createRadialGradient(o.x * cell, o.y * cell, Math.min(dw, dh) * 0.25, o.x * cell, o.y * cell, Math.max(dw, dh) * 0.6);
    g.addColorStop(0, `rgba(${SHADE},0.35)`); g.addColorStop(1, `rgba(${SHADE},0)`);
    ctx.fillStyle = g; ctx.fillRect(x - cell, y - cell, dw + 2 * cell, dh + 2 * cell);
    ctx.save(); ctx.filter = `blur(${cell * 0.1}px)`; ctx.globalAlpha = 0.3; ctx.drawImage(silhouette(img), x + cell * 0.12, y + cell * 0.15, dw, dh); ctx.restore();
    ctx.drawImage(img, x, y, dw, dh);
    if (o.name === 'bridge') return;
    // Трава прорастает и между предметами, по краям брёвен и обломков — не наклейка поверх травы; середина
    // (очаг) — без травы
    if (VIGNETTES[o.name]?.ground) for (let i = 0; tuftArt.length && i < o.w * o.h * 0.8; i++) {
        const a = J.range(0, 6.28), d = 0.35 + Math.sqrt(J()) * 0.5, t = J.pick(tuftArt), sz = cell * J.range(0.18, 0.32), kk = sz / Math.max(t.width, t.height);
        ctx.drawImage(t, o.x * cell + Math.cos(a) * d * dw / 2 - (t.width * kk) / 2, o.y * cell + Math.sin(a) * d * dh / 2 - (t.height * kk) / 2, t.width * kk, t.height * kk);
    }
    for (let i = 0; tuftArt.length && i < o.w * o.h * 0.9; i++) {
        const a = J.range(0, 6.28), rx = dw / 2 * J.range(0.85, 1.05), ry = dh / 2 * J.range(0.85, 1.05), t = J.pick(tuftArt), sz = cell * J.range(0.25, 0.42), kk = sz / Math.max(t.width, t.height);
        ctx.drawImage(t, o.x * cell + Math.cos(a) * rx - (t.width * kk) / 2, o.y * cell + Math.sin(a) * ry - (t.height * kk) / 2, t.width * kk, t.height * kk);
    }
}

/** Мост — поперёк ручья: картинка повёрнута на угол течения (o.rot), тень падает на воду */
function drawBridge(ctx, o, img, cell) {
    const k = Math.min((o.w * cell) / img.width, (o.h * cell) / img.height), dw = img.width * k, dh = img.height * k;
    ctx.save();
    ctx.translate(o.x * cell, o.y * cell); ctx.rotate(o.rot ?? 0);
    ctx.save(); ctx.filter = `blur(${cell * 0.1}px)`; ctx.globalAlpha = 0.35; ctx.drawImage(silhouette(img), -dw / 2 + cell * 0.12, -dh / 2 + cell * 0.15, dw, dh); ctx.restore();
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
}

// Цвет тени: холодный тёмно-синий, а не чёрный и не бурый — тень меняет оттенок, а не только яркость
const SHADE = '20,30,58';

/** Силуэт картинки цветом тени (для падающих теней) */
function silhouette(img) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const l = c.getContext('2d');
    l.drawImage(img, 0, 0); l.globalCompositeOperation = 'source-in'; l.fillStyle = `rgb(${SHADE})`; l.fillRect(0, 0, c.width, c.height);
    return c;
}

// ---------- Палитра биома: арт перекрашивается при сборке, сами картинки не меняются
// Лес — как у готовых карт: зелень не оливковая, а настоящая (тон сдвинут к зелёному), кроны светлее,
// тропа светлая и кремовая, а не рыжая. Ключ — начало имени картинки
const PALETTES = {
    forest: {
        'ground-grass': 'hue-rotate(20deg) saturate(1.15) brightness(1.12)',
        'ground-forest-floor': 'hue-rotate(18deg) saturate(1.1) brightness(1.3)',
        'ground-path': 'sepia(0.35) saturate(0.8) brightness(1.24)',
        'ground-mud': 'saturate(0.85) brightness(1.05)',
        tree: 'hue-rotate(22deg) saturate(1.12) brightness(1.3) contrast(1.06)',
        pine: 'hue-rotate(18deg) saturate(1.1) brightness(1.3) contrast(1.06)',
        bush: 'hue-rotate(20deg) saturate(1.12) brightness(1.22)',
        reeds: 'hue-rotate(16deg) brightness(1.12)',
        'scatter-tufts': 'hue-rotate(20deg) saturate(1.1) brightness(1.12)',
        'scatter-ferns': 'hue-rotate(20deg) saturate(1.1) brightness(1.12)'
    }
};
const recolored = new WeakMap();

/** Арт в палитре биома (копия на холсте; одна на картинку и фильтр) */
function inPalette(art, biome) {
    const table = PALETTES[biome];
    if (!table) return art;
    const out = {};
    for (const [name, img] of Object.entries(art)) {
        const key = Object.keys(table).find(k => name.startsWith(k));
        if (!key) { out[name] = img; continue; }
        const cache = recolored.get(img) ?? new Map();
        recolored.set(img, cache);
        if (!cache.has(table[key])) {
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const l = c.getContext('2d'); l.filter = table[key]; l.drawImage(img, 0, 0);
            cache.set(table[key], c);
        }
        out[name] = cache.get(table[key]);
    }
    return out;
}

// ---------- Отрисовка

/**
 * @param {object} plan  планировка (layout.js)
 * @param {object} o     cell — пикселей в клетке; mood — day|night|fog|rot|blood; art — { [имя]: Image } готовые картинки
 */
export function paint(plan, { cell = 140, mood = 'day', art = {} } = {}) {
    art = inPalette(art, plan.biome ?? 'forest');
    const W = plan.cols * cell, H = plan.rows * cell;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const seed = plan.seed;
    // Текстуры: свои картинки (ground-<имя>-1), иначе заглушка; берега — грязь, мох и камень — трава/подстилка
    const GROUND_ART = { grass: 'grass', forest: 'forest-floor', litter: 'forest-floor', dirt: 'path', moss: 'grass', rock: art['ground-rock-1'] ? 'rock' : 'path', path: 'path', mud: 'mud', bank: 'mud', riverbed: 'riverbed' };
    const tex = type => art[`ground-${GROUND_ART[type]}-1`] ?? art[`ground-${type}`] ?? groundTexture(type, seed);
    const M = masks(plan, cell, seed);

    // Земля: трава, затем пятна, тропа, берег и дно
    ctx.fillStyle = ctx.createPattern(tex('grass'), 'repeat'); ctx.fillRect(0, 0, W, H);
    layer(ctx, tex('forest'), M.forest, W, H, 0.95);
    layer(ctx, tex('moss'), M.moss, W, H, 0.8);
    layer(ctx, tex('rock'), M.rock, W, H, 0.9);
    // Под виньетками из отдельных предметов — своя земля: утоптанная у костра, подстилка под обломками
    layer(ctx, tex('litter'), M.litter, W, H, 0.9);
    layer(ctx, tex('dirt'), M.dirt, W, H, 0.8);
    if (M.bank) layer(ctx, tex('bank'), M.bank, W, H);
    // Тропа — с тёмной кромкой (рисованный контур)
    const pathLayer = document.createElement('canvas'); pathLayer.width = W; pathLayer.height = H;
    { const l = pathLayer.getContext('2d'); l.filter = `blur(${cell * 0.06}px)`; l.drawImage(M.path, 0, 0, W, H); }
    ctx.save(); ctx.globalAlpha = 0.35; ctx.filter = 'brightness(0)'; ctx.drawImage(pathLayer, 2, 3); ctx.restore();
    layer(ctx, tex('path'), M.path, W, H);

    // Вода — как ручей на готовых картах: плоские тона с рваной границей (мель у берега светлая, середина
    // бирюзовая, глубь тёмная), зерно взвеси, светлая кайма у кромки, тёмная линия берега, пара бликов
    if (M.riverbed) {
        const flat = (mask, color) => {
            const c = document.createElement('canvas'); c.width = W; c.height = H;
            const l = c.getContext('2d');
            l.fillStyle = color; l.fillRect(0, 0, W, H);
            l.globalCompositeOperation = 'destination-in'; l.imageSmoothingQuality = 'high'; l.drawImage(mask, 0, 0, W, H);
            ctx.drawImage(c, 0, 0);
        };
        flat(M.riverbed, 'rgb(92,182,152)');
        flat(M.waterMid, 'rgb(40,128,122)');
        // Глубь — размытыми пятнами, как акварельный подтёк
        {
            const c = document.createElement('canvas'); c.width = W; c.height = H;
            const l = c.getContext('2d');
            l.filter = `blur(${cell * 0.25}px)`; l.drawImage(M.waterDeep, 0, 0, W, H); l.filter = 'none';
            l.globalCompositeOperation = 'source-in'; l.fillStyle = 'rgb(16,70,84)'; l.fillRect(0, 0, W, H);
            l.globalCompositeOperation = 'destination-in'; l.drawImage(M.riverbed, 0, 0, W, H);
            ctx.save(); ctx.globalAlpha = 0.85; ctx.drawImage(c, 0, 0); ctx.restore();
        }
        const R = rng(`water|${seed}`);
        // Зерно: мелкие светлые и тёмные крапинки — фактура и никаких полос на переходах
        const grain = document.createElement('canvas'); grain.width = W; grain.height = H;
        const gl = grain.getContext('2d');
        const wet = (plan.terrain.stream ? plan.terrain.stream.path.length * (plan.terrain.stream.width + 1) : 0) + (plan.terrain.pools ?? []).reduce((t, p) => t + p.r * p.r * 4, 0);
        for (let i = 0; i < wet * 90; i++) {
            const x = R.range(0, W), y = R.range(0, H), light = R() < 0.45;
            gl.fillStyle = light ? 'rgba(210,246,232,0.22)' : 'rgba(8,46,50,0.2)';
            gl.beginPath(); gl.arc(x, y, R.range(0.8, 2.2) * (cell / 140), 0, 6.28); gl.fill();
        }
        gl.globalCompositeOperation = 'destination-in'; gl.drawImage(M.riverbed, 0, 0, W, H);
        ctx.drawImage(grain, 0, 0);
        // Кромка: тёмная линия берега снаружи и светлая кайма внутри
        for (const [grow, color, inside] of [[cell * 0.1, 'rgba(58,44,26,0.45)', false], [cell * 0.14, 'rgba(176,236,210,0.5)', true]]) {
            const c = document.createElement('canvas'); c.width = W; c.height = H;
            const l = c.getContext('2d');
            l.filter = `blur(${grow}px)`; l.drawImage(M.riverbed, 0, 0, W, H); l.filter = 'none';
            if (inside) { l.globalCompositeOperation = 'source-in'; l.drawImage(M.riverbed, 0, 0, W, H); }
            l.globalCompositeOperation = 'destination-out';
            if (inside) { l.filter = `blur(${grow * 0.3}px)`; }
            l.drawImage(M.riverbed, 0, 0, W, H);
            l.filter = 'none';
            l.globalCompositeOperation = 'source-in'; l.fillStyle = color; l.fillRect(0, 0, W, H);
            ctx.drawImage(c, 0, 0);
        }
        // Пена: вокруг камней и брёвен в воде — светлое размытое пятно мели
        const collars = document.createElement('canvas'); collars.width = W; collars.height = H;
        const cl = collars.getContext('2d');
        for (const o of plan.objects) {
            if (!['rock', 'boulder', 'log', 'stump', 'pillar'].includes(o.kind) || wetness(plan, o.x, o.y) < -o.r * 0.5) continue;
            const J = rng(`${seed}|collar|${o.x.toFixed(2)}`), r = o.r * cell * 1.15, pts = [];
            for (let i = 0; i < 9; i++) { const a = (i / 9) * 6.283, k = J.range(0.9, 1.1); pts.push([o.x * cell + Math.cos(a) * r * k, o.y * cell + Math.sin(a) * r * k]); }
            // Плавный контур: кривые через середины соседних точек
            const ring = () => {
                const mid = i => { const [x1, y1] = pts[i % 9], [x2, y2] = pts[(i + 1) % 9]; return [(x1 + x2) / 2, (y1 + y2) / 2]; };
                cl.beginPath(); cl.moveTo(...mid(0));
                for (let i = 1; i <= 9; i++) cl.quadraticCurveTo(...pts[i % 9], ...mid(i));
                cl.closePath();
            };
            cl.fillStyle = 'rgba(150,214,190,0.55)'; ring(); cl.fill();
        }
        cl.globalCompositeOperation = 'destination-in'; cl.drawImage(M.riverbed, 0, 0, W, H);
        // Пена у камней — размытым пятном, без чёткого края (иначе читается как выделение)
        ctx.save(); ctx.filter = `blur(${cell * 0.08}px)`; ctx.drawImage(collars, 0, 0); ctx.restore();
    }

    clouds(ctx, W, H, cell, seed);
    canopyShadow(ctx, plan, W, H, cell);
    const rotMask = mood === 'rot' ? rotGround(ctx, { W, H, cell, seed, art }) : null;
    // Жилы порчи — по земле, под предметами и кронами
    if (mood === 'rot') rotVeins(ctx, { W, H, cell, seed });
    scatter(ctx, plan, cell, seed, art, M.riverbed);

    // Предметы: снизу вверх по высоте — плоское, камни, кусты, кроны
    const ORDER = ['lilypad', 'vignette', 'reeds', 'log', 'stump', 'rock', 'boulder', 'ruin', 'pillar', 'crystal', 'bush', 'deadtree', 'pine', 'tree'];
    const objects = [...plan.objects].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.y - b.y);
    const R = rng(`sprites|${seed}`);
    const tuftArt = Object.keys(art).filter(k => k.startsWith('scatter-tufts') || k.startsWith('scatter-ferns')).map(k => art[k]);
    const SHADOW = { tree: 0.35, pine: 0.32, deadtree: 0.18, bush: 0.15, rock: 0.12, boulder: 0.2, log: 0.1, ruin: 0.22, pillar: 0.25, stump: 0.08, crystal: 0.12, reeds: 0.05, lilypad: 0 };
    for (const o of objects) {
        if (o.kind === 'vignette') { drawVignette(ctx, o, art, cell, tuftArt, seed); continue; }
        const r = o.r * cell, size = Math.ceil((o.kind === 'ruin' ? (o.len ?? 3) * 2.4 : 2.6) * Math.max(r, cell * 0.5));
        const spr = document.createElement('canvas'); spr.width = spr.height = size;
        const s = spr.getContext('2d');
        s.translate(size / 2, size / 2);
        const own = artFor(art, o);
        const J = rng(`${seed}|var|${o.x.toFixed(2)}|${o.y.toFixed(2)}`);
        // Свой арт освещён сверху слева: поворот — лёгкий (±14°), этого хватает, чтобы копии не узнавались;
        // бревно и стены — как угодно. Ещё размер ±12% и свой оттенок у каждого
        if (!own || o.kind === 'log' || o.kind === 'ruin') s.rotate(o.rot);
        else s.rotate(J.range(-0.25, 0.25));
        const k0 = own && o.kind !== 'ruin' ? J.range(0.88, 1.12) : 1;
        const tint = VARIETY[o.kind] ? `hue-rotate(${J.range(-VARIETY[o.kind], VARIETY[o.kind])}deg) saturate(${J.range(0.85, 1.12)}) brightness(${J.range(0.88, 1.08)})` : 'none';
        s.filter = tint;
        if (own && o.kind === 'ruin') drawRuin(s, own, o, cell);
        else if (own) { const k = (2 * r * k0) / Math.max(own.width, own.height); s.drawImage(own, (-own.width * k) / 2, (-own.height * k) / 2, own.width * k, own.height * k); }
        else SPRITES[o.kind]?.(s, r, rng(`${seed}|${o.kind}|${o.x.toFixed(2)}|${o.y.toFixed(2)}`), o, cell);
        s.filter = 'none';
        const px = o.x * cell, py = o.y * cell;
        // Посадка: пятно затенения прямо под предметом — он стоит на земле, а не лежит поверх
        if (GROUND_SHADE[o.kind]) {
            const rr = r * GROUND_SHADE[o.kind] * k0, g = ctx.createRadialGradient(px + rr * 0.15, py + rr * 0.2, rr * 0.3, px + rr * 0.15, py + rr * 0.2, rr * 1.15);
            g.addColorStop(0, `rgba(${SHADE},0.55)`); g.addColorStop(1, `rgba(${SHADE},0)`);
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px + rr * 0.15, py + rr * 0.2, rr * 1.15, 0, 6.28); ctx.fill();
        }
        // Падающая тень: свет сверху слева — тень вправо вниз, мягкая
        const off = SHADOW[o.kind] * cell;
        if (off) {
            ctx.save(); ctx.filter = `blur(${cell * 0.08}px)`; ctx.globalAlpha = 0.45;
            ctx.drawImage(silhouette(spr), px - size / 2 + off, py - size / 2 + off * 1.15); ctx.restore();
        }
        ctx.drawImage(spr, px - size / 2, py - size / 2);
        // Трава и мелочь заходят на подножие камней, пней и брёвен — они «врастают» в землю
        if (BASE_TUFTS[o.kind] && tuftArt.length) {
            for (let i = 0; i < BASE_TUFTS[o.kind]; i++) {
                const a = J.range(0.2, 3.0), d = r * k0 * J.range(0.75, 1.0), img = J.pick(tuftArt), sz = cell * J.range(0.25, 0.4), kk = sz / Math.max(img.width, img.height);
                ctx.drawImage(img, px + Math.cos(a) * d - (img.width * kk) / 2, py + Math.sin(a) * d - (img.height * kk) / 2, img.width * kk, img.height * kk);
            }
        }
    }

    light(ctx, plan, { W, H, cell, mood, seed });
    grade(ctx, plan, { W, H, cell, mood, seed, M, art, rotMask });
    return canvas;
}

// ---------- Облачная светотень: крупные мягкие пятна светлее и темнее — объём без мелкого шума

function clouds(ctx, W, H, cell, seed) {
    const R = rng(`clouds|${seed}`);
    for (let i = 0; i < Math.round((W * H) / (cell * cell * 6)); i++) {
        const x = R.range(0, W), y = R.range(0, H), r = cell * R.range(1.5, 4), light = R() < 0.5;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, light ? 'rgba(255,240,190,0.10)' : `rgba(${SHADE},0.10)`); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.28); ctx.fill();
    }
}

// ---------- Свет: одно солнечное место, лес по краям темнее, общая тень крон

// Сколько кроны закрывают свет
const CANOPY = { tree: 1, pine: 0.9, bush: 0.4, deadtree: 0.3 };

/** Солнечное место: самое открытое ближе к середине — туда смотрит глаз, там обычно и бой */
function sunSpot(plan) {
    const block = plan.objects.filter(o => CANOPY[o.kind] || o.kind === 'boulder' || o.kind === 'ruin' || o.kind === 'vignette');
    let best = null;
    for (let y = 1.5; y < plan.rows - 1.5; y += 0.5) for (let x = 1.5; x < plan.cols - 1.5; x += 0.5) {
        let open = 6;
        for (const o of block) open = Math.min(open, Math.hypot(o.x - x, o.y - y) - o.r);
        const off = Math.hypot((x - plan.cols / 2) / plan.cols, (y - plan.rows / 2) / plan.rows);
        const score = open - off * 7;
        if (!best || score > best.score) best = { x, y, score, open: Math.max(1, open) };
    }
    return best ?? { x: plan.cols / 2, y: plan.rows / 2, open: 2 };
}

/** Маска крон в ¼ размера, размытая: кроны заслоняют свет — по ней тень на земле и сумрак чащи */
function canopyMask(plan, W, H, cell, { grow = 1, shift = 0, blur = 0.5, alpha = 1 } = {}) {
    const q = 4, c = document.createElement('canvas'); c.width = Math.ceil(W / q); c.height = Math.ceil(H / q);
    const l = c.getContext('2d');
    l.filter = `blur(${(cell * blur) / q}px)`;
    l.fillStyle = '#000';
    for (const o of plan.objects) {
        if (!CANOPY[o.kind]) continue;
        l.globalAlpha = CANOPY[o.kind] * alpha;
        l.beginPath(); l.arc((o.x * cell + shift) / q, (o.y * cell + shift * 1.15) / q, (o.r * cell * grow) / q, 0, 6.28); l.fill();
    }
    return c;
}

/** Залить маску цветом и положить умножением — холодное затемнение без грязи */
function multiplyMask(ctx, mask, W, H, color, alpha) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const l = c.getContext('2d');
    l.imageSmoothingQuality = 'high'; l.drawImage(mask, 0, 0, W, H);
    l.globalCompositeOperation = 'source-in'; l.fillStyle = color; l.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = alpha; ctx.drawImage(c, 0, 0); ctx.restore();
}

/** Общая тень крон на земле — до предметов, свет сверху слева: тень сдвинута вправо вниз, большая и мягкая */
function canopyShadow(ctx, plan, W, H, cell) {
    multiplyMask(ctx, canopyMask(plan, W, H, cell, { grow: 1.1, shift: cell * 0.6, blur: 0.6 }), W, H, 'rgb(84,128,166)', 0.7);
}

/**
 * После предметов: чаща темнее и холоднее, края карты уходят в сумрак, на открытом месте — тёплое солнечное
 * пятно и редкие блики сквозь листву. Ночью солнца нет — остаются сумрак и холод
 */
function light(ctx, plan, { W, H, cell, mood, seed }) {
    const R = rng(`light|${seed}`), sun = sunSpot(plan), sx = sun.x * cell, sy = sun.y * cell;
    // Чаща: где кроны гуще — там темнее (одиночное дерево почти не трогается)
    multiplyMask(ctx, canopyMask(plan, W, H, cell, { grow: 1.5, blur: 1.4, alpha: 0.35 }), W, H, 'rgb(96,132,170)', 0.55);
    // Края: от солнечного места к краям — холодный сумрак
    const far = Math.hypot(Math.max(sx, W - sx), Math.max(sy, H - sy));
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, far);
    g.addColorStop(0, 'rgb(255,255,255)'); g.addColorStop(0.45, 'rgb(255,255,255)'); g.addColorStop(0.8, 'rgb(214,224,238)'); g.addColorStop(1, 'rgb(160,178,206)');
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
    if (mood === 'night') return;
    // Солнце: тёплое пятно на самом открытом месте; где на землю падает тень крон — его нет, край пятна
    // повторяет кроны (как свет в просвете леса, а не дымка)
    const r = cell * Math.min(10, Math.max(6, sun.open * 2.6));
    const sunLayer = document.createElement('canvas'); sunLayer.width = W; sunLayer.height = H;
    const sl = sunLayer.getContext('2d'), sg = sl.createRadialGradient(sx, sy, 0, sx, sy, r);
    sg.addColorStop(0, 'rgba(255,222,150,0.75)'); sg.addColorStop(0.5, 'rgba(255,222,150,0.4)'); sg.addColorStop(1, 'rgba(255,222,150,0)');
    sl.fillStyle = sg; sl.fillRect(0, 0, W, H);
    sl.globalCompositeOperation = 'destination-out'; sl.globalAlpha = 0.6; sl.imageSmoothingQuality = 'high';
    sl.drawImage(canopyMask(plan, W, H, cell, { grow: 1.05, shift: cell * 0.6, blur: 0.7 }), 0, 0, W, H);
    ctx.save(); ctx.globalCompositeOperation = 'soft-light'; ctx.drawImage(sunLayer, 0, 0);
    ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.22; ctx.drawImage(sunLayer, 0, 0); ctx.restore();
    // Блики сквозь листву: тёплые пятна на открытых клетках у края крон
    const crowns = plan.objects.filter(o => CANOPY[o.kind] >= 0.9);
    ctx.save(); ctx.globalCompositeOperation = 'soft-light';
    for (let i = 0, n = Math.round((plan.cols * plan.rows) / 30); i < n * 6 && crowns.length; i++) {
        const x = R.range(1, plan.cols - 1), y = R.range(1, plan.rows - 1);
        let d = 9; for (const o of crowns) d = Math.min(d, Math.hypot(o.x - x, o.y - y) - o.r);
        if (d < 0.2 || d > 1.6 || R() > 0.3) continue;
        const rr = cell * R.range(0.5, 1.2), bg = ctx.createRadialGradient(x * cell, y * cell, 0, x * cell, y * cell, rr);
        bg.addColorStop(0, 'rgba(255,226,140,0.5)'); bg.addColorStop(1, 'rgba(255,226,140,0)');
        ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(x * cell, y * cell, rr, 0, 6.28); ctx.fill();
    }
    ctx.restore();
}

/** Насколько точка внутри воды: >0 — в воде на столько клеток от кромки, <0 — на берегу */
function wetness(plan, x, y) {
    const { stream: s, pools = [] } = plan.terrain;
    return Math.max(s ? s.width / 2 - distToPath(s.path, x, y) : -99, ...pools.map(p => p.r - Math.hypot(p.x - x, p.y - y)), -99);
}

// ---------- Россыпь: пучки травы, камешки, веточки — гуще у краёв (тропа, берег, перелески, подножия)

function tuft(ctx, x, y, s, R, col) {
    const n = R.int(9, 14);
    ctx.lineCap = 'round';
    for (const [w, c] of [[s * 0.2 + 1.2, 'rgba(62,44,26,0.65)'], [s * 0.14, rgb(col)]]) {
        ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath();
        for (let i = 0; i < n; i++) { const a = (i / n) * 6.28 + R.range(-0.2, 0.2), l = s * R.range(0.6, 1); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); }
        ctx.stroke();
    }
    ctx.fillStyle = rgb(mix(col, [255, 240, 170], 0.35)); ctx.beginPath(); ctx.arc(x - s * 0.1, y - s * 0.1, s * 0.18, 0, 6.28); ctx.fill();
}

function scatter(ctx, plan, cell, seed, art = {}, waterMask = null) {
    const pieces = prefix => Object.keys(art).filter(k => k.startsWith(prefix)).map(k => art[k]);
    const tufts = [...pieces('scatter-tufts'), ...pieces('scatter-ferns'), ...pieces('scatter-flowers')], small = [...pieces('scatter-pebbles'), ...pieces('scatter-twigs'), ...pieces('scatter-mushrooms'), ...pieces('scatter-leaves'), ...pieces('scatter-bones')];
    // Картинка мелочи садится в землю: контур приглушён, цвет чуть темнее и ближе к земле (перекраска — один раз
    // на картинку, фильтр на каждый оттиск слишком дорог)
    const soft = new Map();
    const muted = img => {
        if (!soft.has(img)) {
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const l = c.getContext('2d'); l.filter = 'contrast(0.82) saturate(0.9) brightness(0.95)'; l.drawImage(img, 0, 0);
            soft.set(img, c);
        }
        return soft.get(img);
    };
    const stamp = (img, x, y, size, alpha = 1) => {
        const k = size / Math.max(img.width, img.height), im = muted(img);
        ctx.globalAlpha = alpha;
        ctx.drawImage(im, x - (img.width * k) / 2, y - (img.height * k) / 2, img.width * k, img.height * k);
        ctx.globalAlpha = 1;
    };
    // Мягкая тень под кучкой — пучки растут из земли, а не лежат поверх
    const shade = (x, y, r, a) => {
        const g = ctx.createRadialGradient(x + r * 0.15, y + r * 0.2, 0, x + r * 0.15, y + r * 0.2, r);
        g.addColorStop(0, `rgba(${SHADE},${a})`); g.addColorStop(1, `rgba(${SHADE},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x + r * 0.15, y + r * 0.2, r, 0, 6.28); ctx.fill();
    };
    const R = rng(`scatter|${seed}`), { cols, rows, terrain, objects } = plan;
    const near = (d, w, band) => Math.abs(d - w) < band;
    const tones = [hex('#8a9a3c'), hex('#a39a44'), hex('#6f8a36'), hex('#b0a050')];
    const s = terrain.stream;
    // Вода — по самой маске (кромка рваная, средняя линия ручья её не знает)
    const wm = waterMask?.getContext('2d').getImageData(0, 0, waterMask.width, waterMask.height), ws = waterMask ? waterMask.width / cols : 1;
    const wetAt = (x, y) => { if (!wm) return false; const i = Math.min(wm.width - 1, Math.max(0, Math.floor(x * ws))), j = Math.min(wm.height - 1, Math.max(0, Math.floor(y * ws))); return wm.data[(j * wm.width + i) * 4 + 3] > 127; };
    const wet = (x, y) => wetAt(x, y) || wetAt(x + 0.1, y) || wetAt(x - 0.1, y) || wetAt(x, y + 0.1) || wetAt(x, y - 0.1);
    // Кромка: рядом есть и вода, и берег
    const onBank = (x, y) => { const d = 0.16, v = [wetAt(x, y), wetAt(x + d, y), wetAt(x - d, y), wetAt(x, y + d), wetAt(x, y - d)]; return v.some(Boolean) && !v.every(Boolean); };
    // Пучки — кучками по 3–6 у краёв (тропа, берег, подножия), на открытом месте — изредка
    for (let i = 0; i < cols * rows * 0.7; i++) {
        const x = R.range(0, cols), y = R.range(0, rows);
        const dPath = distToPath(terrain.path, x, y), dWater = s ? distToPath(s.path, x, y) : 99;
        // Полоса кромки: пучки здесь нависают над водой рваным краем, как на готовых картах
        const bank = onBank(x, y);
        if ((wet(x, y) && !bank) || dPath < 0.7) continue;
        const edge = bank || near(dPath, 0.95, 0.3) || (s && near(dWater, s.width / 2 + 0.35, 0.35))
            || objects.some(o => ['tree', 'pine', 'rock', 'boulder', 'ruin', 'log', 'stump'].includes(o.kind) && near(Math.hypot(o.x - x, o.y - y), o.r * 0.95, 0.35));
        if (!edge && R() > 0.04) continue;
        const n = edge ? R.int(3, 6) : R.int(2, 3), spread = cell * R.range(0.22, 0.38);
        if (!bank) shade(x * cell, y * cell, spread * 1.5, 0.28);
        for (let j = 0; j < n; j++) {
            const a = R.range(0, 6.28), d = spread * Math.sqrt(R()), px = x * cell + Math.cos(a) * d, py = y * cell + Math.sin(a) * d;
            if (tufts.length) stamp(R.pick(tufts), px, py, cell * R.range(0.2, 0.38), R.range(0.75, 0.95));
            else tuft(ctx, px, py, cell * R.range(0.1, 0.18), R, R.pick(tones));
        }
    }
    // Кромка ручья: вдоль обоих берегов кучки пучков, нависающие над водой
    if (s && tufts.length) for (let i = 1; i < s.path.length; i++) {
        const p0 = s.path[i - 1], p1 = s.path[i], dx = p1.x - p0.x, dy = p1.y - p0.y, l = Math.hypot(dx, dy) || 1;
        for (let t = 0; t < l; t += 0.55) for (const side of [-1, 1]) {
            if (R() > 0.45) continue;
            // Ищем кромку поперёк ручья: от середины наружу — первая точка, где вода кончается
            let x = 0, y = 0, found = false;
            for (let d = 0.2; d < s.width / 2 + 1.2 && !found; d += 0.06) {
                x = p0.x + (dx / l) * t - (dy / l) * side * d; y = p0.y + (dy / l) * t + (dx / l) * side * d;
                found = !wetAt(x, y);
            }
            if (!found || distToPath(terrain.path, x, y) < 0.9) continue;
            for (let j = 0, n = R.int(2, 4); j < n; j++) stamp(R.pick(tufts), (x + R.range(-0.18, 0.18)) * cell, (y + R.range(-0.18, 0.18)) * cell, cell * R.range(0.22, 0.36), R.range(0.8, 0.95));
        }
    }
    // Камешки, веточки, листья — редко и не в воде
    for (let i = 0; i < cols * rows * 0.25; i++) {
        const gx = R.range(0, cols), gy = R.range(0, rows);
        if (wet(gx, gy)) continue;
        const x = gx * cell, y = gy * cell;
        if (small.length) { const sz = cell * R.range(0.16, 0.28); shade(x, y, sz * 0.55, 0.3); stamp(R.pick(small), x, y, sz, 0.9); continue; }
        if (R() < 0.6) { ctx.fillStyle = 'rgba(62,44,26,0.7)'; ctx.beginPath(); ctx.ellipse(x, y, cell * 0.05 + 1, cell * 0.04 + 1, R.range(0, 3), 0, 6.28); ctx.fill(); ctx.fillStyle = '#a49f92'; ctx.beginPath(); ctx.ellipse(x, y, cell * 0.05, cell * 0.04, R.range(0, 3), 0, 6.28); ctx.fill(); }
        else { const a = R.range(0, 6.28), l = cell * R.range(0.12, 0.25); ctx.strokeStyle = 'rgba(70,50,30,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.lineTo(x + Math.cos(a + 0.6) * l * 1.3, y + Math.sin(a + 0.6) * l * 1.3); ctx.stroke(); }
    }
}

// ---------- Настроения: перекраска всей картинки и свои пятна

/**
 * Порча Пожирателя в земле: маска наползает от кромок рваным краем (шум), внутри — земля темнеет и холодеет, а
 * картинки гнили ложатся умножением и обрезаются маской — гниль впитывается в землю, а не лежит наклейкой.
 * Возвращает маску (для подкраски предметов в grade).
 */
function rotGround(ctx, { W, H, cell, seed, art }) {
    const n = makeNoise(`rot|${seed}`), R = rng(`rotg|${seed}`);
    const mw = Math.ceil(W / 8), mh = Math.ceil(H / 8);
    const mask = document.createElement('canvas'); mask.width = mw; mask.height = mh;
    const m = mask.getContext('2d'), img = m.createImageData(mw, mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
        const ex = Math.min(x, mw - x) / mw, ey = Math.min(y, mh - y) / mh, edge = Math.min(ex, ey);
        const v = n((x * 8) / cell * 0.3, (y * 8) / cell * 0.3, 4) - edge * 1.5;
        const a = Math.max(0, Math.min(1, (v - 0.06) * 3.2));
        const o = (y * mw + x) * 4; img.data[o + 3] = a * 255;
    }
    m.putImageData(img, 0, 0);
    const layer = document.createElement('canvas'); layer.width = W; layer.height = H;
    const l = layer.getContext('2d');
    // Тьма с холодом
    l.fillStyle = '#8aa8a0'; l.fillRect(0, 0, W, H);
    // Гниль: много копий, повёрнутых и разной величины — сплошной рисунок без видимых краёв картинок
    const rot = Object.keys(art).filter(k => k.startsWith('rot-')).map(k => art[k]);
    for (let i = 0; rot.length && i < (W * H) / (cell * cell * 5); i++) {
        const x = R.range(0, W), y = R.range(0, H), im = R.pick(rot), sz = cell * R.range(1.6, 3.4), k = sz / Math.max(im.width, im.height);
        l.save(); l.translate(x, y); l.rotate(R.range(0, 6.28)); l.globalAlpha = R.range(0.55, 0.95);
        l.drawImage(im, (-im.width * k) / 2, (-im.height * k) / 2, im.width * k, im.height * k); l.restore();
    }
    l.globalCompositeOperation = 'destination-in'; l.imageSmoothingQuality = 'high'; l.drawImage(mask, 0, 0, W, H);
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.95; ctx.drawImage(layer, 0, 0); ctx.restore();
    // Бирюзовый отсвет по самой кромке порчи — граница «живая»
    const rim = document.createElement('canvas'); rim.width = W; rim.height = H;
    const rr = rim.getContext('2d');
    rr.filter = `blur(${cell * 0.25}px)`; rr.drawImage(mask, 0, 0, W, H); rr.filter = 'none';
    rr.globalCompositeOperation = 'destination-out'; rr.drawImage(mask, 0, 0, W, H);
    rr.globalCompositeOperation = 'source-in'; rr.fillStyle = 'rgba(46,200,190,0.5)'; rr.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.drawImage(rim, 0, 0); ctx.restore();
    return mask;
}

/**
 * Жилы порчи: от краёв вглубь поля ветвятся тёмные прожилки с бирюзовым отсветом — как у съеденных узлов на паутине.
 * Середина поля остаётся чище: жилы слабеют и тоньшают к ней
 */
function rotVeins(ctx, { W, H, cell, seed }) {
    const R = rng(`veins|${seed}`);
    const layer = document.createElement('canvas'); layer.width = W; layer.height = H;
    const l = layer.getContext('2d');
    l.lineCap = 'round'; l.strokeStyle = 'rgba(14,40,38,0.9)';
    const vein = (x, y, angle, width, steps, depth) => {
        for (let i = 0; i < steps && width > 1; i++) {
            angle += R.range(-0.3, 0.3);
            const nx = x + Math.cos(angle) * cell * 0.32, ny = y + Math.sin(angle) * cell * 0.32;
            l.lineWidth = width; l.beginPath(); l.moveTo(x, y); l.lineTo(nx, ny); l.stroke();
            x = nx; y = ny; width *= 0.95;
            if (depth < 2 && R() < 0.12) vein(x, y, angle + R.pick([-1, 1]) * R.range(0.5, 1.1), width * 0.7, Math.round(steps * 0.5), depth + 1);
        }
    };
    const count = Math.round((W + H) / (cell * 2.2));
    for (let i = 0; i < count; i++) {
        // Старт — на кромке, курс — к середине с разбросом
        const side = R.int(0, 3), t = R();
        const [x, y] = [[t * W, 0], [W, t * H], [t * W, H], [0, t * H]][side];
        const angle = Math.atan2(H / 2 - y, W / 2 - x) + R.range(-0.6, 0.6);
        vein(x, y, angle, cell * R.range(0.06, 0.1), R.int(10, 22), 0);
    }
    // Отсвет: размытая копия жил бирюзой поверх, потом сами жилы
    const glow = document.createElement('canvas'); glow.width = W; glow.height = H;
    const g = glow.getContext('2d');
    g.filter = `blur(${cell * 0.08}px)`; g.drawImage(layer, 0, 0); g.filter = 'none';
    g.globalCompositeOperation = 'source-in'; g.fillStyle = 'rgba(46,200,190,0.35)'; g.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.drawImage(glow, 0, 0); ctx.restore();
    ctx.save(); ctx.globalAlpha = 0.85; ctx.drawImage(layer, 0, 0); ctx.restore();
}

function grade(ctx, plan, { W, H, cell, mood, seed, M, art = {}, rotMask = null }) {
    const R = rng(`mood|${mood}|${seed}`);
    const regrade = filter => { const c = document.createElement('canvas'); c.width = W; c.height = H; const l = c.getContext('2d'); l.drawImage(ctx.canvas, 0, 0); ctx.save(); ctx.filter = filter; ctx.drawImage(c, 0, 0); ctx.restore(); };
    const blot = (x, y, r, inner, outer) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, inner); g.addColorStop(1, outer); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.28); ctx.fill(); };
    if (mood === 'night') {
        regrade('brightness(0.8) saturate(0.65)');
        ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = '#8796c4'; ctx.fillRect(0, 0, W, H); ctx.restore();
        // Друзы Тумана светятся и ночью
        for (const o of plan.objects.filter(o => o.kind === 'crystal')) { ctx.save(); ctx.globalCompositeOperation = 'screen'; blot(o.x * cell, o.y * cell, cell * 1.6, 'rgba(46,230,214,0.45)', 'rgba(46,230,214,0)'); ctx.restore(); }
    }
    if (mood === 'fog') {
        regrade('saturate(0.75) brightness(1.05)');
        for (let i = 0; i < 26; i++) blot(R.range(0, W), R.range(0, H), cell * R.range(2, 5), 'rgba(225,230,228,0.32)', 'rgba(225,230,228,0)');
    }
    if (mood === 'rot') {
        // Цвета уходят в мёртвую бирюзу, как у предвестий; внутри порчи и предметы темнеют и холодеют — гниль на них тоже
        regrade('saturate(0.5) brightness(0.97)');
        ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = '#c3ddd7'; ctx.fillRect(0, 0, W, H); ctx.restore();
        if (rotMask) {
            const c = document.createElement('canvas'); c.width = W; c.height = H;
            const l = c.getContext('2d');
            l.fillStyle = 'rgba(40,80,76,0.45)'; l.fillRect(0, 0, W, H);
            l.globalCompositeOperation = 'destination-in'; l.drawImage(rotMask, 0, 0, W, H);
            ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(c, 0, 0); ctx.restore();
        }
    }
}

/**
 * Пробуждение Босса: этаж бледнеет к чёрному и белому — Босс вытягивает из него жизнь, а красное (кровь) остаётся
 * и становится ярче. По ступеням 1–4 цвет уходит ровными шагами, на 4-й — 78% (у зелени и воды остаётся тень
 * цвета); тон — без провала в чёрное и без выжженного белого; края чуть темнее. Макет — tools/mockups/arena-awakening-*
 * Картинка арены остаётся как есть: бледная копия ложится поверх плиткой, чтобы прорыв Пожирателя мог её мягко снять
 * @param {HTMLCanvasElement} source  нарисованная арена
 * @param {number} stage              ступень 1–4
 * @returns {HTMLCanvasElement}       бледная копия
 */
export function awakened(source, stage) {
    const copy = document.createElement('canvas');
    copy.width = source.width; copy.height = source.height;
    const ctx = copy.getContext('2d');
    ctx.drawImage(source, 0, 0);
    awaken(ctx, copy.width, copy.height, stage);
    return copy;
}

const AWAKEN = { paper: [228, 222, 210], ink: [30, 26, 26], contrast: 0.55, lo: 0.08, hi: 0.92, last: 0.78, steps: [0, 0.36, 0.62, 0.82, 1] };
function awaken(ctx, W, H, stage) {
    stage = Math.max(0, Math.min(4, Math.round(stage)));
    if (!stage) return;
    const k = stage / 4, desat = AWAKEN.steps[stage] * AWAKEN.last;
    const lo = AWAKEN.lo * k, span = Math.max(1 - (1 - AWAKEN.hi) * k - lo, 1e-3), con = AWAKEN.contrast * k;
    const [pr, pg, pb] = AWAKEN.paper.map(v => v / 255), [ir, ig, ib] = AWAKEN.ink.map(v => v / 255);
    const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
    const img = ctx.getImageData(0, 0, W, H), d = img.data, cx = W / 2, cy = H / 2;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        let t = clamp01((0.299 * r + 0.587 * g + 0.114 * b - lo) / span);
        t += (t * t * (3 - 2 * t) - t) * con;
        let or = r + (ir + (pr - ir) * t - r) * desat, og = g + (ig + (pg - ig) * t - g) * desat, ob = b + (ib + (pb - ib) * t - b) * desat;
        // Настоящий красный (оттенок около 0°, насыщенный) остаётся и ярче — песок и охра не в счёт
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (r >= mx && r - mn > 0.05) {
            const m = clamp01(1 - Math.abs(g - b) / (r - mn) * 2.5) * clamp01(((mx - mn) / mx - 0.45) * 4) * clamp01(r * 1.8) * Math.min(1, 0.4 + k);
            if (m > 0) { or += (Math.min(1, r * (1 + 0.35 * k)) - or) * m; og += (g * (1 - 0.3 * k) - og) * m; ob += (b * (1 - 0.3 * k) - ob) * m; }
        }
        const x = p % W, y = (p / W) | 0, v = 1 - clamp01(Math.hypot((x - cx) / cx, (y - cy) / cy) - 0.75) * 0.6 * k;
        d[i] = or * v * 255; d[i + 1] = og * v * 255; d[i + 2] = ob * v * 255;
    }
    ctx.putImageData(img, 0, 0);
}
