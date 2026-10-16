/**
 * Gacha Roguelike dnd5e — Рикошет (синий навык света)
 *
 * Использование — прицел: из центра токена луч идёт к курсору, отражается от стен, которые
 * задерживают свет (открытые двери пропускают): 2 раза, с каждым рангом — на 1 больше; длина — размер линии навыка
 * (120 футов). Траектория и задетые существа видны заранее. Клик — выстрел: задетые существа
 * становятся целями, и активность dnd5e используется заново (заряд, спасбросок Ловкости и урон —
 * штатные, шаблона нет). Правая кнопка или Esc — отмена, заряд не тратится.
 *
 * Край сцены луч не отражает — там он гаснет.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { emit, onSocket } from "../../../core/socket.js";
import { isLight, tokenOf, feetToPx, lightCard, esc } from "./common.js";

export const BOUNCES = 2;
/** Отражений на ранге навыка: 2, 3, 4 */
export const bouncesOf = item => BOUNCES + Math.max(0, (Number(item?.flags?.[MODULE_ID]?.rank) || 1) - 1);
const DEFAULT_FT = 120;
const COLOR = 0xfff1a8, GLOW = 0xffc93c;

// Выбранный путь ждёт, пока повторное использование пройдёт целиком
const chosen = new Map();

/** Стены, которые отражают луч: задерживают свет и не открытые двери */
function mirrors(scene) {
    const { NONE } = CONST.EDGE_SENSE_TYPES ?? CONST.WALL_SENSE_TYPES; // v14 переименовал
    const OPEN = CONST.WALL_DOOR_STATES.OPEN;
    return scene.walls.filter(w => w.light !== NONE && !(w.door > 0 && w.ds === OPEN))
        .map(w => ({ id: w.id, a: { x: w.c[0], y: w.c[1] }, b: { x: w.c[2], y: w.c[3] } }));
}

/** Пересечение луча p + t·d (t > 0) с отрезком [a, b]: { t, point } или null */
function hit(p, d, a, b) {
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
    const u = ((a.x - p.x) * d.y - (a.y - p.y) * d.x) / den;
    if (t <= 1e-6 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { t, point: { x: p.x + t * d.x, y: p.y + t * d.y } };
}

/**
 * Путь луча: точки ломаной от origin под углом angle (радианы), длина length пикселей.
 * @returns {{ points: {x,y}[], bounces: number }}
 */
export function trace(scene, origin, angle, length, bounces = BOUNCES) {
    const walls = mirrors(scene);
    const rect = scene.dimensions?.sceneRect ?? { x: 0, y: 0, width: scene.width, height: scene.height };
    const edges = [
        [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y }],
        [{ x: rect.x + rect.width, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }],
        [{ x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }],
        [{ x: rect.x, y: rect.y + rect.height }, { x: rect.x, y: rect.y }]
    ];
    let p = { ...origin }, d = { x: Math.cos(angle), y: Math.sin(angle) };
    let left = length, made = 0, last = null;
    const points = [{ ...p }];
    while (left > 0) {
        let best = null;
        for (const w of walls) {
            if (w.id === last) continue;
            const h = hit(p, d, w.a, w.b);
            if (h && (!best || h.t < best.t)) best = { ...h, wall: w };
        }
        let edge = null;
        for (const [a, b] of edges) {
            const h = hit(p, d, a, b);
            if (h && (!edge || h.t < edge.t)) edge = h;
        }
        const stopAt = Math.min(left, edge?.t ?? Infinity);
        if (!best || best.t >= stopAt) {
            points.push({ x: p.x + d.x * stopAt, y: p.y + d.y * stopAt });
            break;
        }
        points.push(best.point);
        left -= best.t;
        if (made >= bounces) break;
        // Отражение: d' = d − 2(d·n)n
        const wx = best.wall.b.x - best.wall.a.x, wy = best.wall.b.y - best.wall.a.y;
        const len = Math.hypot(wx, wy);
        const n = { x: -wy / len, y: wx / len };
        const dot = d.x * n.x + d.y * n.y;
        d = { x: d.x - 2 * dot * n.x, y: d.y - 2 * dot * n.y };
        p = best.point;
        last = best.wall.id;
        made++;
    }
    return { points, bounces: made };
}

/** Отрезок пересекает прямоугольник (Лианг — Барски) */
function segmentHitsRect(a, b, r) {
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    for (const [p, q] of [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dy, a.y - r.y0], [dy, r.y1 - a.y]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return true;
}

/** Существа, которых пересекает путь (кроме стрелка), по порядку на пути, без повторов */
export function hitsAlong(scene, points, casterId = null) {
    const size = scene.grid.size, inset = size * 0.1;
    const found = [];
    for (let i = 1; i < points.length; i++) {
        for (const token of scene.tokens) {
            if (token.id === casterId || found.includes(token) || token.hidden || !token.actor) continue;
            const r = { x0: token.x + inset, y0: token.y + inset, x1: token.x + (token.width || 1) * size - inset, y1: token.y + (token.height || 1) * size - inset };
            if (segmentHitsRect(points[i - 1], points[i], r)) found.push(token);
        }
    }
    return found;
}

const lengthOf = activity => feetToPx(Number(activity?.target?.template?.size) || DEFAULT_FT);

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isLight(item, 'ricochet') || !item.actor) return;
    if (chosen.has(item.id)) return;
    const caster = tokenOf(item.actor);
    if (!canvas?.ready || !caster) {
        ui.notifications.warn('Рикошет: токена персонажа нет на сцене.');
        return false;
    }
    // Сначала прицел, затем использование заново — заряд тратится только при выстреле
    aim(caster, lengthOf(activity), bouncesOf(item)).then(shot => {
        if (!shot) return;
        const targets = shot.hits.map(t => t.object).filter(Boolean);
        // Задетые — цели спасброска; v12 без setTargets — по одному
        if (canvas.tokens.setTargets) canvas.tokens.setTargets(targets.map(t => t.id));
        else {
            for (const t of [...game.user.targets]) t.setTarget(false, { releaseOthers: false });
            targets.forEach(t => t.setTarget(true, { releaseOthers: false, groupSelection: true }));
        }
        chosen.set(item.id, shot);
        return Promise.resolve(activity.use({ create: { measuredTemplate: false } })).finally(() => chosen.delete(item.id));
    }).catch(error => console.error(`${MODULE_ID} | Рикошет`, error));
    return false;
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    const shot = chosen.get(item?.id);
    if (!shot) return;
    chosen.delete(item.id);
    const data = { sceneId: canvas.scene.id, points: shot.points };
    emit('lightRicochet', data);
    showBeam(data);
    const names = shot.hits.map(t => esc(t.name)).join(', ');
    lightCard(item.actor, 'Рикошет', `<p>Отражений: ${shot.bounces}. ${names ? `Луч задел: ${names} — спасбросок Ловкости.` : 'Луч никого не задел.'}</p>`, { icon: 'fa-wand-sparkles' });
});

/**
 * Прицел: луч к курсору, отражения и задетые видны сразу.
 * @returns {Promise<{points, bounces, hits: TokenDocument[]}|null>}
 */
export function aim(caster, length, bounces = BOUNCES) {
    const scene = canvas.scene;
    const preview = new PIXI.Graphics();
    preview.eventMode = 'none';
    canvas.controls.addChild(preview);
    const initialLayer = canvas.activeLayer;
    canvas.templates?.activate();
    const origin = { x: caster.center.x, y: caster.center.y };
    let shot = null;

    const paint = point => {
        const angle = Math.atan2(point.y - origin.y, point.x - origin.x);
        const path = trace(scene, origin, angle, length, bounces);
        shot = { ...path, hits: hitsAlong(scene, path.points, caster.document.id) };
        preview.clear();
        drawBeam(preview, path.points, 0.55);
        const size = scene.grid.size;
        for (const t of shot.hits) {
            preview.lineStyle(3, 0xff5050, 0.9).drawRect(t.x + 4, t.y + 4, (t.width || 1) * size - 8, (t.height || 1) * size - 8);
        }
    };
    paint({ x: origin.x + 1, y: origin.y });
    ui.notifications.info('Рикошет: наведите луч и щёлкните. Правая кнопка или Esc — отмена.');

    return new Promise(resolve => {
        const finish = result => {
            canvas.stage.off('mousemove', onMove);
            canvas.stage.off('mouseup', onConfirm);
            canvas.app.view.oncontextmenu = null;
            document.removeEventListener('keydown', onKey, true);
            preview.destroy();
            initialLayer?.activate();
            resolve(result);
        };
        const onMove = event => {
            event.stopPropagation();
            paint(event.getLocalPosition ? event.getLocalPosition(canvas.stage) : event.data.getLocalPosition(canvas.stage));
        };
        const onConfirm = event => {
            if ((event.button ?? event.data?.button ?? 0) !== 0) return;
            event.stopPropagation();
            paint(event.getLocalPosition ? event.getLocalPosition(canvas.stage) : event.data.getLocalPosition(canvas.stage));
            finish(shot);
        };
        const onKey = event => {
            if (event.code !== 'Escape' || event.target?.closest?.('input, textarea, [contenteditable]')) return;
            event.preventDefault();
            event.stopPropagation();
            finish(null);
        };
        canvas.stage.on('mousemove', onMove);
        canvas.stage.on('mouseup', onConfirm);
        canvas.app.view.oncontextmenu = event => { event.preventDefault(); finish(null); };
        document.addEventListener('keydown', onKey, true);
    });
}

function drawBeam(g, points, alpha = 1) {
    const size = canvas.grid.size;
    for (const [width, color, a] of [[size * 0.35, GLOW, 0.18], [size * 0.16, GLOW, 0.35], [size * 0.06, COLOR, 1]]) {
        g.lineStyle(width, color, a * alpha);
        g.moveTo(points[0].x, points[0].y);
        for (const p of points.slice(1)) g.lineTo(p.x, p.y);
    }
    for (const p of points.slice(1, -1)) g.lineStyle(0).beginFill(COLOR, alpha).drawCircle(p.x, p.y, size * 0.12).endFill();
}

onSocket('lightRicochet', data => showBeam(data));

/** Выстрел у всех: луч вспыхивает и гаснет */
export function showBeam({ sceneId, points }) {
    if (!canvas?.ready || canvas.scene?.id !== sceneId || !points?.length) return;
    const g = new PIXI.Graphics();
    g.eventMode = 'none';
    canvas.interface?.addChild(g) ?? canvas.controls.addChild(g);
    const start = performance.now(), duration = 1400;
    const tick = () => {
        const k = (performance.now() - start) / duration;
        if (k >= 1 || g.destroyed) { canvas.app.ticker.remove(tick); if (!g.destroyed) g.destroy(); return; }
        g.clear();
        drawBeam(g, points, k < 0.15 ? 1 : 1 - (k - 0.15) / 0.85);
    };
    canvas.app.ticker.add(tick);
}
