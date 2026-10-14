/**
 * Gacha Roguelike dnd5e — Тетрис (красный навык)
 *
 * В панели (tetris-panel.js) видны «Следующая» фигура и «Запас»; их можно поменять местами в любой
 * момент. Использование навыка — у игрока на сцене силуэт «Следующей»: колесо и R поворачивают,
 * клик обрушивает, правая кнопка и Esc отменяют (заряд возвращается).
 *
 * Фигуру нельзя положить на существо или на другой блок. Обрушение выполняет Мастер:
 *   - четыре клетки фигуры становятся блоками (плитки сцены цвета фигуры) до конца боя;
 *   - группа — всё, что связано с новой фигурой по сторонам клеток (без диагоналей) через блоки
 *     и существ. Если в ней не меньше двух врагов, она детонирует, как в Puyo Puyo: блоки группы
 *     исчезают, враги в ней становятся целями игрока — спасбросок и урон по карточке навыка.
 *     Союзники (то же отношение токена, что у персонажа) связывают группу, но не считаются и не задеваются.
 *
 * Труднопроходимость и полуукрытие блоков — по правилам за столом: в dnd5e для Foundry v12 нет
 * поведения региона «трудная местность», которое модуль мог бы включить.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { COLORS, ENEMIES_TO_BLAST, findGroup, shapeCells } from "./tetris-pieces.js";
import { TetrisPanel, queueOf, advanceQueue } from "./tetris-panel.js";

export const BLOCK_SRC = `modules/${MODULE_ID}/assets/tetris/block.svg`;
const isTetris = item => !!item?.flags?.[MODULE_ID]?.tetris;

export function openTetris(actor) {
    const skill = actor?.items.find(isTetris);
    if (!skill) return ui.notifications.warn('У персонажа нет навыка «Тетрис».');
    return TetrisPanel.open(actor, { item: skill });
}

// ==========================================
// ИСПОЛЬЗОВАНИЕ НАВЫКА
// ==========================================

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isTetris(item) || !item.actor) return;
    if (!canvas?.ready || !canvas.grid?.isSquare) {
        ui.notifications.warn('Тетрис ставится только на сцену с квадратной сеткой.');
        return false;
    }
    if (!item.actor.getActiveTokens?.()[0]) {
        ui.notifications.warn('Токена персонажа нет на сцене: фигуре не от кого отсчитывать дальность.');
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isTetris(item) || !item.actor) return;
    const range = Number(activity.range?.value ?? item.system.range?.value) || 60;
    placeFigure(item.actor, item, range);
});

// Панель открывается сама в начале боя у тех, кто управляет персонажем с Тетрисом
Hooks.on('updateCombat', (combat, changed) => {
    if (changed.round !== 1 || !combat.started) return;
    for (const combatant of combat.combatants) {
        const actor = combatant.actor;
        if (!actor?.isOwner || !actor.items.some(i => isTetris(i) && i.flags[MODULE_ID].is_active)) continue;
        // У Мастера — только для персонажей без игрока
        if (game.user.isGM && actor.hasPlayerOwner) continue;
        openTetris(actor);
    }
});

// ==========================================
// ПОСТАНОВКА НА СЦЕНЕ
// ==========================================

const offsetOf = point => canvas.grid.getOffset(point);
const topLeft = (i, j) => canvas.grid.getTopLeftPoint({ i, j });

const keyOf = (c, size) => `${Math.round(c.x / size)},${Math.round(c.y / size)}`;

/**
 * Поле для группы: клетки блоков, клетки под существами и кто из существ — враг персонажа.
 * @param {object[]} tiles   Документы плиток сцены.
 * @param {object[]} tokens  Документы токенов сцены.
 * @param {number} disposition  Отношение токена персонажа: такие же — союзники.
 */
function fieldOf(tiles, tokens, size, disposition) {
    const blocks = new Set(tiles.filter(t => t.flags?.[MODULE_ID]?.tetris).map(t => keyOf(t, size)));
    const creatures = new Map(), enemies = new Set();
    for (const token of tokens) {
        const gx = Math.round(token.x / size), gy = Math.round(token.y / size);
        for (let dx = 0; dx < (token.width || 1); dx++) for (let dy = 0; dy < (token.height || 1); dy++) creatures.set(`${gx + dx},${gy + dy}`, token.id);
        if (token.disposition !== disposition) enemies.add(token.id);
    }
    return { blocks, creatures, enemies };
}

/** Что будет при обрушении: можно ли, какая группа, кто в ней враг, детонирует ли */
function outcome(cells, field, size) {
    const keys = cells.map(c => keyOf(c, size));
    const free = keys.every(k => !field.blocks.has(k) && !field.creatures.has(k));
    const blocks = new Set([...field.blocks, ...keys]);
    const group = findGroup(keys, blocks, field.creatures);
    const victims = [...group.creatures].filter(id => field.enemies.has(id));
    return { free, keys, group, victims, blast: victims.length >= ENEMIES_TO_BLAST };
}

async function placeFigure(actor, item, range) {
    const caster = actor.getActiveTokens()[0];
    if (!caster) return;
    let type = (await queueOf(actor)).next;
    let rot = 0, anchor = offsetOf(caster.center), ok = true, current = [];
    const panel = await TetrisPanel.open(actor, { item, onSwap: queue => { type = queue.next; draw(); } });
    const preview = new PIXI.Graphics();
    preview.eventMode = 'none';
    canvas.controls.addChild(preview);
    const initialLayer = canvas.activeLayer;
    canvas.templates?.activate();
    const size = canvas.grid.size;
    const feet = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) / size * canvas.dimensions.distance;

    const disposition = caster.document.disposition;
    let field = null;
    const draw = () => {
        // Поле — видимые игроку токены и блоки сцены
        field ??= fieldOf([...canvas.scene.tiles], canvas.tokens.placeables.filter(t => t.visible).map(t => t.document), size, disposition);
        current = shapeCells(type, rot).map(([x, y]) => topLeft(anchor.i + y, anchor.j + x));
        const center = { x: topLeft(anchor.i, anchor.j).x + size / 2, y: topLeft(anchor.i, anchor.j).y + size / 2 };
        const result = outcome(current, field, size);
        ok = feet(caster.center, center) <= range && result.free;
        const color = ok ? Number.parseInt(COLORS[type].slice(1), 16) : 0xff4d4d;
        preview.clear();
        // Будущая детонация: вся группа подсвечена, враги в ней обведены
        if (ok && result.blast) {
            for (const k of result.group.cells) {
                const [x, y] = k.split(',').map(Number);
                preview.beginFill(0xffffff, 0.18).drawRect(x * size, y * size, size, size).endFill();
            }
            for (const token of canvas.tokens.placeables) {
                if (!result.victims.includes(token.document.id)) continue;
                preview.lineStyle(3, 0xffffff, 1).drawRect(token.document.x, token.document.y, token.document.width * size, token.document.height * size);
            }
        }
        for (const c of current) preview.lineStyle(2, color, 0.95).beginFill(color, 0.3).drawRect(c.x + 2, c.y + 2, size - 4, size - 4).endFill();
    };
    draw();

    const finish = () => {
        canvas.stage.off('mousemove', onMove);
        canvas.stage.off('mouseup', onConfirm);
        canvas.app.view.oncontextmenu = null;
        canvas.app.view.onwheel = null;
        document.removeEventListener('keydown', onKey, true);
        panel.onSwap = null;
        preview.destroy();
        initialLayer?.activate();
    };
    const onMove = event => {
        event.stopPropagation();
        const point = event.getLocalPosition ? event.getLocalPosition(canvas.stage) : event.data.getLocalPosition(canvas.stage);
        const next = offsetOf(point);
        if (next.i === anchor.i && next.j === anchor.j) return;
        anchor = next;
        draw();
    };
    const turn = dir => { rot = (rot + dir + 4) % 4; draw(); };
    const onWheel = event => {
        if (event.ctrlKey) event.preventDefault();
        event.stopPropagation();
        turn(Math.sign(event.deltaY) || 1);
    };
    const cancel = async () => {
        finish();
        // Заряд потрачен при использовании — отмена его возвращает
        const spent = Number(item.system.uses?.spent ?? 0);
        if (spent > 0) await item.update({ 'system.uses.spent': spent - 1 });
        panel.render();
        ui.notifications.info('Тетрис отменён, заряд возвращён.');
    };
    const onKey = event => {
        if (event.target?.closest?.('input, textarea, [contenteditable]')) return;
        if (event.code === 'KeyR') { turn(1); event.preventDefault(); event.stopPropagation(); }
        if (event.code === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    const onConfirm = async event => {
        if (event.button === 2 || (event.data?.button ?? 0) === 2) return;
        event.stopPropagation();
        if (!ok) return ui.notifications.warn(`Сюда нельзя: центр фигуры — не дальше ${range} футов, клетки — свободны от существ и блоков.`);
        finish();
        requestGM('tetrisDrop', { actorId: actor.id, sceneId: canvas.scene.id, type, cells: current.map(c => ({ x: c.x, y: c.y })) });
        await advanceQueue(actor);
    };

    canvas.stage.on('mousemove', onMove);
    canvas.stage.on('mouseup', onConfirm);
    canvas.app.view.oncontextmenu = cancel;
    canvas.app.view.onwheel = onWheel;
    document.addEventListener('keydown', onKey, true);
    ui.notifications.info('Тетрис: колесо или R — повернуть, клик — обрушить, правая кнопка или Esc — отмена.');
}

// ==========================================
// МАСТЕР: БЛОКИ, ВЫТАЛКИВАНИЕ, ЛИНИИ
// ==========================================

onSocket('tetrisDrop', ({ payload }) => {
    if (!isActiveGM()) return;
    dropFigure(payload).catch(error => console.error(`${MODULE_ID} | Тетрис`, error));
});

async function dropFigure({ actorId, sceneId, type, cells, userId }) {
    const scene = game.scenes.get(sceneId);
    const actor = game.actors.get(actorId);
    if (!scene || !cells?.length) return;
    const size = scene.grid.size;
    const caster = scene.tokens.find(t => t.actorId === actorId) ?? null;
    const before = fieldOf([...scene.tiles], [...scene.tokens], size, caster?.disposition ?? 1);
    const result = outcome(cells, before, size);
    // Клетки заняли, пока летел запрос
    if (!result.free) return ui.notifications.warn('Тетрис: клетки фигуры уже заняты — обрушение отменено.');

    await scene.createEmbeddedDocuments('Tile', cells.map(c => ({
        texture: { src: BLOCK_SRC, tint: COLORS[type] ?? '#ffffff' }, x: c.x, y: c.y, width: size, height: size,
        flags: { [MODULE_ID]: { tetris: actorId } }
    })));

    const names = ids => {
        const text = ids.map(id => scene.tokens.get(id)?.name ?? '?').join(', ');
        return foundry.utils.escapeHTML?.(text) ?? text;
    };
    let content = '<strong>Тетрис</strong> — фигура обрушилась.';
    if (result.blast) {
        // Детонация: блоки группы исчезают, враги в ней — цели
        // Вспыхивают блоки и враги группы; союзник в ней только связывал и не горит
        const burning = [...result.group.cells].filter(k => !before.creatures.has(k) || before.enemies.has(before.creatures.get(k)));
        const flash = { sceneId, cells: burning.map(k => k.split(',').map(n => Number(n) * size)), size };
        emit('tetrisFlash', flash);
        playFlash(flash);
        const groupBlocks = new Set([...result.group.cells].filter(k => !before.creatures.has(k)));
        const ids = [...scene.tiles].filter(t => t.flags?.[MODULE_ID]?.tetris && groupBlocks.has(keyOf(t, size))).map(t => t.id);
        if (ids.length) await scene.deleteEmbeddedDocuments('Tile', ids);
        if (userId === game.user.id) game.user.updateTokenTargets?.(result.victims);
        else emit('tetrisTargets', { userId, ids: result.victims });
        content += `<br><strong>Детонация!</strong> Сгорело блоков: ${ids.length}. В группе: ${names(result.victims)} — цели спасброска Ловкости по карточке навыка.`;
    } else if (result.victims.length) {
        content += `<br>Сцеплен ${names(result.victims)} — нужен ещё хотя бы один враг в группе.`;
    }
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="gd-tetris-card">${content}</div>` });
}

onSocket('tetrisTargets', ({ userId, ids }) => {
    if (userId === game.user.id) game.user.updateTokenTargets?.(ids);
});

// Вспышка детонации у всех: белые клетки раздуваются и гаснут
onSocket('tetrisFlash', data => playFlash(data));
function playFlash({ sceneId, cells, size }) {
    if (!canvas?.ready || canvas.scene?.id !== sceneId) return;
    const g = new PIXI.Graphics();
    g.eventMode = 'none';
    canvas.controls.addChild(g);
    const start = performance.now(), ms = 650;
    const frame = now => {
        const k = Math.min(1, (now - start) / ms);
        const grow = size * 0.25 * k, alpha = 1 - k * k;
        g.clear();
        for (const [x, y] of cells) {
            g.beginFill(0xffffff, 0.85 * alpha).drawRect(x - grow, y - grow, size + grow * 2, size + grow * 2).endFill();
        }
        if (k < 1) requestAnimationFrame(frame);
        else g.destroy();
    };
    requestAnimationFrame(frame);
}

/** Убрать все блоки Тетриса со сцены (или со всех сцен) */
export async function clearTetris(scene = null) {
    if (!game.user.isGM) return;
    for (const s of scene ? [scene] : game.scenes) {
        const ids = s.tiles.filter(t => t.flags?.[MODULE_ID]?.tetris).map(t => t.id);
        if (ids.length) await s.deleteEmbeddedDocuments('Tile', ids);
    }
}

// Конец боя — блоки осыпаются
Hooks.on('deleteCombat', combat => {
    if (!isActiveGM()) return;
    clearTetris(combat.scene ?? null).catch(error => console.error(`${MODULE_ID} | Тетрис`, error));
});
