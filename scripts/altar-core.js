/**
 * Gacha Roguelike dnd5e — ядро сознания на Алтаре Памяти
 *
 * В центре — белое ядро, «я» персонажа: живая кромка, внутренние блики, сердцебиение.
 * Вокруг — облако бледных волокон, собственная память. Экипированные навыки — чужие воспоминания:
 * их цветные нити кружат кольцами вокруг ядра вместе с облаком и одним концом крепятся к кромке
 * ядра с той стороны, где навык стоит на кольце, подкрашивая её в месте крепления. Яркость и ритм сердцебиения — от оставшихся Костей Хитов; перегрузка (навыков сверх
 * естественного лимита) сжимает облако, гасит свои волокна и делает вращение беспокойным.
 *
 * Ритуалы не перекрашивают ядро, а меняют его поведение:
 *   Слияние     — навыки стоят на кольце, их пряди тянутся до ядра (AltarSynapses), в облаке их нитей нет;
 *                 при уходе со Слияния навыки перетекают в кольца вокруг ядра, при возврате — обратно;
 *                 нить навыка, принявшего повтор, утолщается;
 *   Переплавка  — ядро и облако раскаляются с каждым воспоминанием в гнезде;
 *   Резонанс    — облако не меняется, к тегу тянутся только пряди от ядра (ResonanceWeave);
 *   Расщепление — в простое отрывается любая нить, своя или навыка, в своём цвете; кристалл в фокусе
 *                 сперва окрашивает собственную нить в свой цвет. Нить распускается и уходит в туман,
 *                 на её месте из темноты проявляется новая.
 *
 * Экземпляр живёт дольше холста: слой ядра перерисовывается при каждом изменении, а облако
 * продолжает движение на новом холсте (attach). Холст — квадрат вокруг ядра, а не всё окно:
 * очистка и вывод кадра дешевле.
 */

import { RendererHost } from "./altar-offscreen.js";

// Размеры в CSS-пикселях: ядро (к его кромке тянутся пряди кольца и Резонанса) и облако
export const NUCLEUS_R = 40;
const CLOUD = { rMin: 54, rMax: 118 };
const OWN_COUNT = 44;
const SPLIT_PERIOD = 4;
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
function makeFiber(rnd, len = [2.2, 5]) {
    return {
        ax: rnd() * Math.PI * 2, tilt: 0.35 + rnd() * 1.1,
        spin: (rnd() < 0.5 ? -1 : 1) * (0.05 + rnd() * 0.12),
        r: CLOUD.rMin + rnd() * (CLOUD.rMax - CLOUD.rMin),
        start: rnd() * Math.PI * 2, len: len[0] + rnd() * (len[1] - len[0]),
        wf: 2 + Math.floor(rnd() * 3), ph: rnd() * 6
    };
}
const hash = text => { let h = 0; for (const ch of String(text)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0; return h; };

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

/**
 * Рисовальщик ядра: без DOM, работает и в основном потоке, и в рабочем (OffscreenCanvas).
 * Размеры холста и поля Алтаря приходят снаружи — метрики меряет основной поток.
 */
export class MindRenderer {
    constructor({ reducedMotion = false } = {}) {
        this.reducedMotion = reducedMotion;
        const rnd = random(7);
        this.own = Array.from({ length: OWN_COUNT }, () => makeFiber(rnd));
        this.boosts = new Map();
        // Кольца нитей навыка: по три на навык, форма постоянна для навыка
        this.rings = new Map();
        this.cycle = null;
        this.running = false;
        this.data = null;
    }

    /**
     * Новый холст после перерисовки слоя ядра.
     * @param {HTMLCanvasElement|OffscreenCanvas} canvas
     * @param {{ size: number, ratio: number, stageWidth: number, stageHeight: number }} metrics
     * @param {object} data  Состояние сознания из модели Алтаря (core в контексте).
     */
    attach(canvas, metrics, data) {
        // Слияние: навыки стоят на кольце, в облаке их нитей нет. Остальные ритуалы: навыки перетекают
        // в кольца вокруг ядра. При первом показе — сразу в нужном состоянии, без перетекания
        this.wovenTarget = data.ritual === 'merge' ? 0 : 1;
        if (!this.data || this.reducedMotion) this.woven = this.wovenTarget;
        if (data.ritual !== this.data?.ritual || data.split?.key !== this.data?.split?.key) this.cycleStart = performance.now();
        this.canvas = canvas;
        this.data = data;
        this.ctx = canvas.getContext('2d');
        this.#resize(metrics);
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
        const next = globalThis.requestAnimationFrame ?? (cb => setTimeout(() => cb(performance.now()), 16));
        const loop = time => {
            if (!this.running) return;
            if (this.canvas) this.#draw(time);
            this.frame = next(loop);
        };
        this.frame = next(loop);
    }

    stop() {
        this.running = false;
        if (this.frame) (globalThis.cancelAnimationFrame ?? clearTimeout)(this.frame);
        this.frame = null;
    }

    #resize({ size, ratio, stageWidth: width, stageHeight: height }) {
        this.size = size;
        if (this.canvas.width !== Math.round(size * ratio)) {
            this.canvas.width = this.canvas.height = Math.round(size * ratio);
        }
        this.ratio = ratio;
        // Направления нитей: от центра холста к позициям навыков на кольце — в пикселях окна
        const { x: cx, y: cy } = this.data.at;
        this.threads = this.data.threads.map(th => ({
            ...th,
            color: rgb(th.color),
            px: (th.x - cx) / 100 * width, py: (th.y - cy) / 100 * height,
            ang: Math.atan2((th.y - cy) / 100 * height, (th.x - cx) / 100 * width)
        }));
        for (const th of this.threads) {
            if (this.rings.has(th.id)) continue;
            const rnd = random(hash(th.id));
            this.rings.set(th.id, Array.from({ length: 3 }, () => makeFiber(rnd, [3, 4.6])));
        }
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
        ctx.lineCap = 'round';
        ctx.globalCompositeOperation = 'lighter';

        // Глубинное свечение вокруг ядра
        const hot = mix([255, 236, 214], [255, 160, 90], heat);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 170 + heat * 80);
        g.addColorStop(0, rgba(hot, (0.22 + 0.14 * beat) * (0.4 + 0.6 * hd) + heat * 0.35));
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);


        // Перетекание навыков между кольцом Слияния и облаком: около секунды
        const dt = Math.min(0.1, (now - (this.last ?? now)) / 1000);
        this.last = now;
        const dir = Math.sign(this.wovenTarget - this.woven);
        this.woven = dir > 0 ? Math.min(1, this.woven + dt / 1.1) : Math.max(0, this.woven - dt / 1.1);
        const w = this.woven;

        // Расщепление: в простое отрывается любая нить — своя или нить навыка — в своём цвете;
        // кристалл в фокусе сперва окрашивает собственную нить в свой цвет. На месте ушедшей — новая
        let split = null, regrow = null, sp = 0;
        const crystal = d.split ? rgb(d.split.color) : null;
        if (d.ritual === 'split') {
            const elapsed = (now - this.cycleStart) / 1000;
            const cycle = Math.floor(elapsed / SPLIT_PERIOD);
            sp = (elapsed % SPLIT_PERIOD) / SPLIT_PERIOD;
            const pick = c => {
                const total = OWN_COUNT + (crystal || w < 1 ? 0 : this.threads.length * 3);
                const i = Math.floor(random(9000 + c)() * total);
                return i < OWN_COUNT ? { own: i } : { id: this.threads[Math.floor((i - OWN_COUNT) / 3)].id, j: (i - OWN_COUNT) % 3 };
            };
            split = pick(cycle);
            if (cycle > 0) regrow = pick(cycle - 1);
            if (this.cycle !== cycle && regrow) {
                if (regrow.own !== undefined) this.own[regrow.own] = makeFiber(random(500 + cycle));
                else if (this.rings.has(regrow.id)) this.rings.get(regrow.id)[regrow.j] = makeFiber(random(700 + cycle), [3, 4.6]);
            }
            this.cycle = cycle;
        }
        const unravel = sp ? smooth((sp - 0.42) / 0.38) : 0;
        const leaving = 1 - smooth((sp - 0.6) / 0.32);
        const arriving = smooth(sp / 0.4);
        // Отрыв: нить целиком уходит наружу, дальний конец — быстрее, и распрямляется
        const drift = (pt, f, u) => {
            const a = f.start + tt * 0.15 + f.ax;
            pt[0] += Math.cos(a) * unravel * (70 + 230 * u);
            pt[1] += Math.sin(a) * unravel * (70 + 230 * u);
        };

        const ownColor = mix(OWN, HOT, heat * 0.8);
        const steps = CHUNKS * SUB;
        const base = (0.4 + 0.14 * beat) * ownDim * (0.6 + 0.4 * hd);
        this.own.forEach((f, idx) => {
            const isSplit = split?.own === idx;
            const pts = [];
            for (let k = 0; k <= steps; k++) {
                const u = k / steps;
                const a = f.start + f.len * u * (1 - (isSplit ? unravel : 0) * 0.7) + tt * 0.15;
                const p = fiberPoint(f, a, tt, scale * (1 + 0.02 * beat), 0);
                const pt = [cx + p[0], cy + p[1], p[2]];
                if (isSplit) drift(pt, f, u);
                pts.push(pt);
            }
            if (!isSplit) return this.#stroke(pts, ownColor, 1.3, base * (regrow?.own === idx ? arriving : 1));
            // Кристалл окрашивает нить вдоль; без кристалла нить лишь светлеет перед отрывом
            const dye = smooth((sp - 0.06) / 0.34);
            const color = crystal ? u => mix(ownColor, crystal, smooth(dye * 1.5 - u * 0.5)) : ownColor;
            this.#stroke(pts, color, 1.3 + dye * (crystal ? 1.8 : 0.9), (base + dye * (1 - base) * (crystal ? 1 : 0.6)) * leaving);
            if (crystal) this.#stroke(pts, mix(crystal, WHITE, 0.6), 0.6 + dye * 0.6, dye * 0.5 * leaving);
        });

        // Нити навыков: кольца вокруг ядра, кружат вместе с облаком; конец крепится к кромке ядра
        // с той стороны, где навык стоит на кольце. При перетекании нить тянется из места навыка
        // на кольце Слияния: первым приходит конец у ядра, хвост покидает место навыка последним
        const attach = [];
        for (const th of this.threads) {
            if (w <= 0) break;
            const since = this.boosts.has(th.id) ? (now - this.boosts.get(th.id)) / 600 : 0;
            const boost = Math.min(1, since);
            const width = 0.9 + th.rank * 0.5 + boost * 1.2;
            attach.push({ ang: th.ang, color: th.color, k: (0.55 + 0.15 * th.rank + boost * 0.3) * smooth(w * 1.4 - 0.4) });
            const nx = cx + th.px, ny = cy + th.py;
            this.rings.get(th.id)?.forEach((f, j) => {
                const isSplit = split?.id === th.id && split.j === j;
                const anchor = th.ang + (j - 1) * 0.16;
                const ax = cx + Math.cos(anchor) * (NUCLEUS_R - 2), ay = cy + Math.sin(anchor) * (NUCLEUS_R - 2);
                const pts = [];
                for (let k = 0; k <= steps; k++) {
                    const u = k / steps;
                    const a = f.start + f.len * u * (1 - (isSplit ? unravel : 0) * 0.7) + tt * 0.15;
                    const p = fiberPoint(f, a, tt, scale * (1 - boost * 0.08), 0);
                    let x = cx + p[0], y = cy + p[1];
                    // Последняя пятая часть нити сходит с кольца к месту крепления на ядре
                    const e = isSplit ? smooth((u - 0.78) / 0.22) * (1 - unravel) : smooth((u - 0.78) / 0.22);
                    x += (ax - x) * e; y += (ay - y) * e;
                    const pt = [x, y, p[2] * (1 - e)];
                    if (isSplit) drift(pt, f, u);
                    if (w < 1) {
                        const flow = smooth(w * 1.6 - (1 - u) * 0.6);
                        pt[0] = nx + (pt[0] - nx) * flow;
                        pt[1] = ny + (pt[1] - ny) * flow;
                    }
                    pts.push(pt);
                }
                const fade = isSplit ? leaving : regrow?.id === th.id && regrow.j === j ? arriving : 1;
                this.#stroke(pts, u => mix(th.color, WHITE, Math.max(0, u - 0.6) * 0.8), width, (0.62 + 0.15 * beat) * fade);
            });
            // Уходя со Слияния, навык исчезает с кольца сразу — на его месте гаснет сгусток, из которого
            // вытекают нити
            if (this.wovenTarget === 1 && w < 1) {
                const r = 18 * (1 - w) + 4;
                const blob = ctx.createRadialGradient(nx, ny, 0, nx, ny, r);
                blob.addColorStop(0, rgba(mix(th.color, WHITE, 0.5), 0.9 * (1 - w)));
                blob.addColorStop(1, rgba(th.color, 0));
                ctx.fillStyle = blob;
                ctx.beginPath(); ctx.arc(nx, ny, r, 0, Math.PI * 2); ctx.fill();
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
        const g = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.27, 0, cx, cy, R * 1.15);
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
            const x = cx + Math.cos(a) * R * 0.3, y = cy + Math.sin(a * 1.3) * R * 0.3;
            const wg = ctx.createRadialGradient(x, y, 0, x, y, R * 0.55);
            wg.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
            wg.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = wg;
            ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
        }
        ctx.restore();
        ctx.globalCompositeOperation = 'lighter';
    }
}

/**
 * Ядро сознания для Алтаря: рисовальщик живёт в рабочем потоке (RendererHost), основной поток только
 * меряет холст и поле. Без поддержки OffscreenCanvas — тот же рисовальщик в основном потоке.
 */
export class MindCore {
    #host = null;

    attach(canvas, stage, data) {
        this.#host ??= new RendererHost('mind', MindRenderer);
        const metrics = {
            size: canvas.offsetWidth || 900,
            ratio: Math.min(globalThis.devicePixelRatio || 1, 2),
            stageWidth: stage.clientWidth, stageHeight: stage.clientHeight
        };
        this.#host.call('attach', canvas, metrics, data);
    }

    /** Слияние: нить навыка, принявшего повтор, утолщается */
    boost(itemId) {
        this.#host?.call('boost', itemId);
    }

    // Окно закрыто: рабочий поток завершается, при новом холсте поднимется заново
    stop() {
        this.#host?.dispose();
        this.#host = null;
    }
}
