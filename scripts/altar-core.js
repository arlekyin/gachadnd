/**
 * Gacha Roguelike dnd5e — ядро сознания на Алтаре Памяти
 *
 * В центре — белое ядро, «я» персонажа: живая кромка, внутренние блики, сердцебиение.
 * Вокруг — облако бледных волокон, собственная память. Экипированные навыки — чужие воспоминания:
 * их цветные нити спиралью проходят сквозь облако и крепятся к кромке ядра, подкрашивая её в месте
 * крепления. Яркость и ритм сердцебиения — от оставшихся Костей Хитов; перегрузка (навыков сверх
 * естественного лимита) сжимает облако, гасит свои волокна и делает вращение беспокойным.
 *
 * Ритуалы не перекрашивают ядро, а меняют его поведение:
 *   Слияние     — пряди кольца продолжаются нитями до ядра; нить навыка, принявшего повтор, утолщается;
 *   Переплавка  — ядро и облако раскаляются с каждым воспоминанием в гнезде;
 *   Резонанс    — облако вытягивается к выбранному тегу (пряди к тегу рисует ResonanceWeave);
 *   Расщепление — белая нить медленно окрашивается цветом кристалла, распускается и уходит в туман,
 *                 на её месте из темноты проявляется новая.
 *
 * Экземпляр живёт дольше холста: слой ядра перерисовывается при каждом изменении, а облако
 * продолжает движение на новом холсте (attach). Холст — квадрат вокруг ядра, а не всё окно:
 * очистка и вывод кадра дешевле.
 */

// Размеры в CSS-пикселях: ядро, облако, край облака (там же кончаются пряди кольца — .gd-core)
export const NUCLEUS_R = 26;
const CLOUD = { rMin: 36, rMax: 78 };
const EDGE_R = 88;
const OWN_COUNT = 40;
const SPLIT_PERIOD = 6;
// Отрезков на волокно: каждый — один штрих своей прозрачности и толщины
const CHUNKS = 7, SUB = 5;

const WHITE = [255, 255, 255];
const OWN = [214, 206, 192];
const HOT = [255, 170, 110];
const smooth = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;

function rgb(color) {
    const hex = String(color ?? '').trim().replace('#', '');
    const n = parseInt(hex.length === 3 ? hex.replace(/./g, c => c + c) : hex, 16);
    return Number.isFinite(n) ? [n >> 16, (n >> 8) & 255, n & 255] : [201, 167, 93];
}

function random(seed) {
    let s = seed | 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Волокно облака: дуга на наклонённой плоскости, плоскость медленно вращается — облако в проекции
function makeFiber(rnd) {
    return {
        ax: rnd() * Math.PI * 2, tilt: 0.35 + rnd() * 1.1,
        spin: (rnd() < 0.5 ? -1 : 1) * (0.05 + rnd() * 0.12),
        r: CLOUD.rMin + rnd() * (CLOUD.rMax - CLOUD.rMin),
        start: rnd() * Math.PI * 2, len: 2.2 + rnd() * 2.8,
        wf: 2 + Math.floor(rnd() * 3), ph: rnd() * 6
    };
}

function fiberPoint(f, a, t, scale, wobble) {
    const k = 1 + 0.18 * Math.sin(a * f.wf + f.ph + t * 0.4) + 0.08 * Math.sin(a * (f.wf + 3) - f.ph * 2 + t * 0.7);
    const rr = Math.max(NUCLEUS_R + 6, f.r * k) * scale + wobble;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr * Math.cos(f.tilt), z = Math.sin(a) * rr * Math.sin(f.tilt);
    const rot = f.ax + t * f.spin, c = Math.cos(rot), s = Math.sin(rot);
    return [x * c - y * s, x * s + y * c, z];
}

// Сердцебиение: двойной удар; чем меньше Костей Хитов, тем реже, слабее и неровнее
function heartbeat(t, hd) {
    const period = 1 + (1 - hd) * 0.9;
    const jitter = hd < 0.34 ? Math.sin(t * 1.7) * 0.12 : 0;
    const p = ((t / period) + jitter) % 1;
    const bump = (c, w) => Math.exp(-((p - c) ** 2) / (2 * w * w));
    return bump(0.08, 0.035) + 0.6 * bump(0.24, 0.04);
}

export class MindCore {
    constructor() {
        this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const rnd = random(7);
        this.own = Array.from({ length: OWN_COUNT }, () => makeFiber(rnd));
        this.boosts = new Map();
        this.cycle = null;
        this.running = false;
        this.data = null;
    }

    /**
     * Новый холст после перерисовки слоя ядра.
     * @param {HTMLCanvasElement} canvas
     * @param {HTMLElement} stage
     * @param {object} data  Состояние сознания из модели Алтаря (core в контексте).
     */
    attach(canvas, stage, data) {
        if (data.ritual !== this.data?.ritual) this.since = performance.now();
        if (data.split?.key !== this.data?.split?.key) this.cycleStart = performance.now();
        this.canvas = canvas;
        this.stage = stage;
        this.data = data;
        this.ctx = canvas.getContext('2d');
        this.#resize();
        if (this.reducedMotion) return this.#draw(performance.now());
        this.start();
    }

    /** Слияние: нить навыка, принявшего повтор, утолщается */
    boost(itemId) {
        this.boosts.set(itemId, performance.now());
    }

    start() {
        if (this.running) return;
        this.running = true;
        const loop = time => {
            if (!this.running) return;
            if (this.canvas?.isConnected) this.#draw(time);
            this.frame = requestAnimationFrame(loop);
        };
        this.frame = requestAnimationFrame(loop);
    }

    stop() {
        this.running = false;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = null;
    }

    #resize() {
        const size = this.canvas.offsetWidth || 560;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        this.size = size;
        if (this.canvas.width !== Math.round(size * ratio)) {
            this.canvas.width = this.canvas.height = Math.round(size * ratio);
        }
        this.ratio = ratio;
        // Направления нитей: от центра холста к позициям навыков на кольце — в пикселях окна
        const width = this.stage.clientWidth, height = this.stage.clientHeight;
        const { x: cx, y: cy } = this.data.at;
        this.threads = this.data.threads.map(th => ({
            ...th,
            color: rgb(th.color),
            ang: Math.atan2((th.y - cy) / 100 * height, (th.x - cx) / 100 * width)
        }));
        // Резонанс: направление к выбранному тегу
        const tag = this.data.tagAt;
        this.tagAngle = tag ? Math.atan2((tag.y - cy) / 100 * height, (tag.x - cx) / 100 * width) : null;
    }

    // Штрих волокна по отрезкам: прозрачность и толщина — по середине отрезка (сужение к концам, глубина)
    #stroke(points, colorAt, width, alpha, taper = true) {
        const ctx = this.ctx;
        const n = points.length - 1;
        for (let c = 0; c < CHUNKS; c++) {
            const i0 = Math.floor(c * n / CHUNKS), i1 = Math.floor((c + 1) * n / CHUNKS);
            const mid = (i0 + i1) / 2, u = mid / n;
            const k = taper ? Math.sin(Math.PI * u) ** 0.7 : 1;
            const depth = Math.max(0.25, 0.55 + 0.45 * ((points[Math.round(mid)][2] ?? 0) / 90 + 1) / 2);
            ctx.strokeStyle = rgba(typeof colorAt === 'function' ? colorAt(u) : colorAt, alpha * k * depth);
            ctx.lineWidth = Math.max(0.3, width * k * (0.7 + 0.3 * depth));
            ctx.beginPath();
            ctx.moveTo(points[i0][0], points[i0][1]);
            for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(points[i][0], points[i][1]);
            ctx.stroke();
        }
    }

    #draw(now) {
        const ctx = this.ctx, d = this.data;
        const t = now / 1000;
        const S = this.size, cx = S / 2, cy = S / 2;
        ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
        ctx.clearRect(0, 0, S, S);
        const hd = d.hdMax ? d.hd / d.hdMax : 1;
        const beat = this.reducedMotion ? 0.3 : heartbeat(t, hd);
        const over = d.overload;
        const scale = 1 - over * 0.035;
        const ownDim = Math.max(0.2, 1 - over * 0.16);
        const tt = t * (1 + over * 0.5);
        const heat = d.heat;
        const resonate = this.tagAngle !== null;
        ctx.lineCap = 'round';
        ctx.globalCompositeOperation = 'lighter';

        // Глубинное свечение вокруг ядра
        const hot = mix([255, 236, 214], [255, 160, 90], heat);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 120 + heat * 60);
        g.addColorStop(0, rgba(hot, (0.22 + 0.14 * beat) * (0.4 + 0.6 * hd) + heat * 0.35));
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);

        // Резонанс: облако вытягивается к тегу и дрожит
        const ca = Math.cos(this.tagAngle ?? 0), sa = Math.sin(this.tagAngle ?? 0);
        const stretch = p => {
            if (!resonate) return p;
            const along = p[0] * ca + p[1] * sa, across = -p[0] * sa + p[1] * ca;
            const k = along > 0 ? 1.3 : 1.05;
            return [along * k * ca - across * 0.88 * sa, along * k * sa + across * 0.88 * ca, p[2]];
        };
        const vib = (a, f) => resonate ? Math.sin(a * 23 + t * 40 + f.ph) * 1.1 : 0;

        // Расщепление: нить облака окрашивается цветом кристалла, распускается, на её месте — новая
        let splitSlot = -1, regrowSlot = -1, sp = 0;
        const crystal = d.split ? rgb(d.split.color) : null;
        if (crystal) {
            const elapsed = (now - this.cycleStart) / 1000;
            const cycle = Math.floor(elapsed / SPLIT_PERIOD);
            sp = (elapsed % SPLIT_PERIOD) / SPLIT_PERIOD;
            splitSlot = (cycle * 7) % OWN_COUNT;
            if (cycle > 0) regrowSlot = ((cycle - 1) * 7) % OWN_COUNT;
            if (this.cycle !== cycle && regrowSlot >= 0) this.own[regrowSlot] = makeFiber(random(500 + cycle));
            this.cycle = cycle;
        }

        const ownColor = mix(OWN, HOT, heat * 0.8);
        const steps = CHUNKS * SUB;
        this.own.forEach((f, idx) => {
            const isSplit = idx === splitSlot;
            const unravel = isSplit ? smooth((sp - 0.5) / 0.32) : 0;
            const pts = [];
            for (let k = 0; k <= steps; k++) {
                const u = k / steps;
                const a = f.start + f.len * u * (1 - unravel * 0.7) + tt * 0.15;
                const p = stretch(fiberPoint(f, a, tt, scale * (1 + 0.02 * beat), vib(a, f)));
                let x = cx + p[0], y = cy + p[1];
                if (unravel) {
                    const dir = f.start + tt * 0.15 + f.ax;
                    x += Math.cos(dir) * unravel * 190 * u;
                    y += Math.sin(dir) * unravel * 190 * u;
                }
                pts.push([x, y, p[2]]);
            }
            const color = isSplit && sp > 0.12 ? u => mix(ownColor, crystal, smooth((sp - 0.12) / 0.33 * 1.4 - u * 0.4)) : ownColor;
            const fade = isSplit ? 1 - smooth((sp - 0.62) / 0.3) : idx === regrowSlot ? smooth(sp / 0.4) : 1;
            this.#stroke(pts, color, isSplit ? 2.2 : 1.3, (0.4 + 0.14 * beat) * ownDim * (0.6 + 0.4 * hd) * fade);
        });

        // Нити навыков: от края облака спиралью к кромке ядра
        const attach = [];
        for (const th of this.threads) {
            const since = this.boosts.has(th.id) ? (now - this.boosts.get(th.id)) / 600 : 0;
            const boost = Math.min(1, since);
            const width = 0.8 + th.rank * 0.45 + boost * 1.2;
            attach.push({ ang: th.ang, color: th.color, k: 0.55 + 0.15 * th.rank + boost * 0.3 });
            for (let j = 0; j < 3; j++) {
                const twist = 0.42 + j * 0.1, outR = EDGE_R * scale;
                const pts = [];
                for (let k = 0; k <= steps; k++) {
                    const u = k / steps, e = smooth(u);
                    const r = outR + (NUCLEUS_R - 1 - outR) * e;
                    const th2 = th.ang + twist * e + (j - 1) * 0.08 * (1 - u) + 0.04 * Math.sin(t * 0.8 + j + u * 6);
                    const p = stretch([Math.cos(th2) * r, Math.sin(th2) * r * 0.96, Math.sin(u * Math.PI * 2 + j) * 40]);
                    pts.push([cx + p[0], cy + p[1], p[2]]);
                }
                this.#stroke(pts, u => mix(th.color, WHITE, u * 0.35), width, 0.5 + 0.15 * beat, false);
            }
        }

        this.#nucleus(cx, cy, t, beat, hd, heat, attach);
        ctx.globalCompositeOperation = 'source-over';
    }

    // Ядро: белый диск с живой кромкой; места крепления нитей подкрашены цветом навыка
    #nucleus(cx, cy, t, beat, hd, heat, attach) {
        const ctx = this.ctx, R = NUCLEUS_R;
        ctx.globalCompositeOperation = 'source-over';
        const path = new Path2D();
        for (let k = 0; k <= 72; k++) {
            const a = (k / 72) * Math.PI * 2;
            const r = R * (1 + 0.06 * Math.sin(a * 3 + t * 1.3) + 0.04 * Math.sin(a * 5 - t * 1.9) + 0.03 * Math.sin(a * 8 + t * 2.7) + 0.05 * beat);
            const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
            if (k) path.lineTo(x, y); else path.moveTo(x, y);
        }
        const hot = mix([255, 250, 242], [255, 176, 100], heat);
        const g = ctx.createRadialGradient(cx - 5, cy - 7, 0, cx, cy, R * 1.15);
        g.addColorStop(0, rgba(WHITE, 1));
        g.addColorStop(0.55, rgba(hot, 0.92));
        g.addColorStop(1, rgba(mix(hot, [150, 140, 130], 0.45), 0.85 * (0.6 + 0.4 * hd)));
        ctx.fillStyle = g;
        ctx.fill(path);
        ctx.save();
        ctx.clip(path);
        for (const { ang, color, k } of attach) {
            const x = cx + Math.cos(ang) * R * 1.05, y = cy + Math.sin(ang) * R * 1.05;
            const sg = ctx.createRadialGradient(x, y, 0, x, y, R * 0.42);
            sg.addColorStop(0, rgba(color, 0.6 * k));
            sg.addColorStop(1, rgba(color, 0));
            ctx.fillStyle = sg;
            ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
        }
        // Внутренние блики: ядро — не плоский диск
        for (let k = 0; k < 2; k++) {
            const a = t * (0.7 + k * 0.4) + k * 2;
            const x = cx + Math.cos(a) * 8, y = cy + Math.sin(a * 1.3) * 8;
            const wg = ctx.createRadialGradient(x, y, 0, x, y, 14);
            wg.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
            wg.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = wg;
            ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
        }
        ctx.restore();
        ctx.globalCompositeOperation = 'lighter';
    }
}
