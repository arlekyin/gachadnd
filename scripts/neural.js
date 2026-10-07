/**
 * Gacha Roguelike dnd5e — Фон Терминала: нейронная сеть с электрическими всполохами
 *
 * Рисуется на <canvas> собственным циклом (~30 кадров в секунду): нагрузка постоянная,
 * в отличие от анимаций SVG, которые со временем перерисовываются всё дороже.
 * Сеть строится детерминированно по ключу (id персонажа), положение импульсов
 * считается от часов, поэтому перерисовка окна не сбрасывает движение.
 */

const FRAME_MS = 33;

// Детерминированный генератор псевдослучайных чисел (mulberry32)
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

export class NeuralBackground {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {string} key          Ключ сети (id персонажа).
     * @param {number} activeCount  Число экипированных навыков: от него зависят импульсы и всполохи.
     */
    constructor(canvas, key, activeCount = 0) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.activeCount = activeCount;
        this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        this.#build(key);
        this.bolts = [];
        this.nextBolt = performance.now() + 800;
        this.last = 0;
        this.running = false;
        this.resizeObserver = new ResizeObserver(() => this.#resize());
        this.resizeObserver.observe(canvas);
        this.#resize();
    }

    // Узлы в относительных координатах 0..1, связи — с двумя ближайшими соседями
    #build(key) {
        const rand = random(key);
        this.nodes = Array.from({ length: 48 }, () => ({
            x: 0.02 + rand() * 0.96,
            y: 0.03 + rand() * 0.94,
            r: 1.2 + rand() * 2,
            period: 3000 + rand() * 4000,
            shift: rand() * 10000
        }));
        const seen = new Set();
        this.edges = [];
        this.nodes.forEach((a, i) => {
            this.nodes
                .map((b, j) => ({ j, d: Math.hypot(a.x - b.x, (a.y - b.y) * 0.7) }))
                .filter(n => n.j !== i)
                .sort((p, q) => p.d - q.d)
                .slice(0, 2)
                .forEach(({ j }) => {
                    const id = i < j ? `${i}-${j}` : `${j}-${i}`;
                    if (seen.has(id)) return;
                    seen.add(id);
                    this.edges.push({ a: i, b: j, glow: 0 });
                });
        });
        const pulseCount = Math.min(this.edges.length, 6 + this.activeCount * 3);
        this.pulses = Array.from({ length: pulseCount }, () => ({
            edge: Math.floor(rand() * this.edges.length),
            period: 2500 + rand() * 3500,
            shift: rand() * 10000,
            reverse: rand() < 0.5
        }));
        this.rand = rand;
    }

    #resize() {
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        if (!width || !height) return;
        this.canvas.width = Math.round(width * ratio);
        this.canvas.height = Math.round(height * ratio);
        this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.width = width;
        this.height = height;
        if (!this.running) this.#draw(performance.now());
    }

    start() {
        if (this.running || this.reducedMotion) return this.#draw(performance.now());
        this.running = true;
        const loop = time => {
            if (!this.running) return;
            if (!this.canvas.isConnected) return this.stop();
            if (time - this.last >= FRAME_MS) {
                this.last = time;
                this.#draw(time);
            }
            this.frame = requestAnimationFrame(loop);
        };
        this.frame = requestAnimationFrame(loop);
    }

    // Пауза: цикл отрисовки останавливается, кадр остаётся на холсте; start() продолжает
    pause() {
        this.running = false;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = null;
    }

    stop() {
        this.pause();
        this.resizeObserver.disconnect();
    }

    // Электрический всполох: ломаная молния между двумя узлами, подсвечивает соседние связи
    #spawnBolt(time) {
        const edge = this.edges[Math.floor(Math.random() * this.edges.length)];
        const neighbours = this.edges.filter(e => e !== edge && (e.a === edge.a || e.b === edge.a || e.a === edge.b || e.b === edge.b));
        const target = neighbours.length && Math.random() < 0.6 ? neighbours[Math.floor(Math.random() * neighbours.length)] : null;
        const chain = [edge, target].filter(Boolean);
        chain.forEach(e => { e.glow = 1; });
        this.bolts.push({
            born: time,
            life: 280 + Math.random() * 220,
            segments: chain.map(e => this.#jagged(this.nodes[e.a], this.nodes[e.b]))
        });
        // Чем больше экипировано навыков, тем чаще всполохи: от ~4 с до ~1 с
        const base = Math.max(900, 4200 - this.activeCount * 260);
        this.nextBolt = time + base * (0.6 + Math.random() * 0.8);
    }

    #jagged(a, b) {
        const points = [[a.x, a.y]];
        const steps = 6;
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            const jitter = 0.018;
            points.push([a.x + (b.x - a.x) * t + (Math.random() - 0.5) * jitter, a.y + (b.y - a.y) * t + (Math.random() - 0.5) * jitter]);
        }
        points.push([b.x, b.y]);
        return points;
    }

    #draw(time) {
        const { ctx, width: w, height: h } = this;
        if (!w || !h) return;
        const now = Date.now();
        ctx.clearRect(0, 0, w, h);

        if (!this.reducedMotion && time >= this.nextBolt) this.#spawnBolt(time);

        // Связи
        ctx.lineWidth = 1;
        for (const e of this.edges) {
            const a = this.nodes[e.a];
            const b = this.nodes[e.b];
            ctx.strokeStyle = `rgba(95, 224, 184, ${0.1 + e.glow * 0.5})`;
            ctx.beginPath();
            ctx.moveTo(a.x * w, a.y * h);
            ctx.lineTo(b.x * w, b.y * h);
            ctx.stroke();
            e.glow = Math.max(0, e.glow - 0.06);
        }

        // Импульсы — короткий светящийся штрих вдоль связи
        if (!this.reducedMotion) {
            ctx.lineCap = 'round';
            for (const p of this.pulses) {
                const e = this.edges[p.edge];
                const [a, b] = p.reverse ? [this.nodes[e.b], this.nodes[e.a]] : [this.nodes[e.a], this.nodes[e.b]];
                const t = ((now + p.shift) % p.period) / p.period;
                const alpha = t < 0.1 ? t / 0.1 : t > 0.9 ? (1 - t) / 0.1 : 1;
                const x = a.x + (b.x - a.x) * t;
                const y = a.y + (b.y - a.y) * t;
                const tail = Math.max(0, t - 0.08);
                const gradient = ctx.createLinearGradient((a.x + (b.x - a.x) * tail) * w, (a.y + (b.y - a.y) * tail) * h, x * w, y * h);
                gradient.addColorStop(0, 'rgba(200, 255, 240, 0)');
                gradient.addColorStop(1, `rgba(200, 255, 240, ${0.85 * alpha})`);
                ctx.strokeStyle = gradient;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo((a.x + (b.x - a.x) * tail) * w, (a.y + (b.y - a.y) * tail) * h);
                ctx.lineTo(x * w, y * h);
                ctx.stroke();
            }
        }

        // Узлы мерцают
        for (const n of this.nodes) {
            const pulse = 0.5 + 0.5 * Math.sin(((now + n.shift) / n.period) * Math.PI * 2);
            ctx.fillStyle = `rgba(127, 232, 200, ${0.15 + pulse * 0.45})`;
            ctx.beginPath();
            ctx.arc(n.x * w, n.y * h, n.r, 0, Math.PI * 2);
            ctx.fill();
        }

        // Всполохи: яркое ядро и широкое свечение, быстро гаснут
        this.bolts = this.bolts.filter(bolt => time - bolt.born < bolt.life);
        for (const bolt of this.bolts) {
            const fade = 1 - (time - bolt.born) / bolt.life;
            for (const segment of bolt.segments) {
                for (const [width, color] of [[6, `rgba(95, 224, 184, ${0.18 * fade})`], [1.6, `rgba(235, 255, 250, ${0.95 * fade})`]]) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = width;
                    ctx.beginPath();
                    segment.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
                    ctx.stroke();
                }
            }
        }
    }
}
