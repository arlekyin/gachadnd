/**
 * Gacha Roguelike dnd5e — физика огоньков Алтаря Памяти
 *
 * Огоньки можно взять, перетащить и бросить: они летят, гаснут трением, отскакивают
 * от краёв, ядра, узлов орбиты и друг от друга. Отпущенный над ядром или узлом огонёк
 * передаётся Алтарю как «бросок в цель», короткое нажатие — как выбор.
 * Цикл анимации работает только пока что-то движется; положение — через left/top в %.
 * Поле огоньков и слой с ядром и узлами — разные части окна одного размера, поэтому
 * препятствия ищутся в общем корне (obstacles).
 */

const MOTE_RADIUS = 20;
const EDGE_X = 56;          // подпись шире огонька — держим её в поле
const EDGE_BOTTOM = 36;
const TAP_DISTANCE = 6;
const FRICTION = 1.8;        // доля скорости, теряемая за секунду (экспонента)
const BOUNCE = 0.75;
const MAX_SPEED = 2600;      // px/с
const REST_SPEED = 10;

export class MindPhysics {
    /**
     * @param {HTMLElement} field  поле сознания
     * @param {object} handlers
     * @param {(el: HTMLElement) => void} handlers.onTap
     * @param {(el: HTMLElement, target: {type: 'core'|'node'|'away', id?: string}) => boolean} handlers.onDrop
     * @param {(key: string, pos: {x: number, y: number}) => void} handlers.onSettle  положение в % поля
     * @param {Map<string, {vx: number, vy: number}>} [handlers.momentum]  полёт, прерванный перерисовкой
     * @param {HTMLElement} [handlers.obstacles]  корень, где лежат ядро и узлы орбиты
     */
    constructor(field, { onTap, onDrop, onSettle, momentum, obstacles }) {
        this.field = field;
        this.obstacles = obstacles ?? field;
        this.onTap = onTap;
        this.onDrop = onDrop;
        this.onSettle = onSettle;
        this.frame = null;
        this.last = 0;
        this.drag = null;
        // Размеры снимаются при первом касании: при первой отрисовке окно ещё
        // не разложено, а поле идёт с анимацией погружения (масштаб)
        this.rect = null;
        this.bodies = [...field.querySelectorAll('.gd-mote')].map(el => ({ el, x: 0, y: 0, vx: 0, vy: 0, fixed: el.classList.contains('focused') }));
        this.onDown = this.#down.bind(this);
        this.onMove = this.#move.bind(this);
        this.onUp = this.#up.bind(this);
        field.addEventListener('pointerdown', this.onDown);

        // Полёт, прерванный перерисовкой, продолжается с той же скоростью
        const carried = this.bodies.filter(b => momentum?.has(b.el.dataset.key));
        if (carried.length) {
            this.#measure();
            for (const b of carried) {
                const { vx, vy } = momentum.get(b.el.dataset.key);
                b.vx = vx;
                b.vy = vy;
                b.el.classList.add('flying');
            }
            this.#start();
        }
    }

    /** Огоньки в полёте: место в % поля и скорость — чтобы пережить перерисовку */
    snapshot() {
        const moving = new Map();
        if (!this.rect) return moving;
        // Полёт замирает до новой физики: кадры между снимком и перерисовкой не теряются
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = null;
        for (const b of this.bodies) {
            if (b.fixed || b === this.drag?.body || !(b.vx || b.vy)) continue;
            moving.set(b.el.dataset.key, { ...this.#percent(b), vx: b.vx, vy: b.vy });
        }
        return moving;
    }

    /** Алтарь сменил огонькам роли (фокус) без перерисовки поля — обновить тела */
    refresh() {
        for (const b of this.bodies) {
            const fixed = b.el.classList.contains('focused');
            if (fixed && !b.fixed) {
                b.vx = b.vy = 0;
                b.el.classList.remove('flying');
            }
            b.fixed = fixed;
        }
        if (this.rect) this.#measure();
    }

    destroy() {
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.field.removeEventListener('pointerdown', this.onDown);
        window.removeEventListener('pointermove', this.onMove);
        window.removeEventListener('pointerup', this.onUp);
    }

    // Размер поля и неподвижные препятствия: ядро и узлы орбиты. Размер берётся
    // из раскладки (offsetWidth), а не из getBoundingClientRect — тот искажён масштабом.
    // Неподвижные огоньки заново читают своё место из стиля — он всегда истинен
    #measure() {
        const box = this.field.getBoundingClientRect();
        const width = this.field.offsetWidth || box.width;
        const height = this.field.offsetHeight || box.height;
        const scale = box.width / width || 1;
        this.rect = { left: box.left, top: box.top, width, height, scale };
        const circle = (el, pad = 0) => {
            const r = el.getBoundingClientRect();
            return { x: (r.left - box.left + r.width / 2) / scale, y: (r.top - box.top + r.height / 2) / scale, r: r.width / 2 / scale + pad };
        };
        const core = this.obstacles.querySelector('.gd-core');
        this.core = core ? circle(core, 6) : null;
        this.nodes = [...this.obstacles.querySelectorAll('.gd-node')].map(el => ({ id: el.dataset.itemId, ...circle(el.querySelector('.gd-node-disc'), 4) }));
        for (const b of this.bodies) {
            if (b.vx || b.vy) continue;
            b.x = parseFloat(b.el.style.left) / 100 * width;
            b.y = parseFloat(b.el.style.top) / 100 * height;
        }
    }

    #place(body) {
        body.el.style.left = `${(body.x / this.rect.width * 100).toFixed(3)}%`;
        body.el.style.top = `${(body.y / this.rect.height * 100).toFixed(3)}%`;
    }

    #local(event) {
        return { x: (event.clientX - this.rect.left) / this.rect.scale, y: (event.clientY - this.rect.top) / this.rect.scale };
    }

    #down(event) {
        if (event.button !== 0) return;
        const el = event.target.closest('.gd-mote');
        const body = el && this.bodies.find(b => b.el === el);
        if (!body) return;
        event.preventDefault();
        this.#measure();
        const p = this.#local(event);
        body.vx = body.vy = 0;
        this.drag = { body, dx: body.x - p.x, dy: body.y - p.y, start: p, moved: false, samples: [{ ...p, t: performance.now() }] };
        el.classList.add('held');
        window.addEventListener('pointermove', this.onMove);
        window.addEventListener('pointerup', this.onUp);
    }

    #move(event) {
        const drag = this.drag;
        if (!drag) return;
        const p = this.#local(event);
        if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > TAP_DISTANCE) drag.moved = true;
        if (!drag.moved) return;
        drag.body.x = this.#clamp(p.x + drag.dx, EDGE_X, this.rect.width - EDGE_X);
        drag.body.y = this.#clamp(p.y + drag.dy, MOTE_RADIUS, this.rect.height - EDGE_BOTTOM);
        this.#place(drag.body);
        const now = performance.now();
        drag.samples.push({ ...p, t: now });
        while (drag.samples.length > 2 && now - drag.samples[0].t > 90) drag.samples.shift();
    }

    #up(event) {
        window.removeEventListener('pointermove', this.onMove);
        window.removeEventListener('pointerup', this.onUp);
        const drag = this.drag;
        this.drag = null;
        if (!drag) return;
        const { body } = drag;
        body.el.classList.remove('held');
        if (!drag.moved) return this.onTap(body.el);

        // Отпущен над целью — Алтарь решает, принимает ли она огонёк
        const p = this.#local(event);
        const node = this.nodes.find(n => Math.hypot(p.x - n.x, p.y - n.y) < n.r + 8);
        const overCore = this.core && Math.hypot(p.x - this.core.x, p.y - this.core.y) < this.core.r + 10;
        if (overCore && this.onDrop(body.el, { type: 'core' })) return;
        if (node && this.onDrop(body.el, { type: 'node', id: node.id })) return;
        if (body.fixed) {
            this.onSettle(this.#key(body), this.#percent(body));
            this.onDrop(body.el, { type: 'away' });
            return;
        }

        // Иначе бросок: скорость по последним движениям указателя
        const first = drag.samples[0], lastSample = drag.samples[drag.samples.length - 1];
        const dt = Math.max((lastSample.t - first.t) / 1000, 0.016);
        body.vx = (lastSample.x - first.x) / dt;
        body.vy = (lastSample.y - first.y) / dt;
        const speed = Math.hypot(body.vx, body.vy);
        if (speed > MAX_SPEED) { body.vx *= MAX_SPEED / speed; body.vy *= MAX_SPEED / speed; }
        body.el.classList.add('flying');
        this.#start();
    }

    #start() {
        if (this.frame) return;
        this.last = performance.now();
        this.frame = requestAnimationFrame(t => this.#tick(t));
    }

    #tick(now) {
        const dt = Math.min((now - this.last) / 1000, 0.05);
        this.last = now;
        const { width, height } = this.rect;
        const free = this.bodies.filter(b => !b.fixed && b !== this.drag?.body);
        const damp = Math.exp(-FRICTION * dt);

        for (const b of free) {
            b.vx *= damp;
            b.vy *= damp;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            if (b.x < EDGE_X) { b.x = EDGE_X; b.vx = Math.abs(b.vx) * BOUNCE; }
            if (b.x > width - EDGE_X) { b.x = width - EDGE_X; b.vx = -Math.abs(b.vx) * BOUNCE; }
            if (b.y < MOTE_RADIUS) { b.y = MOTE_RADIUS; b.vy = Math.abs(b.vy) * BOUNCE; }
            if (b.y > height - EDGE_BOTTOM) { b.y = height - EDGE_BOTTOM; b.vy = -Math.abs(b.vy) * BOUNCE; }
            for (const o of [this.core, ...this.nodes]) if (o) this.#bounceStatic(b, o);
        }
        // Огоньки сталкиваются между собой (равные массы)
        for (let i = 0; i < free.length; i++) {
            for (let j = i + 1; j < free.length; j++) this.#collide(free[i], free[j]);
            for (const f of this.bodies) if (f.fixed) this.#bounceStatic(free[i], { x: f.x, y: f.y, r: MOTE_RADIUS });
        }

        let moving = false;
        for (const b of free) {
            const speed = Math.hypot(b.vx, b.vy);
            if (speed > REST_SPEED) moving = true;
            else if (b.el.classList.contains('flying')) {
                b.vx = b.vy = 0;
                b.el.classList.remove('flying');
                this.onSettle(this.#key(b), this.#percent(b));
            }
            this.#place(b);
        }
        this.frame = moving ? requestAnimationFrame(t => this.#tick(t)) : null;
    }

    #bounceStatic(b, o) {
        const dx = b.x - o.x, dy = b.y - o.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const min = o.r + MOTE_RADIUS;
        if (dist >= min) return;
        const nx = dx / dist, ny = dy / dist;
        b.x = o.x + nx * min;
        b.y = o.y + ny * min;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { b.vx -= (1 + BOUNCE) * vn * nx; b.vy -= (1 + BOUNCE) * vn * ny; }
    }

    #collide(a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const min = MOTE_RADIUS * 2;
        if (dist >= min) return;
        const nx = dx / dist, ny = dy / dist;
        const push = (min - dist) / 2;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel >= 0) return;
        const impulse = -(1 + BOUNCE) * rel / 2;
        a.vx -= impulse * nx; a.vy -= impulse * ny;
        b.vx += impulse * nx; b.vy += impulse * ny;
        for (const body of [a, b]) body.el.classList.add('flying');
    }

    #key(body) {
        return body.el.dataset.key;
    }

    #percent(body) {
        return { x: body.x / this.rect.width * 100, y: body.y / this.rect.height * 100 };
    }

    #clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }
}
