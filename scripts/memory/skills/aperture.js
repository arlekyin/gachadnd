/**
 * Gacha Roguelike dnd5e — Портал (фиолетовый навык)
 *
 * Портальная пушка: использование — силуэт портала под курсором. Цвет — тот, что стоит дольше
 * (или которого ещё нет); колесо и R меняют цвет, клик ставит, правая кнопка и Esc отменяют.
 * Новый портал заменяет старый того же цвета. Порталы — плитки сцены, стоят до конца боя.
 *
 * Проход: любое существо, закончившее перемещение на клетке портала, выходит из другого портала
 * в следующую клетку по направлению своего движения (занята — в ближайшую свободную). Переносит
 * Мастер; перенос помечается в опциях обновления, чтобы выход не сработал как новый вход.
 * Встроенное поведение региона «Teleport Token» не используется: два региона, связанные друг
 * с другом, в Foundry v12 перекидывают токен по кругу.
 */

import { MODULE_ID } from "../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { key, cellOf, footprint, occupied, nearestFree } from "./grid.js";

const ART = { blue: `modules/${MODULE_ID}/assets/portal/blue.svg`, orange: `modules/${MODULE_ID}/assets/portal/orange.svg` };
const TINT = { blue: 0x2f9bff, orange: 0xff8a1c };
const LABEL = { blue: 'синий', orange: 'оранжевый' };
const isPortalSkill = item => !!item?.flags?.[MODULE_ID]?.portal;

/** Порталы персонажа на сцене: { blue: плитка, orange: плитка } */
function portalsOf(scene, actorId) {
    const out = {};
    for (const tile of scene.tiles) {
        const flag = tile.flags?.[MODULE_ID]?.portal;
        if (flag?.actorId === actorId) out[flag.color] = tile;
    }
    return out;
}

// ==========================================
// ПОСТАНОВКА
// ==========================================

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isPortalSkill(item) || !item.actor) return;
    if (!canvas?.ready || !canvas.grid?.isSquare) {
        ui.notifications.warn('Портал ставится только на сцену с квадратной сеткой.');
        return false;
    }
    if (!item.actor.getActiveTokens?.()[0]) {
        ui.notifications.warn('Токена персонажа нет на сцене: порталу не от кого отсчитывать дальность.');
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isPortalSkill(item) || !item.actor) return;
    const range = Number(activity.range?.value ?? item.system.range?.value) || 60;
    placePortal(item.actor, range);
});

function placePortal(actor, range) {
    const caster = actor.getActiveTokens()[0];
    if (!caster) return;
    const scene = canvas.scene, size = canvas.grid.size;
    const own = portalsOf(scene, actor.id);
    // Цвет: которого нет, иначе — тот, что стоит дольше
    let color = !own.blue ? 'blue' : !own.orange ? 'orange'
        : ((own.blue.flags[MODULE_ID].portal.at ?? 0) <= (own.orange.flags[MODULE_ID].portal.at ?? 0) ? 'blue' : 'orange');
    let cell = cellOf({ x: caster.document.x, y: caster.document.y }, size), ok = false;
    const preview = new PIXI.Graphics();
    preview.eventMode = 'none';
    canvas.controls.addChild(preview);
    const initialLayer = canvas.activeLayer;
    canvas.templates?.activate();
    const taken = occupied(scene, size);
    const portalCells = new Set([...scene.tiles].filter(t => t.flags?.[MODULE_ID]?.portal).map(t => key(...cellOf(t, size))));

    const draw = () => {
        const center = { x: cell[0] * size + size / 2, y: cell[1] * size + size / 2 };
        const feet = Math.hypot(center.x - caster.center.x, center.y - caster.center.y) / size * canvas.dimensions.distance;
        // Свой портал того же цвета можно переставить на его же клетку — он заменится
        const same = own[color] && key(...cellOf(own[color], size)) === key(...cell);
        ok = feet <= range && !taken.has(key(...cell)) && (!portalCells.has(key(...cell)) || same);
        const tint = ok ? TINT[color] : 0xff4d4d;
        preview.clear();
        preview.lineStyle(4, tint, 0.95).beginFill(tint, 0.25).drawCircle(center.x, center.y, size * 0.42).endFill();
    };
    draw();

    const finish = () => {
        canvas.stage.off('mousemove', onMove);
        canvas.stage.off('mouseup', onConfirm);
        canvas.app.view.oncontextmenu = null;
        canvas.app.view.onwheel = null;
        document.removeEventListener('keydown', onKey, true);
        preview.destroy();
        initialLayer?.activate();
    };
    const onMove = event => {
        event.stopPropagation();
        const point = event.getLocalPosition ? event.getLocalPosition(canvas.stage) : event.data.getLocalPosition(canvas.stage);
        const next = [Math.floor(point.x / size), Math.floor(point.y / size)];
        if (next[0] === cell[0] && next[1] === cell[1]) return;
        cell = next;
        draw();
    };
    const swap = () => { color = color === 'blue' ? 'orange' : 'blue'; draw(); };
    const onWheel = event => {
        if (event.ctrlKey) event.preventDefault();
        event.stopPropagation();
        swap();
    };
    const cancel = () => { finish(); ui.notifications.info('Портал не поставлен.'); };
    const onKey = event => {
        if (event.target?.closest?.('input, textarea, [contenteditable]')) return;
        if (event.code === 'KeyR') { swap(); event.preventDefault(); event.stopPropagation(); }
        if (event.code === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    const onConfirm = event => {
        if (event.button === 2 || (event.data?.button ?? 0) === 2) return;
        event.stopPropagation();
        if (!ok) return ui.notifications.warn(`Сюда нельзя: портал — в свободную клетку не дальше ${range} футов.`);
        finish();
        requestGM('portalPlace', { actorId: actor.id, sceneId: scene.id, color, x: cell[0] * size, y: cell[1] * size });
    };

    canvas.stage.on('mousemove', onMove);
    canvas.stage.on('mouseup', onConfirm);
    canvas.app.view.oncontextmenu = cancel;
    canvas.app.view.onwheel = onWheel;
    document.addEventListener('keydown', onKey, true);
    ui.notifications.info(`Портал (${LABEL[color]}): колесо или R — сменить цвет, клик — поставить, правая кнопка или Esc — отмена.`);
}

onSocket('portalPlace', ({ payload }) => {
    if (!isActiveGM()) return;
    setPortal(payload).catch(error => console.error(`${MODULE_ID} | Портал`, error));
});

async function setPortal({ actorId, sceneId, color, x, y }) {
    const scene = game.scenes.get(sceneId);
    if (!scene || !ART[color]) return;
    const size = scene.grid.size;
    const old = portalsOf(scene, actorId)[color];
    if (old) await scene.deleteEmbeddedDocuments('Tile', [old.id]);
    await scene.createEmbeddedDocuments('Tile', [{
        texture: { src: ART[color] }, x, y, width: size, height: size,
        flags: { [MODULE_ID]: { portal: { actorId, color, at: Date.now() } } }
    }]);
}

// ==========================================
// ПРОХОД
// ==========================================

// Где токен стоял до перемещения: направление выхода — направление движения
const lastCell = new Map();
Hooks.on('canvasReady', () => {
    lastCell.clear();
    const size = canvas.grid?.size;
    if (size) for (const token of canvas.scene?.tokens ?? []) lastCell.set(token.id, cellOf(token, size));
});

Hooks.on('createToken', token => {
    const size = token.parent?.grid?.size;
    if (size) lastCell.set(token.id, cellOf(token, size));
});

Hooks.on('updateToken', (token, changes, options) => {
    if (!('x' in changes || 'y' in changes)) return;
    const scene = token.parent;
    const size = scene?.grid?.size;
    if (!size) return;
    const from = lastCell.get(token.id);
    const to = cellOf(token, size);
    lastCell.set(token.id, to);
    if (options?.gachadndPortal || !isActiveGM()) return;
    passThrough(scene, token, from, to, size).catch(error => console.error(`${MODULE_ID} | Портал`, error));
});

async function passThrough(scene, token, from, to, size) {
    const cells = footprint(token, ...to);
    for (const tile of scene.tiles) {
        const flag = tile.flags?.[MODULE_ID]?.portal;
        if (!flag || !cells.includes(key(...cellOf(tile, size)))) continue;
        const exit = portalsOf(scene, flag.actorId)[flag.color === 'blue' ? 'orange' : 'blue'];
        if (!exit) return;
        const [ex, ey] = cellOf(exit, size);
        // Направление движения: шаг по каждой оси; не знаем, откуда шёл — выход в любую свободную клетку
        const dx = from ? Math.sign(to[0] - from[0]) : 0, dy = from ? Math.sign(to[1] - from[1]) : 0;
        const portals = new Set([...scene.tiles].filter(t => t.flags?.[MODULE_ID]?.portal).map(t => key(...cellOf(t, size))));
        const taken = new Set([...occupied(scene, size, { except: [token.id] }), ...portals]);
        const spot = nearestFree(scene, size, token, ex + dx, ey + dy, taken);
        if (!spot) return;
        lastCell.set(token.id, spot);
        await token.update({ x: spot[0] * size, y: spot[1] * size }, { gachadndPortal: true, animate: false });
        return;
    }
}

// ==========================================
// УБОРКА
// ==========================================

/** Убрать все порталы со сцены (или со всех сцен) */
export async function clearPortals(scene = null) {
    if (!game.user.isGM) return;
    for (const s of scene ? [scene] : game.scenes) {
        const ids = s.tiles.filter(t => t.flags?.[MODULE_ID]?.portal).map(t => t.id);
        if (ids.length) await s.deleteEmbeddedDocuments('Tile', ids);
    }
}

Hooks.on('deleteCombat', combat => {
    if (!isActiveGM()) return;
    clearPortals(combat.scene ?? null).catch(error => console.error(`${MODULE_ID} | Портал`, error));
});
