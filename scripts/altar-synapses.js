/**
 * Gacha Roguelike dnd5e — связи кольца Слияния на Алтаре Памяти
 *
 * Навыки в кольце — нейроны. Каждый связан с ядром Алтаря пучком из 3–6 прядей: у тела пряди стянуты,
 * посередине слегка переплетаются, у ядра расходятся и цепляются за его край в разных точках; цвет —
 * от цвета навыка к белому у ядра. Соседи по кольцу связаны воронками: пряди выходят из тела раструбом
 * и сходятся в линию, мягко выгнутую наружу. Ни одна линия не обрывается в пустоту.
 *
 * Неподвижная геометрия рисуется на отдельный холст, только когда сдвинулись узлы (появление кольца,
 * размер окна). В каждом кадре экрана — лишь импульсы, бегущие к ядру и между соседями.
 * Положения берутся из разметки узлов и ядра, поэтому холст всегда совпадает с ней.
 */

import { NUCLEUS_R } from "./altar-core.js";

// Импульсы рисуются в каждом кадре экрана, по его метке времени: неподвижное закэшировано, кадр дешёвый.
// Часы в момент вызова и пропуск кадров давали неровный шаг — импульсы дёргались
const SOMA_R = 18;

const cubic = (p0, p1, p2, p3) => u => {
    const v = 1 - u;
    return [
        v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0],
        v * v * v * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * p3[1]
    ];
};

function rgb(color) {
    const hex = String(color).trim().replace('#', '');
    const n = parseInt(hex.length === 3 ? hex.replace(/./g, c => c + c) : hex, 16) || 0xc9a75d;
    return [n >> 16, (n >> 8) & 255, n & 255];
}
// Цвет навыка, осветлённый к белому на долю k
const toward = (c, k, a) => `rgba(${c.map(v => Math.round(v + (255 - v) * k)).join(', ')}, ${a})`;

// Детерминированные числа: пряди одного навыка всегда лежат одинаково
function random(seedText) {
    let seed = 0;
    for (const char of String(seedText)) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) | 0;
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Точка на ломаной по доле её длины: импульс скользит, а не прыгает по опорным точкам
function alongPolyline(points, lengths, u) {
    const target = u * lengths.at(-1);
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < target) i++;
    const span = lengths[i] - lengths[i - 1] || 1;
    const k = Math.max(0, Math.min(1, (target - lengths[i - 1]) / span));
    return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * k, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * k];
}

// Светящийся импульс; возвращает прямоугольник, который он занял, — его сотрут в следующем кадре
function drawPulse(ctx, x, y, color, r, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255, 255, 255, ${0.8 * alpha})`);
    g.addColorStop(0.35, `rgba(${color.join(', ')}, ${0.6 * alpha})`);
    g.addColorStop(1, `rgba(${color.join(', ')}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    return [x - r - 2, y - r - 2, r * 2 + 4, r * 2 + 4];
}

// Неподвижные нити — на своём холсте под холстом импульсов: в кадре перерисовываются только импульсы
function underlay(canvas) {
    const layer = document.createElement('canvas');
    layer.className = canvas.className;
    layer.setAttribute('aria-hidden', 'true');
    canvas.before(layer);
    return layer;
}

export class AltarSynapses {
    /**
     * @param {HTMLCanvasElement} canvas  холст в слое ядра
     * @param {HTMLElement} stage         слой с ядром и узлами
     */
    constructor(canvas, stage) {
        this.canvas = canvas;
        this.stage = stage;
        this.ctx = canvas.getContext('2d');
        this.layer = underlay(canvas);
        this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        this.flares = new Map();
        this.dirty = [];
        this.stale = true;
        this.running = false;
        this.last = 0;
        // Замер — при появлении и изменении размера, а не каждый кадр: чтение стилей в кадре
        // заставляло браузер пересчитывать всё окно с его анимациями, и импульсы дёргались
        this.resizeObserver = new ResizeObserver(() => { this.stale = true; });
        this.resizeObserver.observe(stage);
    }

    start() {
        if (this.running) return;
        this.running = true;
        const loop = time => {
            if (!this.running) return;
            if (!this.canvas.isConnected) return this.stop();
            this.#frame(time);
            this.frame = requestAnimationFrame(loop);
        };
        this.frame = requestAnimationFrame(loop);
    }

    stop() {
        this.running = false;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.resizeObserver.disconnect();
    }

    /** Слияние: по прядям навыка к ядру уходят яркие импульсы */
    flare(itemId) {
        this.flares.set(itemId, performance.now());
    }

    // Узлы и ядро в координатах холста. Берутся из процентов разметки, а не из рамок: ядро и узлы
    // «дышат» анимацией масштаба, и рамки менялись бы каждый кадр
    #measure() {
        const width = this.stage.clientWidth, height = this.stage.clientHeight;
        const core = this.stage.querySelector('.gd-core');
        if (!core || !width) return null;
        const place = el => ({ x: parseFloat(el.style.left) / 100 * width, y: parseFloat(el.style.top) / 100 * height });
        const nodes = [...this.stage.querySelectorAll('.gd-node')].map(el => ({
            id: el.dataset.itemId, ...place(el), color: rgb(getComputedStyle(el).getPropertyValue('--rarity'))
        }));
        // Кольцо замыкается, только когда навыки заняли все гнёзда: иначе последний и первый разделены пустыми
        const closed = !this.stage.querySelector('.gd-socket');
        return { width, height, core: { ...place(core), r: core.offsetWidth / 2 }, nodes, closed };
    }

    #frame(time) {
        if (this.stale) {
            const scene = this.#measure();
            if (!scene) return;
            this.stale = false;
            this.#resize(scene);
            this.#build(scene);
            this.#paint();
            this.ctx.clearRect(0, 0, this.width, this.height);
            this.dirty = [];
        }
        this.#drawPulses(time);
    }

    #resize({ width, height }) {
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        for (const c of [this.canvas, this.layer]) {
            if (c.width === Math.round(width * ratio) && c.height === Math.round(height * ratio)) continue;
            c.width = Math.round(width * ratio);
            c.height = Math.round(height * ratio);
        }
        for (const c of [this.canvas, this.layer]) c.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
        this.width = width;
        this.height = height;
    }

    // Геометрия: пряди к ядру и связи соседей, у каждой — путь, толщина и цвет вдоль пути
    #build({ core, nodes, closed }) {
        this.paths = [];
        this.pulsePaths = [];
        nodes.forEach((n, i) => {
            const rand = random(`${n.id}:strands`);
            const dir = Math.atan2(core.y - n.y, core.x - n.x);
            const dist = Math.hypot(core.x - n.x, core.y - n.y);
            const nx = -Math.sin(dir), ny = Math.cos(dir);
            const count = 3 + Math.floor(rand() * 4);
            const strands = [];
            for (let k = 0; k < count; k++) {
                const f = k / (count - 1) - 0.5;
                const start = [n.x + Math.cos(dir + f * 1.1) * SOMA_R, n.y + Math.sin(dir + f * 1.1) * SOMA_R];
                const angle = dir + Math.PI + f * 0.85 + (rand() - 0.5) * 0.12;
                const end = [core.x + Math.cos(angle) * core.r, core.y + Math.sin(angle) * core.r];
                const twist = (rand() - 0.5) * 14;
                const c1 = [n.x + Math.cos(dir) * dist * 0.3 + nx * f * 4, n.y + Math.sin(dir) * dist * 0.3 + ny * f * 4];
                const c2 = [n.x + Math.cos(dir) * dist * 0.62 + nx * (twist - f * 10), n.y + Math.sin(dir) * dist * 0.62 + ny * (twist - f * 10)];
                const at = cubic(start, c1, c2, end);
                strands.push(at);
                this.paths.push({
                    at, steps: 26,
                    width: u => 1.3 + 1.1 * Math.abs(u - 0.45) * 2,
                    color: u => toward(n.color, Math.min(1, u * 1.15) ** 1.3, 0.42 + u * 0.25)
                });
            }
            this.pulsePaths.push({ id: n.id, color: n.color, strands, phase: rand() * 10 });

            // Соседи по кольцу: воронка — линия, выгнутая наружу, — воронка
            const last = i === nodes.length - 1;
            if (nodes.length < 2 || (last && (!closed || nodes.length < 3))) return;
            const m = nodes[(i + 1) % nodes.length];
            const d2 = Math.atan2(m.y - n.y, m.x - n.x);
            const gap = Math.hypot(m.x - n.x, m.y - n.y);
            const fl = Math.min(46, gap * 0.2);
            const tipA = this.#funnel(n.x, n.y, d2, fl, n.color);
            const tipB = this.#funnel(m.x, m.y, d2 + Math.PI, fl, m.color);
            const lx = tipB[0] - tipA[0], ly = tipB[1] - tipA[1], ll = Math.hypot(lx, ly) || 1;
            const px = -ly / ll, py = lx / ll;
            const outward = Math.sign((tipA[0] + lx / 2 - core.x) * px + (tipA[1] + ly / 2 - core.y) * py) || 1;
            const phase = rand() * 6;
            const line = u => {
                const bend = Math.sin(u * Math.PI) * 10 * outward + Math.sin(u * Math.PI * 3 + phase) * 2.2 * Math.sin(u * Math.PI);
                return [tipA[0] + lx * u + px * bend, tipA[1] + ly * u + py * bend];
            };
            this.paths.push({
                at: line, steps: 28,
                width: u => 1.5 + 0.7 * Math.sin(u * Math.PI * 2 + phase) * Math.sin(u * Math.PI),
                color: u => `rgba(${n.color.map((v, j) => Math.round(v * (1 - u) + m.color[j] * u)).join(', ')}, 0.5)`
            });
            this.pulsePaths.push({ ring: true, color: [207, 238, 228], strands: [line], phase });
        });
    }

    // Воронка: пряди от края тела сходятся в точку на оси, вогнутые, как раструб
    #funnel(x, y, dir, len, color) {
        const tip = [x + Math.cos(dir) * len, y + Math.sin(dir) * len];
        for (let k = 0; k < 5; k++) {
            const spread = (k / 4 - 0.5) * 1.9;
            const start = [x + Math.cos(dir + spread) * SOMA_R, y + Math.sin(dir + spread) * SOMA_R];
            const c1 = [x + Math.cos(dir + spread * 0.35) * len * 0.45, y + Math.sin(dir + spread * 0.35) * len * 0.45];
            const c2 = [tip[0] - Math.cos(dir) * len * 0.25, tip[1] - Math.sin(dir) * len * 0.25];
            this.paths.push({ at: cubic(start, c1, c2, tip), steps: 14, width: u => 2.4 - u * 0.9, color: () => toward(color, 0.15, 0.5) });
        }
        return tip;
    }

    #paint() {
        const ctx = this.layer.getContext('2d');
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.lineCap = 'round';
        for (const path of this.paths) {
            for (let j = 0; j < path.steps; j++) {
                const u0 = j / path.steps, u1 = (j + 1) / path.steps;
                const [x0, y0] = path.at(u0), [x1, y1] = path.at(u1);
                ctx.strokeStyle = path.color(u0);
                ctx.lineWidth = path.width(u0);
                ctx.beginPath();
                ctx.moveTo(x0, y0);
                ctx.lineTo(x1, y1);
                ctx.stroke();
            }
        }
    }

    #drawPulses(time) {
        const ctx = this.ctx;
        for (const [x, y, w, h] of this.dirty) ctx.clearRect(x, y, w, h);
        this.dirty = [];
        if (this.reducedMotion) return;
        const now = time, clock = time;
        const pulse = (at, u, color, r, alpha) => {
            const [x, y] = at(u);
            this.dirty.push(drawPulse(ctx, x, y, color, r, alpha));
        };
        ctx.globalCompositeOperation = 'lighter';
        this.pulsePaths.forEach((p, i) => {
            const fade = u => Math.min(1, u / 0.1, (1 - u) / 0.1);
            if (p.ring) {
                const u = ((now / 1000) * 0.08 + p.phase) % 1;
                return pulse(p.strands[0], u, p.color, 3.5, fade(u) * 0.55);
            }
            for (let k = 0; k < 2; k++) {
                const u = ((now / 1000) * 0.16 + p.phase + k * 0.5) % 1;
                pulse(p.strands[(k * 2 + i) % p.strands.length], u, p.color, 4.5, fade(u) * 0.75);
            }
            // Слияние: яркая волна по всем прядям к ядру, около 1,6 секунды
            const since = this.flares.has(p.id) ? (clock - this.flares.get(p.id)) / 1600 : 1;
            if (since < 1) p.strands.forEach(at => pulse(at, since, [255, 255, 255], 8, 1 - since * 0.6));
            else this.flares.delete(p.id);
        });
        ctx.globalCompositeOperation = 'source-over';
    }
}

/**
 * Резонанс: пряди от ядра обвивают выбранный тег колеса.
 * Пучок из пяти прядей выходит из края ядра, стягивается на середине пути, у тега расходится
 * и обвивает его, каждая прядь — по своей дуге. При выборе другого тега пряди втягиваются в ядро
 * и прорастают к новому. Экземпляр живёт дольше холста: слой ядра перерисовывается при смене тега,
 * и пряди продолжают движение на новом холсте (attach).
 */
export class ResonanceWeave {
    constructor() {
        this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        this.grow = 0;          // доля прорастания: 0 — в ядре, 1 — тег обвит
        this.painted = -1;      // доля, с которой нити нарисованы на нижнем холсте
        this.target = null;     // тег, к которому растут пряди
        this.wanted = null;     // выбранный тег
        this.dirty = [];
        this.running = false;
        this.last = 0;
        this.resizeObserver = new ResizeObserver(() => { this.stale = true; });
    }

    /** Новый холст слоя ядра и выбранный тег */
    attach(canvas, stage, tag) {
        this.canvas = canvas;
        this.layer = underlay(canvas);
        this.stage = stage;
        this.ctx = canvas.getContext('2d');
        this.wanted = tag;
        this.stale = true;
        this.dirty = [];
        this.resizeObserver.disconnect();
        this.resizeObserver.observe(stage);
        if (this.target === null) this.target = tag;
        if (this.reducedMotion) { this.target = tag; this.grow = 1; }
        this.start();
    }

    start() {
        if (this.running) return;
        this.running = true;
        const loop = time => {
            if (!this.running) return;
            if (this.canvas?.isConnected) {
                const dt = Math.min(0.1, (time - (this.last || time)) / 1000);
                this.last = time;
                this.#step(dt);
                this.#draw(time);
            }
            this.frame = requestAnimationFrame(loop);
        };
        this.frame = requestAnimationFrame(loop);
    }

    stop() {
        this.running = false;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.resizeObserver.disconnect();
    }

    // Втягивание к ядру быстрее, прорастание — мягче
    #step(dt) {
        if (this.target !== this.wanted) {
            this.grow = Math.max(0, this.grow - dt / 0.35);
            if (this.grow === 0) { this.target = this.wanted; this.stale = true; }
        } else {
            this.grow = Math.min(1, this.grow + dt / 0.7);
        }
    }

    #measure() {
        const width = this.stage.clientWidth, height = this.stage.clientHeight;
        const core = this.stage.querySelector('.gd-core');
        const tag = [...this.stage.querySelectorAll('.gd-wheel-tag')].find(el => el.dataset.tag === this.target);
        if (!core || !tag || !width) return null;
        const place = el => ({ x: parseFloat(el.style.left) / 100 * width, y: parseFloat(el.style.top) / 100 * height });
        const glow = getComputedStyle(this.stage).getPropertyValue('--glow') || '#b066ff';
        return { width, height, core: { ...place(core), r: core.offsetWidth / 2 }, tag: { ...place(tag), w: tag.offsetWidth, h: tag.offsetHeight }, color: rgb(glow) };
    }

    // Пряди как ломаные: пучок от ядра к тегу, затем дуга вокруг тега
    #build(scene) {
        const { core, tag } = scene;
        const rand = random(`weave:${this.target}`);
        const dir = Math.atan2(tag.y - core.y, tag.x - core.x);
        const dist = Math.hypot(tag.x - core.x, tag.y - core.y);
        const nx = -Math.sin(dir), ny = Math.cos(dir);
        const rx = tag.w / 2 + 7, ry = tag.h / 2 + 6;
        this.color = scene.color;
        this.strands = [];
        for (let k = 0; k < 5; k++) {
            const f = k / 4 - 0.5;
            const startA = dir + f * 0.9;
            // Пряди выходят из кромки белого ядра, а не из края облака
            const start = [core.x + Math.cos(startA) * NUCLEUS_R, core.y + Math.sin(startA) * NUCLEUS_R];
            // Вход на овал вокруг тега — со стороны ядра, пряди расходятся веером
            const entryA = dir + Math.PI + f * 1.4;
            const entry = [tag.x + Math.cos(entryA) * rx, tag.y + Math.sin(entryA) * ry];
            const c1 = [core.x + Math.cos(dir) * dist * 0.35 + nx * f * 10, core.y + Math.sin(dir) * dist * 0.35 + ny * f * 10];
            const c2 = [core.x + Math.cos(dir) * dist * 0.6 + nx * f * 4, core.y + Math.sin(dir) * dist * 0.6 + ny * f * 4];
            const reach = cubic(start, c1, c2, entry);
            const points = [];
            for (let i = 0; i <= 24; i++) points.push(reach(i / 24));
            // Обвивка: дуга по овалу, направление чередуется, размах от 150° до 260°
            const sweep = (k % 2 ? 1 : -1) * (2.6 + rand() * 1.9);
            const wobble = 1 + (rand() - 0.5) * 0.25;
            for (let i = 1; i <= 26; i++) {
                const a = entryA + sweep * i / 26;
                const swell = 1 + Math.sin(i / 26 * Math.PI) * 0.12 * wobble;
                points.push([tag.x + Math.cos(a) * rx * swell, tag.y + Math.sin(a) * ry * swell]);
            }
            const lengths = [0];
            for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
            this.strands.push({ points, lengths, total: lengths.at(-1), split: 24, phase: rand() });
        }
    }

    // Нити на нижнем холсте — только когда меняется доля прорастания или геометрия
    #paintStrands() {
        const ctx = this.layer.getContext('2d');
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.lineCap = 'round';
        const ease = this.grow * this.grow * (3 - 2 * this.grow);
        for (const s of this.strands) {
            const limit = s.total * ease;
            for (let i = 1; i < s.points.length && s.lengths[i - 1] < limit; i++) {
                const u = s.lengths[i] / s.total;
                const [x0, y0] = s.points[i - 1];
                let [x1, y1] = s.points[i];
                if (s.lengths[i] > limit) {
                    const k = (limit - s.lengths[i - 1]) / (s.lengths[i] - s.lengths[i - 1]);
                    x1 = x0 + (x1 - x0) * k; y1 = y0 + (y1 - y0) * k;
                }
                // Толще у ядра и на обвивке, тоньше посередине; цвет ритуала светлеет к тегу
                const mid = i <= s.split ? Math.abs(i / s.split - 0.45) * 2 : 1;
                ctx.lineWidth = 1.1 + 0.9 * mid;
                ctx.strokeStyle = toward(this.color, Math.min(1, u * 0.9), 0.5 + u * 0.35);
                ctx.beginPath();
                ctx.moveTo(x0, y0);
                ctx.lineTo(x1, y1);
                ctx.stroke();
            }
        }
        this.painted = this.grow;
    }

    #draw(time) {
        if (this.stale) {
            const scene = this.#measure();
            if (!scene) return;
            this.stale = false;
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            for (const c of [this.canvas, this.layer]) {
                c.width = Math.round(scene.width * ratio);
                c.height = Math.round(scene.height * ratio);
                c.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
            }
            this.width = scene.width;
            this.height = scene.height;
            this.#build(scene);
            this.painted = -1;
            this.dirty = [];
        }
        if (this.painted !== this.grow) this.#paintStrands();

        // Импульсы: стирается только то, что они заняли в прошлом кадре
        const ctx = this.ctx;
        for (const [x, y, w, h] of this.dirty) ctx.clearRect(x, y, w, h);
        this.dirty = [];
        if (this.reducedMotion || this.grow < 1) return;
        const now = time / 1000;
        ctx.globalCompositeOperation = 'lighter';
        this.strands.forEach((s, k) => {
            if (k % 2) return;
            const u = (now * 0.35 + s.phase) % 1;
            const reach = s.points.slice(0, s.split + 1), lengths = s.lengths.slice(0, s.split + 1);
            const [x, y] = alongPolyline(reach, lengths, u);
            this.dirty.push(drawPulse(ctx, x, y, this.color, 5, Math.min(1, u / 0.1, (1 - u) / 0.1)));
        });
        ctx.globalCompositeOperation = 'source-over';
    }
}
