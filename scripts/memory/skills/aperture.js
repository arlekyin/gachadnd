/**
 * Gacha Roguelike dnd5e — Портал (фиолетовый навык)
 *
 * Портальная пушка: использование — силуэт портала под курсором. Левая кнопка ставит синий,
 * правая — оранжевый, Esc отменяет. Пока своих порталов на сцене нет, одно использование ставит
 * оба: после первого — второй, другого цвета. Новый портал заменяет старый того же цвета.
 * Порталы — плитки сцены, стоят до конца боя.
 *
 * Проход: любое существо, закончившее перемещение на клетке портала, выходит из другого портала
 * в следующую клетку по направлению своего движения (занята — в ближайшую свободную) — сразу, как
 * доехал. Переносит Мастер; перенос помечается в опциях обновления, чтобы выход не сработал как
 * новый вход.
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
// Журнал прохода в консоль: CONFIG.debug.gachadndPortal = true
const trace = text => { if (globalThis.CONFIG?.debug?.gachadndPortal) console.log(`${MODULE_ID} | Портал: ${text}`); };

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
    // Первое использование, пока ни одного своего портала нет: ставятся оба
    let left = own.blue || own.orange ? 1 : 2;
    // Цвет, который ещё нужно поставить (во второй постановке пары); null — любой на выбор
    let only = null;
    let cell = cellOf({ x: caster.document.x, y: caster.document.y }, size), okFor = { blue: false, orange: false };
    const preview = new PIXI.Graphics();
    preview.eventMode = 'none';
    canvas.controls.addChild(preview);
    const initialLayer = canvas.activeLayer;
    canvas.templates?.activate();
    const taken = occupied(scene, size);
    const portalAt = new Map([...scene.tiles].filter(t => t.flags?.[MODULE_ID]?.portal).map(t => [key(...cellOf(t, size)), t]));
    const placed = {};

    const draw = () => {
        const center = { x: cell[0] * size + size / 2, y: cell[1] * size + size / 2 };
        const feet = Math.hypot(center.x - caster.center.x, center.y - caster.center.y) / size * canvas.dimensions.distance;
        const k = key(...cell);
        const free = feet <= range && !taken.has(k) && !Object.values(placed).includes(k);
        // На клетке портала можно поставить только свой портал того же цвета — он переставится
        for (const color of ['blue', 'orange']) okFor[color] = free && (!portalAt.has(k) || portalAt.get(k) === own[color]) && (!only || only === color);
        preview.clear();
        const r = size * 0.42;
        if (only) {
            const tint = okFor[only] ? TINT[only] : 0xff4d4d;
            preview.lineStyle(4, tint, 0.95).beginFill(tint, 0.25).drawCircle(center.x, center.y, r).endFill();
        } else {
            // Левая половина — синий (левая кнопка), правая — оранжевый (правая кнопка)
            for (const [color, a0, a1] of [['blue', Math.PI / 2, Math.PI * 1.5], ['orange', -Math.PI / 2, Math.PI / 2]]) {
                const tint = okFor[color] ? TINT[color] : 0xff4d4d;
                preview.lineStyle(4, tint, 0.95).beginFill(tint, 0.25).moveTo(center.x, center.y).arc(center.x, center.y, r, a0, a1).lineTo(center.x, center.y).endFill();
            }
        }
        for (const [color, k2] of Object.entries(placed)) {
            const [x, y] = k2.split(',').map(Number);
            preview.lineStyle(4, TINT[color], 0.95).beginFill(TINT[color], 0.4).drawCircle(x * size + size / 2, y * size + size / 2, r).endFill();
        }
    };
    draw();

    const finish = () => {
        canvas.stage.off('mousemove', onMove);
        canvas.stage.off('mouseup', onConfirm);
        canvas.stage.off('rightup', onConfirm);
        canvas.app.view.oncontextmenu = null;
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
    const send = () => {
        for (const [color, k] of Object.entries(placed)) {
            const [x, y] = k.split(',').map(Number);
            requestGM('portalPlace', { actorId: actor.id, sceneId: scene.id, color, x: x * size, y: y * size });
        }
    };
    const onKey = event => {
        if (event.target?.closest?.('input, textarea, [contenteditable]') || event.code !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        finish();
        // Первый портал пары уже выбран — он ставится и без второго
        if (Object.keys(placed).length) send();
        else ui.notifications.info('Портал не поставлен.');
    };
    // Левая кнопка — синий, правая — оранжевый (как у портальной пушки)
    const onConfirm = event => {
        const button = event.button ?? event.data?.button ?? 0;
        if (button !== 0 && button !== 2) return;
        event.stopPropagation();
        const color = only ?? (button === 2 ? 'orange' : 'blue');
        if (!okFor[color]) return ui.notifications.warn(`Сюда нельзя: портал — в свободную клетку не дальше ${range} футов.`);
        placed[color] = key(...cell);
        if (--left > 0) {
            only = color === 'blue' ? 'orange' : 'blue';
            draw();
            return ui.notifications.info(`Теперь ${LABEL[only]} портал: клик — поставить, Esc — оставить один.`);
        }
        finish();
        send();
    };

    canvas.stage.on('mousemove', onMove);
    // Правую кнопку PIXI сообщает отдельным событием rightup
    canvas.stage.on('mouseup', onConfirm);
    canvas.stage.on('rightup', onConfirm);
    canvas.app.view.oncontextmenu = event => event.preventDefault();
    document.addEventListener('keydown', onKey, true);
    ui.notifications.info(left === 2
        ? 'Портал: левая кнопка — синий, правая — оранжевый; затем второй. Esc — отмена.'
        : 'Портал: левая кнопка — синий, правая — оранжевый. Esc — отмена.');
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
    trace(`${token.name}: ${from ?? '?'} → ${to}`);
    passThrough(scene, token, from, to, size).catch(error => console.error(`${MODULE_ID} | Портал`, error));
});

// Перенос — когда токен доехал до портала: обновление посреди анимации движения Foundry не
// прерывает её, и токен оставался бы нарисованным в портале до следующего перемещения
async function arrived(token, from, to) {
    const start = performance.now();
    const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
    // У остальных токен едет примерно столько же: Foundry двигает токены со скоростью 6 клеток в секунду
    const steps = from ? Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])) : 0;
    const travel = steps / 6 * 1000 + 150;
    const object = token.object;
    const Animation = foundry.canvas?.animation?.CanvasAnimation ?? globalThis.CanvasAnimation;
    const running = object?.movementAnimationPromise
        ?? (object?.movementAnimationName ? Animation?.getAnimation?.(object.movementAnimationName)?.promise : null)
        ?? (object?.animationName ? Animation?.getAnimation?.(object.animationName)?.promise : null);
    // Своя анимация Мастера — ждать её, но не дольше пути с запасом: обещание может не завершиться
    if (running) await Promise.race([Promise.resolve(running).catch(() => {}), sleep(travel + 1500)]);
    await sleep(travel - (performance.now() - start));
}

async function passThrough(scene, token, from, to, size) {
    const cells = footprint(token, ...to);
    for (const tile of scene.tiles) {
        const flag = tile.flags?.[MODULE_ID]?.portal;
        if (!flag || !cells.includes(key(...cellOf(tile, size)))) continue;
        const exit = portalsOf(scene, flag.actorId)[flag.color === 'blue' ? 'orange' : 'blue'];
        if (!exit) return trace(`${token.name}: второй портал не открыт`);
        await arrived(token, from, to);
        // Пока ехал, его могли сдвинуть дальше — тогда в портал он не вошёл
        const now = cellOf(token, size);
        if (now[0] !== to[0] || now[1] !== to[1]) return trace(`${token.name}: ушёл с портала до прибытия`);
        const [ex, ey] = cellOf(exit, size);
        // Направление движения: шаг по каждой оси; не знаем, откуда шёл — выход в любую свободную клетку
        const dx = from ? Math.sign(to[0] - from[0]) : 0, dy = from ? Math.sign(to[1] - from[1]) : 0;
        const portals = new Set([...scene.tiles].filter(t => t.flags?.[MODULE_ID]?.portal).map(t => key(...cellOf(t, size))));
        const taken = new Set([...occupied(scene, size, { except: [token.id] }), ...portals]);
        const spot = nearestFree(scene, size, token, ex + dx, ey + dy, taken);
        if (!spot) return trace(`${token.name}: у выхода нет свободной клетки`);
        lastCell.set(token.id, spot);
        trace(`${token.name}: ${to} → выход ${spot}`);
        // Как телепорт в Monk's Active Tiles (v13–v14): остановить анимацию и переставить вставкой —
        // такое обновление не считается перемещением, его не ограничивают стены и очередь движения
        token.object?.stopAnimation?.();
        await token.update({ x: spot[0] * size, y: spot[1] * size }, {
            gachadndPortal: true, animate: false, animation: { duration: 0 }, isPaste: true,
            constrainOptions: { ignoreWalls: true, ignoreCost: true }
        });
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
