/**
 * Gacha Roguelike dnd5e — связи кольца Слияния на Алтаре Памяти
 *
 * Навыки в кольце — нейроны. Каждый связан с ядром Алтаря пучком из 3–6 прядей: у тела пряди стянуты,
 * посередине слегка переплетаются, у ядра расходятся и цепляются за его край в разных точках; цвет —
 * от цвета навыка к белому у ядра. Соседи по кольцу связаны воронками: пряди выходят из тела раструбом
 * и сходятся в линию, мягко выгнутую наружу. Ни одна линия не обрывается в пустоту.
 *
 * Неподвижная геометрия рисуется на отдельный холст, только когда сдвинулись узлы (появление кольца,
 * размер окна). В каждом кадре (~30 в секунду) — лишь импульсы, бегущие к ядру и между соседями.
 * Положения берутся из разметки узлов и ядра, поэтому холст всегда совпадает с ней.
 */

const FRAME_MS = 33;
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

export class AltarSynapses {
    /**
     * @param {HTMLCanvasElement} canvas  холст в слое ядра
     * @param {HTMLElement} stage         слой с ядром и узлами
     */
    constructor(canvas, stage) {
        this.canvas = canvas;
        this.stage = stage;
        this.ctx = canvas.getContext('2d');
        this.layer = document.createElement('canvas');
        this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        this.flares = new Map();
        this.signature = '';
        this.running = false;
        this.last = 0;
    }

    start() {
        if (this.running) return;
        this.running = true;
        const loop = time => {
            if (!this.running) return;
            if (!this.canvas.isConnected) return this.stop();
            if (time - this.last >= FRAME_MS) {
                this.last = time;
                this.#frame();
            }
            this.frame = requestAnimationFrame(loop);
        };
        this.frame = requestAnimationFrame(loop);
    }

    stop() {
        this.running = false;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = null;
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

    #frame() {
        const scene = this.#measure();
        if (!scene) return;
        const signature = [scene.width, scene.height, scene.core.x, scene.core.y, scene.closed, ...scene.nodes.flatMap(n => [n.id, n.x, n.y])]
            .map(v => typeof v === 'number' ? v.toFixed(1) : v).join('|');
        if (signature !== this.signature) {
            this.signature = signature;
            this.#resize(scene);
            this.#build(scene);
            this.#paint();
        }
        this.#drawPulses();
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

    #pulse(at, u, color, r, alpha) {
        const ctx = this.ctx;
        const [x, y] = at(u);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255, 255, 255, ${0.8 * alpha})`);
        g.addColorStop(0.35, `rgba(${color.join(', ')}, ${0.6 * alpha})`);
        g.addColorStop(1, `rgba(${color.join(', ')}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    #drawPulses() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.drawImage(this.layer, 0, 0, this.width, this.height);
        if (this.reducedMotion) return;
        const now = Date.now(), clock = performance.now();
        ctx.globalCompositeOperation = 'lighter';
        this.pulsePaths.forEach((p, i) => {
            const fade = u => Math.min(1, u / 0.1, (1 - u) / 0.1);
            if (p.ring) {
                const u = ((now / 1000) * 0.08 + p.phase) % 1;
                return this.#pulse(p.strands[0], u, p.color, 3.5, fade(u) * 0.55);
            }
            for (let k = 0; k < 2; k++) {
                const u = ((now / 1000) * 0.16 + p.phase + k * 0.5) % 1;
                this.#pulse(p.strands[(k * 2 + i) % p.strands.length], u, p.color, 4.5, fade(u) * 0.75);
            }
            // Слияние: яркая волна по всем прядям к ядру, около 1,6 секунды
            const since = this.flares.has(p.id) ? (clock - this.flares.get(p.id)) / 1600 : 1;
            if (since < 1) p.strands.forEach(at => this.#pulse(at, since, [255, 255, 255], 8, 1 - since * 0.6));
            else this.flares.delete(p.id);
        });
        ctx.globalCompositeOperation = 'source-over';
    }
}
