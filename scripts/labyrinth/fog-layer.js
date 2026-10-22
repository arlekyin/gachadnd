/**
 * Gacha Roguelike dnd5e — Общий Туман левой части экрана: под картой-паутиной и Терминалом Тумана
 *
 * Один холст на всё: вкладки (Терминал, паутина) меняют только содержимое поверх, Туман остаётся и клубится
 * дальше. Открытие — Туман наползает слева рваным краем, закрытие — уползает; при смене вкладки сдвигается
 * только его отсвет (к астролябии или к сетке навыков). Шейдер и палитра — у паутины (web-stage.js).
 *
 *   fogLayer.show({ center, radius, z })  — показать (уже виден — только сдвинуть отсвет); Promise — наполз
 *   fogLayer.hide()                       — уползти и спрятаться; Promise
 *   fogLayer.focus(center, radius)        — плавно сдвинуть отсвет
 *   fogLayer.handoff()                    — вкладка уходит, следующая сейчас откроется: Туман ждёт её;
 *                                           не открылась за полторы секунды — уползает
 * Под системным «уменьшить движение» Туман не клубится и появляется сразу.
 */

import { VERT, FOG, FOG_MAP, quad } from "./web-stage.js";

const ID = 'gd-fog-layer';
const ease = k => 1 - (1 - k) ** 3;
const smooth = k => k * k * (3 - 2 * k);
const clamp = v => Math.max(0, Math.min(1, v));

class FogLayer {
    #app = null;
    #mesh = null;
    #el = null;
    #time = Math.random() * 100;
    #slide = null;     // { from, to, start, ms, resolve }
    #focus = null;     // { from: [x, y, r], to: [x, y, r], start }
    #shown = false;
    #wait = null;
    still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    get visible() { return this.#shown; }
    get uniforms() { return this.#mesh?.shader.uniforms; }

    #ensure() {
        if (this.#app) return;
        const el = document.createElement('div');
        el.id = ID;
        const canvas = document.createElement('canvas');
        el.append(canvas);
        document.body.append(el);
        this.#el = el;
        this.#fit();
        this.#app = new PIXI.Application({ view: canvas, backgroundAlpha: 0, antialias: false, autoDensity: true, resolution: Math.min(1.5, window.devicePixelRatio || 1), resizeTo: el });
        this.#mesh = new PIXI.Mesh(quad(1, 1), PIXI.Shader.from(VERT, FOG, { uTime: 0, uAspect: 1, uCenter: [0.22, 0.45], uRadius: 0.35, uSlide: -0.1, ...FOG_MAP }));
        this.#app.stage.addChild(this.#mesh);
        this.#app.ticker.add(() => this.#frame());
        this.#app.ticker.stop();
        window.addEventListener('resize', foundry.utils.debounce(() => this.#fit(), 120));
    }

    /** До боковой панели справа — как слои поверх */
    #fit() {
        if (!this.#el) return;
        const edge = document.getElementById('ui-right')?.getBoundingClientRect().left;
        this.#el.style.right = edge > window.innerWidth * 0.5 ? `${Math.max(0, window.innerWidth - edge)}px` : '0px';
    }

    #frame() {
        const now = performance.now();
        if (!this.still) this.#time += this.#app.ticker.deltaMS / 1000;
        const { width: W, height: H } = this.#app.screen;
        const u = this.#mesh.shader.uniforms;
        this.#mesh.scale.set(W, H);
        u.uTime = this.#time;
        u.uAspect = W / H;
        if (this.#focus) {
            const k = smooth(clamp((now - this.#focus.start) / 450));
            const [x, y, r] = this.#focus.from.map((v, i) => v + (this.#focus.to[i] - v) * k);
            u.uCenter = [x, y]; u.uRadius = r;
            if (k >= 1) this.#focus = null;
        }
        if (this.#slide) {
            const s = this.#slide, k = clamp((now - s.start) / s.ms);
            u.uSlide = s.from + (s.to - s.from) * (s.to > s.from ? ease(k) : smooth(k));
            if (k >= 1) {
                this.#slide = null;
                s.resolve();
            }
        }
    }

    #slideTo(to, ms) {
        const u = this.#mesh.shader.uniforms;
        this.#slide?.resolve();
        if (this.still) { u.uSlide = to; this.#slide = null; return Promise.resolve(); }
        return new Promise(resolve => { this.#slide = { from: u.uSlide, to, start: performance.now(), ms, resolve }; });
    }

    /** Показать Туман; если он уже виден — сдвинуть отсвет. z — слой поверх (Туман встаёт сразу под ним) */
    show({ center = [0.22, 0.45], radius = 0.35, z = 50 } = {}) {
        clearTimeout(this.#wait);
        this.#ensure();
        this.#el.style.zIndex = String(z - 1);
        this.#fit();
        if (this.#shown) { this.focus(center, radius); return Promise.resolve(); }
        this.#shown = true;
        Object.assign(this.#mesh.shader.uniforms, { uCenter: center, uRadius: radius });
        this.#focus = null;
        this.#el.classList.add('on');
        this.#app.ticker.start();
        return this.#slideTo(1.5, 800);
    }

    focus(center, radius) {
        if (!this.#mesh) return;
        const u = this.#mesh.shader.uniforms;
        const from = [u.uCenter[0], u.uCenter[1], u.uRadius], to = [center[0], center[1], radius];
        if (from.every((v, i) => Math.abs(v - to[i]) < 1e-3)) return;
        this.#focus = { from, to, start: performance.now() };
    }

    handoff() {
        clearTimeout(this.#wait);
        this.#wait = setTimeout(() => this.hide(), 1500);
    }

    async hide() {
        clearTimeout(this.#wait);
        if (!this.#shown) return;
        this.#shown = false;
        await this.#slideTo(-0.1, 650);
        // Пока уползал, его снова позвали — остаётся
        if (this.#shown) return;
        this.#el.classList.remove('on');
        this.#app.ticker.stop();
    }
}

export const fogLayer = new FogLayer();
