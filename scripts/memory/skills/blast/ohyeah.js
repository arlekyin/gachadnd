/**
 * Gacha Roguelike dnd5e — Ох, да! (синий навык взрыва)
 *
 * Использование — прицел: рывок на 30 футов по прямой от токена к курсору, сквозь стены. Клик —
 * рывок: в каждой стене движения на пути вырезается пролом шириной в клетку (стена делится на две
 * части), каждое существо в 5 футах от пролома совершает спасбросок Силы — урон навыка (успех —
 * половина), провал — ещё и Ничком. Персонаж переносится в конец рывка без атак по возможности;
 * клетка занята — ближайшая свободная назад по линии.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { placeToken } from "../pick.js";
import { occupied, key } from "../grid.js";
import { isBlast, ref, tokenOf, quiet, damageOf, dcOf, centerOf, feetToPx, blast } from "./common.js";

const DASH_FT = 30;

/** Пересечение отрезков [p, q] и [a, b]: точка или null */
function cross(p, q, a, b) {
    const r = { x: q.x - p.x, y: q.y - p.y }, s = { x: b.x - a.x, y: b.y - a.y };
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((a.x - p.x) * s.y - (a.y - p.y) * s.x) / den;
    const u = ((a.x - p.x) * r.y - (a.y - p.y) * r.x) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: p.x + t * r.x, y: p.y + t * r.y, t };
}

/**
 * Рывок: стены на пути (точки пролома), клетка конца, задетые у проломов.
 * @returns {{ from, to, breaches: {wallId, point}[], end: number[], victims: TokenDocument[] }}
 */
export function plan(scene, token, angle, feet = DASH_FT) {
    const size = scene.grid.size;
    const from = centerOf(token);
    const len = feetToPx(feet, scene);
    const to = { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
    const { NONE } = CONST.WALL_MOVEMENT_TYPES ?? CONST.WALL_SENSE_TYPES;
    const breaches = scene.walls.filter(w => w.move !== NONE)
        .map(w => ({ wallId: w.id, point: cross(from, to, { x: w.c[0], y: w.c[1] }, { x: w.c[2], y: w.c[3] }) }))
        .filter(b => b.point);
    // Конец рывка: свободная клетка у точки конца, иначе назад по линии
    const taken = occupied(scene, size, { except: [token.id] });
    const rect = scene.dimensions.sceneRect;
    let end = null;
    for (let d = len; d >= 0; d -= size / 2) {
        const p = { x: from.x + Math.cos(angle) * d, y: from.y + Math.sin(angle) * d };
        const cell = [Math.floor(p.x / size), Math.floor(p.y / size)];
        const inScene = cell[0] * size >= rect.x && cell[1] * size >= rect.y && (cell[0] + 1) * size <= rect.x + rect.width && (cell[1] + 1) * size <= rect.y + rect.height;
        if (inScene && !taken.has(key(...cell))) { end = cell; break; }
    }
    end ??= [Math.round(token.x / size), Math.round(token.y / size)];
    // У пролома: до края токена не больше клетки
    const near = (t, p) => {
        const x = Math.max(t.x, Math.min(p.x, t.x + (t.width || 1) * size)), y = Math.max(t.y, Math.min(p.y, t.y + (t.height || 1) * size));
        return Math.hypot(p.x - x, p.y - y) <= size;
    };
    const victims = scene.tokens.filter(t => t.id !== token.id && t.actor && !t.hidden && breaches.some(b => near(t, b.point)));
    return { from, to, breaches, end, victims };
}

const chosen = new Map();
Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isBlast(item, 'ohyeah') || !actor) return;
    quiet(usage, message);
    if (chosen.has(item.id)) return;
    const caster = tokenOf(actor);
    if (!canvas?.ready || !caster) {
        ui.notifications.warn('Ох, да!: токена персонажа нет на сцене.');
        return false;
    }
    aim(caster.document).then(angle => {
        if (angle === null) return;
        chosen.set(item.id, angle);
        return Promise.resolve(activity.use()).finally(() => chosen.delete(item.id));
    }).catch(error => console.error(`${MODULE_ID} | Ох, да!`, error));
    return false;
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    const angle = chosen.get(item?.id);
    if (angle === undefined) return;
    chosen.delete(item.id);
    const damage = damageOf(item, { formula: '2d8', type: 'bludgeoning' });
    requestGM('blastOhYeah', { ...ref(item.actor), angle, formula: damage.formula, type: damage.type, dc: dcOf(item) });
});

onSocket('blastOhYeah', ({ payload }) => { if (isActiveGM()) dash(payload).catch(error => console.error(`${MODULE_ID} | Ох, да!`, error)); });

/** Мастер: проломы, задетые, перенос */
export async function dash({ actorId, tokenId, sceneId, angle, formula, type, dc }) {
    const scene = game.scenes.get(sceneId);
    const token = scene?.tokens.get(tokenId);
    const actor = token?.actor ?? game.actors.get(actorId);
    if (!token || !actor) return;
    const size = scene.grid.size;
    const route = plan(scene, token, angle);
    // Пролом шириной в клетку: стена делится на две части
    for (const { wallId, point } of route.breaches) {
        const wall = scene.walls.get(wallId);
        if (!wall) continue;
        const [ax, ay, bx, by] = wall.c;
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const u = { x: (bx - ax) / len, y: (by - ay) / len };
        const half = size / 2;
        const data = wall.toObject();
        delete data._id;
        const parts = [
            [ax, ay, point.x - u.x * half, point.y - u.y * half],
            [point.x + u.x * half, point.y + u.y * half, bx, by]
        ].filter(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0) > 4 && ((x0 - ax) * u.x + (y0 - ay) * u.y) < ((x1 - ax) * u.x + (y1 - ay) * u.y));
        await wall.delete();
        if (parts.length) await scene.createEmbeddedDocuments('Wall', parts.map(c => ({ ...data, c: c.map(Math.round) })));
    }
    await placeToken(token, route.end[0] * size, route.end[1] * size);
    const at = route.breaches[0] ? { sceneId, x: route.breaches[0].point.x, y: route.breaches[0].point.y, radius: size * 1.5 } : null;
    await blast({
        actor, title: `Ох, да! — ${actor.name} проламывает стен: ${route.breaches.length}`, icon: 'fa-person-running', victims: route.victims,
        formula, type, ability: 'str', dc, at, note: 'Провал спасброска — ничком (модуль положит сам).',
        onFail: { status: 'prone' }
    });
}

/** Прицел: линия рывка, проломы и задетые видны сразу. @returns {Promise<number|null>} угол */
export function aim(token) {
    const scene = canvas.scene;
    const preview = new PIXI.Graphics();
    preview.eventMode = 'none';
    canvas.controls.addChild(preview);
    const initialLayer = canvas.activeLayer;
    canvas.templates?.activate();
    const origin = centerOf(token);
    const size = scene.grid.size;
    let angle = 0;
    const paint = point => {
        angle = Math.atan2(point.y - origin.y, point.x - origin.x);
        const route = plan(scene, token, angle);
        preview.clear();
        preview.lineStyle(size * 0.18, 0xd8282a, 0.55).moveTo(route.from.x, route.from.y).lineTo(route.to.x, route.to.y);
        preview.lineStyle(3, 0xffffff, 0.9).drawRect(route.end[0] * size + 3, route.end[1] * size + 3, size - 6, size - 6);
        for (const b of route.breaches) preview.lineStyle(0).beginFill(0xff7a1a, 0.9).drawCircle(b.point.x, b.point.y, size * 0.25).endFill();
        for (const t of route.victims) preview.lineStyle(3, 0xff5050, 0.9).drawRect(t.x + 4, t.y + 4, (t.width || 1) * size - 8, (t.height || 1) * size - 8);
    };
    paint({ x: origin.x + 1, y: origin.y });
    ui.notifications.info('Ох, да!: наведите рывок и щёлкните. Правая кнопка или Esc — отмена.');
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
        const point = event => event.getLocalPosition ? event.getLocalPosition(canvas.stage) : event.data.getLocalPosition(canvas.stage);
        const onMove = event => { event.stopPropagation(); paint(point(event)); };
        const onConfirm = event => {
            if ((event.button ?? event.data?.button ?? 0) !== 0) return;
            event.stopPropagation();
            paint(point(event));
            finish(angle);
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
