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
 * доехал. В Foundry v13+ переносит тот, кто двигал токен (перемещение «displace»), в v12 — Мастер
 * обновлением без анимации; перенос помечается, чтобы выход не сработал как новый вход.
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
// Журнал прохода в консоль: настройка «Журнал Портала» (у каждого клиента своя) или CONFIG.debug.gachadndPortal = true
const debugOn = () => {
    if (globalThis.CONFIG?.debug?.gachadndPortal) return true;
    try { return !!game.settings.get(MODULE_ID, 'portalDebug'); } catch (error) { return false; }
};
const trace = text => { if (debugOn()) console.log(`%c${MODULE_ID} | Портал: ${text}`, 'color: #2f9bff'); };

export function registerPortalSettings() {
    game.settings.register(MODULE_ID, 'portalDebug', {
        name: 'Журнал Портала',
        hint: 'Пишет в консоль браузера (F12) каждый шаг прохода через Портал: какие перемещения увидел модуль, нашёл ли портал и выход, чем закончился перенос. Включать у того, кто двигает токен, и у Мастера.',
        scope: 'client', config: true, type: Boolean, default: false
    });
}

// Строка при загрузке — по ней видно, что в браузере новый код модуля, и включён ли журнал
Hooks.once('ready', () => {
    console.log(`%c${MODULE_ID} | Портал: код прохода загружен (v13: moveToken, v12: updateToken); журнал ${debugOn() ? 'ВКЛЮЧЁН' : 'выключен — настройка «Журнал Портала»'}`, 'color: #2f9bff');
});

/** Сводка для отладки: версия, порталы на сцене, выделенные токены, слушатели хуков */
export function portalReport() {
    const scene = canvas?.scene, size = scene?.grid?.size;
    const lines = [
        `Foundry ${game.release?.version ?? game.version} (поколение ${game.release?.generation ?? '?'}), dnd5e ${game.system?.version ?? '?'}`,
        `Пользователь: ${game.user.name}${game.user.isGM ? ' (Мастер)' : ''}, активный Мастер: ${game.users.activeGM?.name ?? 'нет'}${isActiveGM() ? ' — это вы' : ''}`,
        `Сцена: ${scene?.name ?? 'нет'}, клетка ${size}px`,
        `Хуки: updateToken ${Hooks.events?.updateToken?.length ?? '?'}, moveToken ${Hooks.events?.moveToken?.length ?? '?'}`
    ];
    for (const tile of scene?.tiles ?? []) {
        const flag = tile.flags?.[MODULE_ID]?.portal;
        if (flag) lines.push(`Портал ${flag.color} (${game.actors.get(flag.actorId)?.name ?? flag.actorId}): клетка ${cellOf(tile, size)}, x=${tile.x} y=${tile.y}`);
    }
    for (const token of canvas?.tokens?.controlled ?? []) {
        const doc = token.document;
        lines.push(`Токен ${doc.name}: клетка ${cellOf(doc, size)}, x=${doc.x} y=${doc.y}, ${doc.width}×${doc.height}, move() ${typeof doc.move === 'function' ? 'есть' : 'нет'}`);
    }
    console.log(`%c${MODULE_ID} | Портал — сводка\n${lines.join('\n')}`, 'color: #2f9bff');
    return lines;
}

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
            trace(`выстрел: ${color} в клетку ${k}`);
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
    trace(`Мастер ставит ${color} портал в ${x / size},${y / size}`);
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

Hooks.on('updateToken', (token, changes, options, userId) => {
    if (!('x' in changes || 'y' in changes)) return;
    trace(`updateToken ${token.name}: x=${changes.x ?? '—'} y=${changes.y ?? '—'}, от ${game.users?.get?.(userId)?.name ?? userId}, опции: ${Object.keys(options ?? {}).join(', ') || 'нет'}`);
    const scene = token.parent;
    const size = scene?.grid?.size;
    if (!size) return;
    const from = lastCell.get(token.id);
    const to = cellOf(token, size);
    lastCell.set(token.id, to);
    // v13+: проход ловит moveToken ниже — там видно, закончилось ли движение
    if (options?.gachadndPortal) return trace('  это сам перенос — пропуск');
    if (hasMovementApi(token)) return trace('  Foundry v13+: проход — по moveToken');
    if (!isActiveGM()) return trace('  в v12 переносит активный Мастер — не этот клиент');
    trace(`${token.name}: ${from ?? '?'} → ${to}`);
    passThrough(scene, token, from, to, size).catch(error => console.error(`${MODULE_ID} | Портал`, error));
});

// Foundry v13+: у токенов свой механизм движения (TokenDocument#move). Перестановка простым
// обновлением посреди движения встаёт в его очередь — поэтому перенос делает тот, кто двигал
// токен, когда движение закончено, перемещением «displace» (телепорт без анимации и без стен)
const hasMovementApi = token => typeof token?.move === 'function';

Hooks.on('moveToken', (token, movement, operation, user) => {
    trace(`moveToken ${token.name}: от ${user?.name ?? user?.id ?? user}, путь ${(movement?.passed?.waypoints ?? []).map(w => `${w.x},${w.y}:${w.action}`).join(' → ') || '—'}, осталось ${movement?.pending?.waypoints?.length ?? '?'}, метод ${movement?.method ?? '?'}`);
    if ((user?.id ?? user) !== game.user.id) trace('  перенос делает тот, кто двигал, — не этот клиент');
    if (operation?.gachadndPortal || (user?.id ?? user) !== game.user.id) return;
    // Перенос сам — тоже перемещение «displace»: его не ловить (кроме поворота Fez — он может
    // поставить существо прямо в портал)
    const displaced = [...(movement?.passed?.waypoints ?? []), ...(movement?.pending?.waypoints ?? [])].some(w => w.action === 'displace');
    if (displaced && !operation?.gachadndFez) return trace('  это перенос (displace) — пропуск');
    const scene = token.parent;
    const size = scene?.grid?.size;
    if (!size) return;
    if (movement?.pending?.waypoints?.length) return trace(`${token.name}: движение ещё не закончено`);
    // В момент moveToken документ ещё стоит в начале пути: конец пути — из самого движения.
    // Направление — по последнему шагу пути, а не от начала (путь мог петлять)
    const path = movement?.passed?.waypoints ?? [];
    const end = movement?.destination ?? path.at(-1);
    if (!end) return trace('  у движения нет конца пути');
    const before = path.length > 1 ? path.at(-2) : movement?.origin;
    const from = before ? cellOf(before, size) : lastCell.get(token.id);
    const to = cellOf(end, size);
    trace(`${token.name}: ${from ?? '?'} → ${to} (v13)`);
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
    const portals = [...scene.tiles].filter(t => t.flags?.[MODULE_ID]?.portal).map(t => `${t.flags[MODULE_ID].portal.color} ${cellOf(t, size)}`);
    trace(`  клетки токена ${cells.join(' ')}; порталы: ${portals.join(', ') || 'нет'}`);
    for (const tile of scene.tiles) {
        const flag = tile.flags?.[MODULE_ID]?.portal;
        if (!flag || !cells.includes(key(...cellOf(tile, size)))) continue;
        trace(`  вошёл в ${flag.color} портал`);
        const exit = portalsOf(scene, flag.actorId)[flag.color === 'blue' ? 'orange' : 'blue'];
        if (!exit) return trace(`${token.name}: второй портал не открыт`);
        const t0 = performance.now();
        await arrived(token, from, to);
        trace(`  доехал за ${Math.round(performance.now() - t0)} мс`);
        // Документ встаёт в конец пути не сразу (v13) — подождать его там; оказался в другой
        // клетке — его успели сдвинуть дальше, в портал он не вошёл
        const there = () => { const c = cellOf(token, size); return c[0] === to[0] && c[1] === to[1]; };
        for (let waited = 0; !there() && waited < 1500; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
        if (!there()) return trace(`${token.name}: ушёл с портала до прибытия (сейчас ${cellOf(token, size)})`);
        const [ex, ey] = cellOf(exit, size);
        // Направление движения: шаг по каждой оси; не знаем, откуда шёл — выход в любую свободную клетку
        const dx = from ? Math.sign(to[0] - from[0]) : 0, dy = from ? Math.sign(to[1] - from[1]) : 0;
        const portals = new Set([...scene.tiles].filter(t => t.flags?.[MODULE_ID]?.portal).map(t => key(...cellOf(t, size))));
        const taken = new Set([...occupied(scene, size, { except: [token.id] }), ...portals]);
        const spot = nearestFree(scene, size, token, ex + dx, ey + dy, taken);
        if (!spot) return trace(`${token.name}: у выхода нет свободной клетки`);
        lastCell.set(token.id, spot);
        trace(`${token.name}: ${to} → выход ${spot}`);
        const at = { x: spot[0] * size, y: spot[1] * size };
        try {
            if (hasMovementApi(token)) {
                const done = await token.move({ ...at, action: 'displace' }, {
                    gachadndPortal: true, autoRotate: false, showRuler: false,
                    constrainOptions: { ignoreWalls: true, ignoreCost: true }
                });
                trace(`  move(displace) → ${done}; токен теперь ${cellOf(token, size)}`);
            } else {
                token.object?.stopAnimation?.();
                await token.update(at, { gachadndPortal: true, animate: false });
                trace(`  update → токен теперь ${cellOf(token, size)}`);
            }
        } catch (error) {
            console.error(`${MODULE_ID} | Портал: перенос не удался`, error);
            trace(`  ОШИБКА переноса: ${error?.message ?? error}`);
        }
        return;
    }
    trace('  не в портале');
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
