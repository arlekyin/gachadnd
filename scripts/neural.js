/**
 * Gacha Roguelike dnd5e — Фон Терминала: сознание персонажа
 *
 * Каждый навык Памяти — нейрон: экипированный светится ядром цвета редкости, остальные спят.
 * Навыки с общим тегом связаны изогнутыми отростками, по ним бегут импульсы цвета тега;
 * на пороге синергии (2 / 4 / 6) связь толще и импульсов больше. Заполнение сверх естественного
 * предела — часть связей мерцает красным. Под нейронами — тусклая сеть, чтобы пустая Память не была голой.
 *
 * Фон дополняет окно и не спорит с ним: всё приглушено. Неподвижное (сеть, отростки, связи)
 * рисуется на отдельный холст один раз при смене сборки или размера; в каждом кадре — только
 * импульсы и дыхание ядер (~30 кадров в секунду). Положения выводятся из id персонажа и навыков,
 * фаза импульсов — из часов, поэтому перерисовка окна не сбрасывает движение.
 */

import { RendererHost } from "./altar-offscreen.js";

const FRAME_MS = 33;
const TIER_STEP = 2;
const MAX_TIER = 3;

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

const rgba = (hex, alpha) => {
    const n = parseInt(String(hex).replace('#', ''), 16) || 0;
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

// Цвет тега: свой оттенок из имени, приглушённый — теги различимы, но не кричат
function tagColor(tag) {
    let h = 0;
    for (const char of tag) h = (Math.imul(h, 31) + char.charCodeAt(0)) | 0;
    const hue = Math.abs(h) % 360;
    const s = 0.45, l = 0.66;
    const k = n => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return `#${[f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// Квадратичная кривая: точка по параметру t
const quad = (ax, ay, cx, cy, bx, by) => t => {
    const u = 1 - t;
    return [u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by];
};

/**
 * Рисовальщик фона: без DOM, в рабочем потоке (OffscreenCanvas) или в основном. Размер холста меряет
 * NeuralBackground в основном потоке.
 */
export class NeuralRenderer {
    constructor({ reducedMotion = false } = {}) {
        this.reducedMotion = reducedMotion;
        this.last = 0;
        this.running = false;
    }

    /**
     * @param {HTMLCanvasElement|OffscreenCanvas} canvas
     * @param {string} key  Ключ персонажа: от него зависят фоновая сеть и места нейронов.
     * @param {object} mind { neurons: [{ id, color, active, tags }], tiers: { тег: ступень }, overload }
     */
    attach(canvas, key, mind) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.layer = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
        this.key = key;
        this.#buildDust();
        this.setMind(mind, { redraw: false });
    }

    // Фоновая сеть: тусклые клетки и связи с двумя ближайшими соседями
    #buildDust() {
        const rand = random(`${this.key}:dust`);
        this.dust = Array.from({ length: 40 }, () => ({ x: 0.02 + rand() * 0.96, y: 0.03 + rand() * 0.94, shift: rand() * 10000, period: 3000 + rand() * 4000 }));
        this.dustEdges = [];
        const seen = new Set();
        this.dust.forEach((a, i) => {
            this.dust.map((b, j) => ({ j, d: Math.hypot(a.x - b.x, (a.y - b.y) * 0.7) }))
                .filter(n => n.j !== i).sort((p, q) => p.d - q.d).slice(0, 2)
                .forEach(({ j }) => {
                    const id = i < j ? `${i}-${j}` : `${j}-${i}`;
                    if (!seen.has(id)) { seen.add(id); this.dustEdges.push([i, j]); }
                });
        });
    }

    /** Сборка изменилась: те же места у тех же навыков, новые связи. Холст и цикл не пересоздаются */
    setMind(mind = {}, { redraw = true } = {}) {
        const placed = this.neurons ?? [];
        const taken = [];
        this.neurons = (mind.neurons ?? []).map(n => {
            const old = placed.find(p => p.id === n.id);
            const spot = old ? { x: old.x, y: old.y } : this.#place(n.id, [...taken, ...placed.filter(p => (mind.neurons ?? []).some(m => m.id === p.id))]);
            taken.push(spot);
            const rand = random(`${this.key}:${n.id}:branches`);
            const branches = old?.branches ?? Array.from({ length: 5 + Math.floor(rand() * 3) }, () => ({
                ang: rand() * Math.PI * 2, len: 22 + rand() * 34, bend: (rand() - 0.5) * 0.8, fork: rand() < 0.6 ? (rand() - 0.5) * 1.2 : null
            }));
            return { ...n, ...spot, branches, phase: rand() * 6 };
        });
        this.tiers = mind.tiers ?? {};
        this.overload = !!mind.overload;

        // Связи: пара экипированных навыков с общим тегом
        this.links = [];
        const active = this.neurons.filter(n => n.active);
        for (let i = 0; i < active.length; i++) {
            for (let j = i + 1; j < active.length; j++) {
                for (const tag of active[i].tags.filter(t => active[j].tags.includes(t))) {
                    const rand = random(`${this.key}:${active[i].id}:${active[j].id}:${tag}`);
                    this.links.push({
                        a: active[i], b: active[j], tag, color: tagColor(tag),
                        tier: Math.min(MAX_TIER, this.tiers[tag] ?? 0),
                        bend: (rand() - 0.5) * 0.5,
                        pulses: Array.from({ length: MAX_TIER + 1 }, () => ({ off: rand(), speed: 0.05 + rand() * 0.05 })),
                        flicker: rand() < 0.5
                    });
                }
            }
        }
        if (redraw) this.#paintLayer();
    }

    // Место нового нейрона: из случайных по ключу навыка мест — самое далёкое от уже стоящих, чтобы нейроны
    // расходились по всему окну равномерно. Кроме мест,
    // где его закроют карта навыка с текстом, кольцо Предела разума и список синергий
    #place(id, others) {
        const rand = random(`${this.key}:${id}:spot`);
        const blocked = [
            [0.46, 0.07, 0.67, 0.47],   // карта навыка
            [0.39, 0.46, 0.74, 0.97],   // текст навыка
            [0.79, 0.04, 0.94, 0.27],   // кольцо Предела разума
            [0.73, 0.27, 0.99, 0.57]    // синергии сборки
        ];
        const open = p => !blocked.some(([x0, y0, x1, y1]) => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1);
        let best = null;
        for (let i = 0; i < 60; i++) {
            const p = { x: 0.05 + rand() * 0.9, y: 0.1 + rand() * 0.78 };
            if (!open(p)) continue;
            const gap = others.length ? Math.min(...others.map(o => Math.hypot(o.x - p.x, (o.y - p.y) * 0.75))) : 1;
            if (!best || gap > best.gap) best = { ...p, gap };
        }
        return best ? { x: best.x, y: best.y } : { x: 0.04 + rand() * 0.3, y: 0.4 + rand() * 0.55 };
    }

    /** Размер холста в CSS-пикселях и плотность пикселей */
    resize({ width, height, ratio }) {
        if (!width || !height || !this.canvas) return;
        for (const c of [this.canvas, this.layer]) {
            c.width = Math.round(width * ratio);
            c.height = Math.round(height * ratio);
            c.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
        }
        this.ratio = ratio;
        this.width = width;
        this.height = height;
        this.#paintLayer();
        if (!this.running) this.#draw(performance.now());
    }

    // Кривая связи: изгиб к центру окна, чтобы связи огибали середину, как отростки
    #curve(a, b, bend) {
        const w = this.width, h = this.height;
        const ax = a.x * w, ay = a.y * h, bx = b.x * w, by = b.y * h;
        const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay;
        return quad(ax, ay, mx - dy * bend + (w / 2 - mx) * 0.3, my + dx * bend + (h / 2 - my) * 0.3, bx, by);
    }

    // Отросток с утончением: отрезки убывающей толщины
    #taper(ctx, at, from, to, w0, w1, color) {
        const n = 16;
        ctx.strokeStyle = color;
        for (let i = 0; i < n; i++) {
            const [x0, y0] = at(from + (to - from) * i / n);
            const [x1, y1] = at(from + (to - from) * (i + 1) / n);
            ctx.lineWidth = w0 + (w1 - w0) * (i / n);
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
        }
    }

    // Неподвижная часть: фоновая сеть, отростки нейронов, связи без мерцания
    #paintLayer() {
        const ctx = this.layer.getContext('2d');
        const w = this.width, h = this.height;
        if (!w || !h) return;
        ctx.clearRect(0, 0, w, h);
        ctx.lineCap = 'round';

        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(95, 224, 184, 0.06)';
        for (const [i, j] of this.dustEdges) {
            ctx.beginPath();
            ctx.moveTo(this.dust[i].x * w, this.dust[i].y * h);
            ctx.lineTo(this.dust[j].x * w, this.dust[j].y * h);
            ctx.stroke();
        }

        for (const link of this.links) {
            if (this.overload && link.flicker) continue;
            const at = this.#curve(link.a, link.b, link.bend);
            const color = rgba(link.color, 0.07 + link.tier * 0.04);
            const width = 1.4 + link.tier * 0.7;
            this.#taper(ctx, at, 0, 0.5, width, 0.6, color);
            this.#taper(ctx, at, 1, 0.5, width, 0.6, color);
        }

        for (const n of this.neurons) {
            const x = n.x * w, y = n.y * h;
            const color = n.active ? rgba(n.color, 0.14) : 'rgba(120, 140, 136, 0.07)';
            for (const br of n.branches) {
                const ex = x + Math.cos(br.ang) * br.len, ey = y + Math.sin(br.ang) * br.len;
                const at = quad(x, y, x + Math.cos(br.ang + br.bend) * br.len * 0.55, y + Math.sin(br.ang + br.bend) * br.len * 0.55, ex, ey);
                this.#taper(ctx, at, 0, 1, n.active ? 2 : 1.1, 0.2, color);
                if (br.fork !== null) {
                    const [fx, fy] = at(0.6);
                    const angle = br.ang + br.fork, length = br.len * 0.45;
                    this.#taper(ctx, t => [fx + Math.cos(angle) * length * t, fy + Math.sin(angle) * length * t], 0, 1, n.active ? 1 : 0.6, 0.2, color);
                }
            }
        }
    }

    start() {
        if (this.running || this.reducedMotion) return this.#draw(performance.now());
        this.running = true;
        const next = globalThis.requestAnimationFrame ?? (cb => setTimeout(() => cb(performance.now()), 16));
        const loop = time => {
            if (!this.running) return;
            if (time - this.last >= FRAME_MS) {
                this.last = time;
                this.#draw(time);
            }
            this.frame = next(loop);
        };
        this.frame = next(loop);
    }

    // Пауза: цикл отрисовки останавливается, кадр остаётся на холсте; start() продолжает
    pause() {
        this.running = false;
        if (this.frame) (globalThis.cancelAnimationFrame ?? clearTimeout)(this.frame);
        this.frame = null;
    }

    stop() {
        this.pause();
    }

    #draw() {
        const { ctx, width: w, height: h } = this;
        if (!w || !h) return;
        const now = Date.now();
        const still = this.reducedMotion;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(this.layer, 0, 0, w, h);
        ctx.lineCap = 'round';

        // Перегрузка разума: часть связей мерцает красным
        if (this.overload) {
            for (const link of this.links.filter(l => l.flicker)) {
                const on = still ? 0.6 : (Math.sin(now / 110 + link.bend * 40) > 0.2 ? 1 : 0.3);
                const at = this.#curve(link.a, link.b, link.bend);
                const color = rgba('#ff5a46', (0.1 + link.tier * 0.04) * on);
                const width = 1.4 + link.tier * 0.7;
                this.#taper(ctx, at, 0, 0.5, width, 0.6, color);
                this.#taper(ctx, at, 1, 0.5, width, 0.6, color);
            }
        }

        // Мелкие клетки фоновой сети мерцают
        for (const d of this.dust) {
            const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(((now + d.shift) / d.period) * Math.PI * 2);
            ctx.fillStyle = `rgba(127, 232, 200, ${0.06 + pulse * 0.1})`;
            ctx.beginPath();
            ctx.arc(d.x * w, d.y * h, 1.3, 0, Math.PI * 2);
            ctx.fill();
        }

        // Импульсы цвета тега; на пороге синергии их больше и они чуть ярче
        if (!still) {
            for (const link of this.links) {
                const at = this.#curve(link.a, link.b, link.bend);
                const color = this.overload && link.flicker ? '#ff5a46' : link.color;
                for (const p of link.pulses.slice(0, 1 + link.tier)) {
                    const t = ((now / 1000) * p.speed * (1 + link.tier * 0.3) + p.off) % 1;
                    const fade = Math.min(1, t / 0.1, (1 - t) / 0.1);
                    const [x, y] = at(t);
                    const r = 4 + link.tier;
                    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
                    g.addColorStop(0, rgba('#ffffff', 0.32 * fade));
                    g.addColorStop(0.4, rgba(color, 0.22 * fade));
                    g.addColorStop(1, rgba(color, 0));
                    ctx.fillStyle = g;
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        // Ядра: экипированные плавно пульсируют цветом редкости — мягкий ореол расходится и сходится,
        // ядро чуть разгорается; спящие тусклые и дышат едва заметно. Отростки и связи выходят из центра ядра
        for (const n of this.neurons) {
            const x = n.x * w, y = n.y * h;
            // Синус в квадрате: долгая пауза в покое и мягкий подъём — пульс, а не мигание
            const wave = still ? 0.5 : Math.sin(now / 2400 + n.phase) ** 2;
            if (n.active) {
                const halo = 16 + wave * 14;
                const hg = ctx.createRadialGradient(x, y, 0, x, y, halo);
                hg.addColorStop(0, rgba(n.color, 0.1 + wave * 0.08));
                hg.addColorStop(1, rgba(n.color, 0));
                ctx.fillStyle = hg;
                ctx.beginPath();
                ctx.arc(x, y, halo, 0, Math.PI * 2);
                ctx.fill();
            }
            const breath = wave;
            const r = n.active ? 11 + breath * 4 : 6 + breath;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            if (n.active) {
                g.addColorStop(0, rgba('#ffffff', 0.32 + breath * 0.08));
                g.addColorStop(0.3, rgba(n.color, 0.22 + breath * 0.06));
            } else {
                g.addColorStop(0, 'rgba(150, 170, 165, 0.14)');
                g.addColorStop(0.3, 'rgba(120, 140, 136, 0.07)');
            }
            g.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

/**
 * Фон Терминала: рисовальщик живёт в рабочем потоке (RendererHost), основной поток только меряет холст.
 */
export class NeuralBackground {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {string} key  Ключ персонажа: от него зависят фоновая сеть и места нейронов.
     * @param {object} mind { neurons: [{ id, color, active, tags }], tiers: { тег: ступень }, overload }
     */
    constructor(canvas, key, mind) {
        this.canvas = canvas;
        this.host = new RendererHost('neural', NeuralRenderer);
        this.host.call('attach', canvas, key, mind);
        this.resizeObserver = new ResizeObserver(() => this.#resize());
        this.resizeObserver.observe(canvas);
        this.#resize();
    }

    #resize() {
        this.host.call('resize', { width: this.canvas.clientWidth, height: this.canvas.clientHeight, ratio: Math.min(globalThis.devicePixelRatio || 1, 2) });
    }

    /** Сборка изменилась: те же места у тех же навыков, новые связи */
    setMind(mind) {
        this.host.call('setMind', mind);
    }

    start() {
        this.host.call('start');
    }

    pause() {
        this.host.call('pause');
    }

    stop() {
        this.resizeObserver.disconnect();
        this.host.dispose();
    }
}
