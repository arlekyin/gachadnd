/**
 * Gacha Roguelike dnd5e — Тетрис (красный навык)
 *
 * Фигуру собирают в окне головоломки (tetris-window.js) в любое время. Использование навыка:
 *   - фигура не собрана — открывается окно, заряд не тратится;
 *   - собрана — после траты заряда у игрока на сцене появляется её силуэт: колесо и R поворачивают,
 *     клик ставит, правая кнопка и Esc отменяют (заряд возвращается).
 * Поставленную фигуру создаёт Мастер: каждая клетка — кристаллический блок (плитка сцены).
 * Существа под блоками выталкиваются в ближайшую свободную клетку и становятся целями игрока —
 * спасбросок и урон идут по карточке навыка, как у любого навыка со спасброском.
 *
 * На поле у персонажа не больше двух фигур: третья осыпает самую старую. Блоки держатся до конца
 * боя. Труднопроходимость и полуукрытие блоков — по правилам за столом: в dnd5e для Foundry v12 нет
 * поведения региона «трудная местность», которое модуль мог бы включить.
 */

import { MODULE_ID } from "../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { figure, SIZE } from "./tetris-puzzle.js";
import { TetrisWindow, solvedPuzzle, resetPuzzle } from "./tetris-window.js";

export const BLOCK_SRC = `modules/${MODULE_ID}/assets/tetris/block.svg`;
const MAX_FIGURES = 2;
const isTetris = item => !!item?.flags?.[MODULE_ID]?.puzzle;

export function openTetris(actor) {
    const skill = actor?.items.find(isTetris);
    if (!skill) return ui.notifications.warn('У персонажа нет навыка «Тетрис».');
    return TetrisWindow.open(actor, { item: skill });
}

// ==========================================
// ИСПОЛЬЗОВАНИЕ НАВЫКА
// ==========================================

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isTetris(item) || !item.actor) return;
    const actor = item.actor;
    if (!solvedPuzzle(actor)) {
        TetrisWindow.open(actor, { item });
        ui.notifications.info('Фигура не собрана: соберите её в окне Тетриса, затем используйте навык.');
        return false;
    }
    if (!canvas?.ready || !canvas.grid?.isSquare) {
        ui.notifications.warn('Тетрис ставится только на сцену с квадратной сеткой.');
        return false;
    }
    if (!actor.getActiveTokens?.()[0]) {
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

// Окно сборки открывается само в начале боя у тех, кто управляет персонажем с Тетрисом
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

// Клетки фигуры относительно её центра (центр поля 5×5), с поворотом
// Поворот — вокруг центра поля, а не вокруг угла: фигура не «прыгает» под курсором
function shape(puzzle, rot) {
    const half = (SIZE - 1) / 2;
    let out = figure(puzzle).map(([x, y]) => [x - half, y - half]);
    for (let i = 0; i < rot; i++) out = out.map(([x, y]) => [-y, x]);
    return out;
}

const offsetOf = point => canvas.grid.getOffset(point);
const topLeft = (i, j) => canvas.grid.getTopLeftPoint({ i, j });

/** Клетки сцены (верхние левые углы), занятые фигурой с центром в клетке anchor */
function worldCells(cells, anchor) {
    return cells.map(([x, y]) => topLeft(anchor.i + y, anchor.j + x));
}

/** Токены, которые задевает хотя бы одна клетка */
function tokensUnder(cells, tokens) {
    const size = canvas.grid.size;
    return tokens.filter(token => {
        const doc = token.document ?? token;
        const w = doc.width * size, h = doc.height * size;
        return cells.some(c => c.x < doc.x + w - 1 && c.x + size > doc.x + 1 && c.y < doc.y + h - 1 && c.y + size > doc.y + 1);
    });
}

async function placeFigure(actor, item, range) {
    const puzzle = solvedPuzzle(actor);
    const caster = actor.getActiveTokens()[0];
    if (!puzzle || !caster) return;
    let rot = 0, anchor = offsetOf(caster.center), inRange = true, current = [];
    const preview = new PIXI.Graphics();
    preview.eventMode = 'none';
    canvas.controls.addChild(preview);
    const initialLayer = canvas.activeLayer;
    canvas.templates?.activate();
    const size = canvas.grid.size;
    const feet = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) / size * canvas.dimensions.distance;

    const draw = () => {
        current = worldCells(shape(puzzle, rot), anchor);
        const center = { x: topLeft(anchor.i, anchor.j).x + size / 2, y: topLeft(anchor.i, anchor.j).y + size / 2 };
        inRange = feet(caster.center, center) <= range;
        const crushed = new Set(tokensUnder(current, canvas.tokens.placeables.filter(t => t.visible)).map(t => t.document.id));
        const color = inRange ? 0xffd43b : 0xff4d4d;
        preview.clear();
        for (const c of current) {
            preview.lineStyle(2, color, 0.95).beginFill(color, 0.28).drawRect(c.x + 2, c.y + 2, size - 4, size - 4).endFill();
        }
        // Задетые существа — обводкой: их вытолкнет, они станут целями
        for (const token of canvas.tokens.placeables) {
            if (!crushed.has(token.document.id)) continue;
            preview.lineStyle(3, 0xff8a4c, 1).drawRect(token.document.x, token.document.y, token.document.width * size, token.document.height * size);
        }
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
        if (!inRange) return ui.notifications.warn(`Слишком далеко: центр фигуры — не дальше ${range} футов.`);
        finish();
        const cells = current.map(c => ({ x: c.x, y: c.y }));
        const crushed = tokensUnder(cells, canvas.tokens.placeables).map(t => t.document.id);
        // Задетые — цели: спасбросок и урон по карточке навыка идут по ним
        game.user.updateTokenTargets?.(crushed);
        requestGM('tetrisDrop', { actorId: actor.id, sceneId: canvas.scene.id, cells });
        await resetPuzzle(actor);
    };

    canvas.stage.on('mousemove', onMove);
    canvas.stage.on('mouseup', onConfirm);
    canvas.app.view.oncontextmenu = cancel;
    canvas.app.view.onwheel = onWheel;
    document.addEventListener('keydown', onKey, true);
    ui.notifications.info('Тетрис: колесо или R — повернуть, клик — обрушить, правая кнопка или Esc — отмена.');
}

// ==========================================
// МАСТЕР: БЛОКИ, ВЫТАЛКИВАНИЕ, УБОРКА
// ==========================================

onSocket('tetrisDrop', ({ payload }) => {
    if (!isActiveGM()) return;
    dropFigure(payload).catch(error => console.error(`${MODULE_ID} | Тетрис`, error));
});

async function dropFigure({ actorId, sceneId, cells }) {
    const scene = game.scenes.get(sceneId);
    const actor = game.actors.get(actorId);
    if (!scene || !cells?.length) return;
    const size = scene.grid.size;
    const figures = foundry.utils.deepClone(scene.getFlag(MODULE_ID, 'tetris') ?? {});

    // Третья фигура осыпает самую старую
    const own = Object.entries(figures).filter(([, f]) => f.actorId === actorId).sort((a, b) => a[1].at - b[1].at);
    while (own.length >= MAX_FIGURES) {
        const [id] = own.shift();
        await removeFigure(scene, id);
        delete figures[id];
    }

    const figureId = foundry.utils.randomID();
    const tiles = await scene.createEmbeddedDocuments('Tile', cells.map(c => ({
        texture: { src: BLOCK_SRC }, x: c.x, y: c.y, width: size, height: size,
        flags: { [MODULE_ID]: { tetris: figureId } }
    })));
    await scene.setFlag(MODULE_ID, `tetris.${figureId}`, { actorId, at: Date.now(), tiles: tiles.map(t => t.id) });

    // Все блоки сцены, включая старые фигуры: выталкивать в них нельзя
    const blocks = new Set(scene.tiles.filter(t => t.flags?.[MODULE_ID]?.tetris).map(t => `${Math.round(t.x / size)},${Math.round(t.y / size)}`));
    const crushed = scene.tokens.filter(token => cells.some(c => c.x < token.x + token.width * size - 1 && c.x + size > token.x + 1 && c.y < token.y + token.height * size - 1 && c.y + size > token.y + 1));
    const moved = [];
    const taken = new Set();
    for (const token of scene.tokens) {
        if (crushed.includes(token)) continue;
        for (let dx = 0; dx < token.width; dx++) for (let dy = 0; dy < token.height; dy++) taken.add(`${Math.round(token.x / size) + dx},${Math.round(token.y / size) + dy}`);
    }
    for (const token of crushed) {
        const spot = freeSpot(token, size, blocks, taken, scene);
        if (!spot) continue;
        for (let dx = 0; dx < token.width; dx++) for (let dy = 0; dy < token.height; dy++) taken.add(`${spot.gx + dx},${spot.gy + dy}`);
        moved.push({ _id: token.id, x: spot.gx * size, y: spot.gy * size });
    }
    if (moved.length) await scene.updateEmbeddedDocuments('Token', moved);

    const names = crushed.map(t => t.name).join(', ');
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-tetris-card"><strong>Тетрис</strong> — фигура обрушилась: ${cells.length} блоков.`
            + (crushed.length ? `<br>Под блоками: ${foundry.utils.escapeHTML?.(names) ?? names}. Их вытолкнуло, они — цели спасброска Ловкости по карточке навыка.` : '<br>Никого не задело.')
            + '</div>'
    });
}

// Ближайшее место для токена вне блоков и других токенов: по кольцам вокруг его клетки
function freeSpot(token, size, blocks, taken, scene) {
    const gx = Math.round(token.x / size), gy = Math.round(token.y / size);
    const maxX = Math.floor(scene.dimensions.width / size), maxY = Math.floor(scene.dimensions.height / size);
    const fits = (x, y) => {
        for (let dx = 0; dx < token.width; dx++) for (let dy = 0; dy < token.height; dy++) {
            const k = `${x + dx},${y + dy}`;
            if (x + dx < 0 || y + dy < 0 || x + dx >= maxX || y + dy >= maxY || blocks.has(k) || taken.has(k)) return false;
        }
        return true;
    };
    for (let r = 1; r <= 12; r++) {
        const ring = [];
        for (let x = gx - r; x <= gx + r; x++) for (let y = gy - r; y <= gy + r; y++) {
            if (Math.max(Math.abs(x - gx), Math.abs(y - gy)) === r && fits(x, y)) ring.push({ gx: x, gy: y, d: Math.hypot(x - gx, y - gy) });
        }
        if (ring.length) return ring.sort((a, b) => a.d - b.d)[0];
    }
    return null;
}

async function removeFigure(scene, figureId) {
    const ids = scene.tiles.filter(t => t.flags?.[MODULE_ID]?.tetris === figureId).map(t => t.id);
    if (ids.length) await scene.deleteEmbeddedDocuments('Tile', ids);
    await scene.unsetFlag(MODULE_ID, `tetris.${figureId}`);
}

/** Убрать все фигуры Тетриса со сцены (или со всех сцен) */
export async function clearTetris(scene = null) {
    if (!game.user.isGM) return;
    for (const s of scene ? [scene] : game.scenes) {
        const ids = s.tiles.filter(t => t.flags?.[MODULE_ID]?.tetris).map(t => t.id);
        if (ids.length) await s.deleteEmbeddedDocuments('Tile', ids);
        if (s.getFlag(MODULE_ID, 'tetris')) await s.unsetFlag(MODULE_ID, 'tetris');
    }
}

// Конец боя — блоки осыпаются
Hooks.on('deleteCombat', combat => {
    if (!isActiveGM()) return;
    clearTetris(combat.scene ?? null).catch(error => console.error(`${MODULE_ID} | Тетрис`, error));
});
