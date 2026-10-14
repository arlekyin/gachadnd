/**
 * Gacha Roguelike dnd5e — Клетки сетки для навыков, которые двигают существ (Портал, Fez)
 *
 * Клетка — пара [x, y] в клетках сетки, ключ «x,y». Токены и плитки — документы сцены.
 */

import { MODULE_ID } from "../../core/constants.js";

export const key = (x, y) => `${x},${y}`;

/** Клетка верхнего левого угла документа (токена, плитки) */
export const cellOf = (doc, size) => [Math.round(doc.x / size), Math.round(doc.y / size)];

/** Клетки, которые занимает токен, стоящий верхним левым углом в клетке [gx, gy] */
export function footprint(token, gx, gy) {
    const out = [];
    for (let dx = 0; dx < (token.width || 1); dx++) for (let dy = 0; dy < (token.height || 1); dy++) out.push(key(gx + dx, gy + dy));
    return out;
}

/** Клетки, куда нельзя встать: блоки Тетриса и токены сцены (кроме перечисленных) */
export function occupied(scene, size, { except = [] } = {}) {
    const cells = new Set();
    for (const tile of scene.tiles) if (tile.flags?.[MODULE_ID]?.tetris) cells.add(key(...cellOf(tile, size)));
    for (const token of scene.tokens) {
        if (except.includes(token.id)) continue;
        footprint(token, ...cellOf(token, size)).forEach(k => cells.add(k));
    }
    return cells;
}

/** Клетка внутри сцены (с учётом размера токена) */
export function inside(scene, size, token, gx, gy) {
    const w = Math.floor((scene.dimensions?.width ?? Infinity) / size), h = Math.floor((scene.dimensions?.height ?? Infinity) / size);
    return gx >= 0 && gy >= 0 && gx + (token.width || 1) <= w && gy + (token.height || 1) <= h;
}

/** Ближайшая к [gx, gy] клетка, где токен помещается: по кольцам, не дальше maxRing */
export function nearestFree(scene, size, token, gx, gy, taken, maxRing = 6) {
    const fits = (x, y) => inside(scene, size, token, x, y) && footprint(token, x, y).every(k => !taken.has(k));
    if (fits(gx, gy)) return [gx, gy];
    for (let r = 1; r <= maxRing; r++) {
        const ring = [];
        for (let x = gx - r; x <= gx + r; x++) for (let y = gy - r; y <= gy + r; y++) {
            if (Math.max(Math.abs(x - gx), Math.abs(y - gy)) === r && fits(x, y)) ring.push([x, y]);
        }
        if (ring.length) return ring.sort((a, b) => Math.hypot(a[0] - gx, a[1] - gy) - Math.hypot(b[0] - gx, b[1] - gy))[0];
    }
    return null;
}

/** Стена движения между двумя точками сцены (пиксели); без API стен — стены нет */
export function wallBetween(from, to) {
    try {
        const backend = CONFIG.Canvas?.polygonBackends?.move;
        return !!backend?.testCollision(from, to, { type: 'move', mode: 'any' });
    } catch (error) {
        return false;
    }
}
