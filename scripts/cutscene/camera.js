/**
 * Катсцены — камера сцены Foundry: наезд, поворот, сдвиг, тряска. Двигает саму сцену (PIXI stage),
 * поэтому сцена и токены остаются резкими при любом наезде. После сцены — restore().
 */

import { lerp } from "./math.js";

/** @returns {object|null}  null — сцены нет. */
export function stageCamera() {
    const stage = canvas?.stage, view = canvas?.app?.view ?? canvas?.app?.canvas;
    if (!stage || !view) return null;
    const rect = view.getBoundingClientRect();
    const saved = { x: stage.position.x, y: stage.position.y, sx: stage.scale.x, sy: stage.scale.y, rot: stage.rotation ?? 0 };
    // Точка сцены, которая сейчас в центре экрана
    const viewCenter = { x: stage.pivot.x + (rect.width / 2 - saved.x) / saved.sx, y: stage.pivot.y + (rect.height / 2 - saved.y) / saved.sy };
    // Положение сцены, при котором точка center — в центре экрана при масштабе s и повороте rot
    const at = (s, center, rot) => {
        const dx = (center.x - stage.pivot.x) * s, dy = (center.y - stage.pivot.y) * s;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        return { x: rect.width / 2 - (dx * cos - dy * sin), y: rect.height / 2 - (dx * sin + dy * cos) };
    };
    return {
        stage, rect, saved, viewCenter,
        /**
         * Поставить камеру: k — от обычного вида (0) к заданному (1); scale — масштаб, center —
         * точка сцены в центре экрана, rot — поворот (рад), dx/dy — сдвиг в пикселях (тряска).
         */
        place({ k = 1, scale = saved.sx, center = viewCenter, rot = 0, dx = 0, dy = 0 }) {
            const s = lerp(saved.sx, scale, k), r = rot * k;
            const pos = at(s, { x: lerp(viewCenter.x, center.x, k), y: lerp(viewCenter.y, center.y, k) }, r);
            stage.scale.set(s, s * saved.sy / saved.sx);
            stage.rotation = saved.rot + r;
            stage.position.set(pos.x + dx, pos.y + dy);
        },
        // Масштаб, при котором точки points (с запасом margin) занимают долю fill экрана;
        // не меньше текущего и не больше maxZoom от него
        fit(points, center, { fill = 0.75, margin = 0, maxZoom = 3 } = {}) {
            const half = ['x', 'y'].map(axis => Math.max(...points.map(p => Math.abs(p[axis] - center[axis]))) + margin);
            const maxScale = Math.min(saved.sx * maxZoom, globalThis.CONFIG?.Canvas?.maxZoom ?? 3);
            const scale = Math.min(rect.width * fill / (2 * half[0]), rect.height * fill / (2 * half[1]));
            return Math.max(saved.sx, Math.min(maxScale, scale));
        },
        /** Точка сцены → пиксели устройства на экране при текущей камере */
        screenOf(p) {
            const dx = (p.x - stage.pivot.x) * stage.scale.x, dy = (p.y - stage.pivot.y) * stage.scale.y;
            const cos = Math.cos(stage.rotation), sin = Math.sin(stage.rotation);
            return { x: (rect.left + stage.position.x + dx * cos - dy * sin) * devicePixelRatio, y: (rect.top + stage.position.y + dx * sin + dy * cos) * devicePixelRatio };
        },
        restore() {
            stage.scale.set(saved.sx, saved.sy);
            stage.rotation = saved.rot;
            stage.position.set(saved.x, saved.y);
        }
    };
}

/**
 * Тряска: kick(t, power) — толчок в момент t; offset(t, duration) — сдвиг камеры сейчас: бросает
 * туда-обратно, размах быстро гаснет.
 */
export function shaker(period = 18) {
    const s = { x: 0, y: 0, at: -1e9, power: 0 };
    return {
        kick(at, power) {
            const angle = Math.random() * Math.PI * 2;
            Object.assign(s, { x: Math.cos(angle), y: Math.sin(angle), at, power });
        },
        offset(t, duration) {
            const k = (t - s.at) / duration;
            const j = k >= 0 && k < 1 ? s.power * (1 - k) ** 2 * Math.cos((t - s.at) / period * Math.PI) : 0;
            return { x: s.x * j, y: s.y * j };
        }
    };
}
