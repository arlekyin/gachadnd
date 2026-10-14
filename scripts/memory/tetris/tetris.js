/**
 * Gacha Roguelike dnd5e — Тетрис (красный навык)
 *
 * В панели (tetris-panel.js) видны «Следующая» фигура и «Запас»; их можно поменять местами в любой
 * момент. Использование навыка — у игрока на сцене силуэт «Следующей»: колесо и R поворачивают,
 * клик обрушивает, правая кнопка и Esc отменяют (заряд возвращается).
 *
 * Обрушение выполняет Мастер:
 *   - четыре клетки фигуры становятся блоками (плитки сцены цвета фигуры) до конца боя;
 *   - существо под блоком выталкивается в ближайшую свободную клетку;
 *   - пять и больше блоков подряд по строке или столбцу — линия: она сгорает, а существа рядом
 *     с ней (в пределах 5 футов) становятся целями игрока — спасбросок и урон по карточке навыка.
 *
 * Труднопроходимость и полуукрытие блоков — по правилам за столом: в dnd5e для Foundry v12 нет
 * поведения региона «трудная местность», которое модуль мог бы включить.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { COLORS, findLines, shapeCells } from "./tetris-pieces.js";
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

/** Токены, которые задевает хотя бы одна клетка (клетки — верхние левые углы в пикселях) */
function tokensUnder(cells, tokens, size) {
    return tokens.filter(token => {
        const doc = token.document ?? token;
        const w = doc.width * size, h = doc.height * size;
        return cells.some(c => c.x < doc.x + w - 1 && c.x + size > doc.x + 1 && c.y < doc.y + h - 1 && c.y + size > doc.y + 1);
    });
}

async function placeFigure(actor, item, range) {
    const caster = actor.getActiveTokens()[0];
    if (!caster) return;
    let type = (await queueOf(actor)).next;
    let rot = 0, anchor = offsetOf(caster.center), inRange = true, current = [];
    const panel = await TetrisPanel.open(actor, { item, onSwap: queue => { type = queue.next; draw(); } });
    const preview = new PIXI.Graphics();
    preview.eventMode = 'none';
    canvas.controls.addChild(preview);
    const initialLayer = canvas.activeLayer;
    canvas.templates?.activate();
    const size = canvas.grid.size;
    const feet = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) / size * canvas.dimensions.distance;

    const draw = () => {
        current = shapeCells(type, rot).map(([x, y]) => topLeft(anchor.i + y, anchor.j + x));
        const center = { x: topLeft(anchor.i, anchor.j).x + size / 2, y: topLeft(anchor.i, anchor.j).y + size / 2 };
        inRange = feet(caster.center, center) <= range;
        const color = inRange ? Number.parseInt(COLORS[type].slice(1), 16) : 0xff4d4d;
        preview.clear();
        for (const c of current) preview.lineStyle(2, color, 0.95).beginFill(color, 0.3).drawRect(c.x + 2, c.y + 2, size - 4, size - 4).endFill();
        // Задетые существа — обводкой: их вытолкнет
        for (const token of tokensUnder(current, canvas.tokens.placeables.filter(t => t.visible), size)) {
            preview.lineStyle(3, 0xffffff, 0.9).drawRect(token.document.x, token.document.y, token.document.width * size, token.document.height * size);
        }
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
        if (!inRange) return ui.notifications.warn(`Слишком далеко: центр фигуры — не дальше ${range} футов.`);
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

const cellKey = (doc, size) => `${Math.round(doc.x / size)},${Math.round(doc.y / size)}`;

async function dropFigure({ actorId, sceneId, type, cells, userId }) {
    const scene = game.scenes.get(sceneId);
    const actor = game.actors.get(actorId);
    if (!scene || !cells?.length) return;
    const size = scene.grid.size;

    await scene.createEmbeddedDocuments('Tile', cells.map(c => ({
        texture: { src: BLOCK_SRC, tint: COLORS[type] ?? '#ffffff' }, x: c.x, y: c.y, width: size, height: size,
        flags: { [MODULE_ID]: { tetris: actorId } }
    })));

    // Задетые выталкиваются; занятые клетки — все блоки сцены и остальные токены
    const blockTiles = () => scene.tiles.filter(t => t.flags?.[MODULE_ID]?.tetris);
    const blocks = new Set(blockTiles().map(t => cellKey(t, size)));
    const crushed = tokensUnder(cells, [...scene.tokens], size);
    const taken = new Set();
    const footprint = (gx, gy, token) => {
        const out = [];
        for (let dx = 0; dx < token.width; dx++) for (let dy = 0; dy < token.height; dy++) out.push(`${gx + dx},${gy + dy}`);
        return out;
    };
    for (const token of scene.tokens) if (!crushed.includes(token)) footprint(Math.round(token.x / size), Math.round(token.y / size), token).forEach(k => taken.add(k));
    const moved = [];
    for (const token of crushed) {
        const spot = freeSpot(token, size, blocks, taken, scene);
        if (!spot) continue;
        footprint(spot.gx, spot.gy, token).forEach(k => taken.add(k));
        moved.push({ _id: token.id, x: spot.gx * size, y: spot.gy * size });
    }
    if (moved.length) await scene.updateEmbeddedDocuments('Token', moved);

    // Линии: блоки сгорают, существа рядом с ними — цели
    const burn = findLines(blocks);
    let victims = [];
    if (burn.size) {
        const near = new Set();
        for (const k of burn) {
            const [x, y] = k.split(',').map(Number);
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) near.add(`${x + dx},${y + dy}`);
        }
        const position = token => moved.find(m => m._id === token.id) ?? token;
        victims = scene.tokens.filter(token => footprint(Math.round(position(token).x / size), Math.round(position(token).y / size), token).some(k => near.has(k)));
        const flash = { sceneId, cells: [...burn].map(k => k.split(',').map(n => Number(n) * size)), size };
        emit('tetrisFlash', flash);
        playFlash(flash);
        await scene.deleteEmbeddedDocuments('Tile', blockTiles().filter(t => burn.has(cellKey(t, size))).map(t => t.id));
        const ids = victims.map(t => t.id);
        if (userId === game.user.id) game.user.updateTokenTargets?.(ids);
        else emit('tetrisTargets', { userId, ids });
    }

    const list = tokens => foundry.utils.escapeHTML?.(tokens.map(t => t.name).join(', ')) ?? tokens.map(t => t.name).join(', ');
    const lines = [
        `<strong>Тетрис</strong> — фигура обрушилась.`,
        crushed.length ? `Вытолкнуло: ${list(crushed)}.` : '',
        burn.size ? `<strong>Линия!</strong> Сгорело блоков: ${burn.size}. ${victims.length ? `Рядом: ${list(victims)} — цели спасброска Ловкости по карточке навыка.` : 'Рядом никого.'}` : ''
    ].filter(Boolean);
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="gd-tetris-card">${lines.join('<br>')}</div>` });
}

onSocket('tetrisTargets', ({ userId, ids }) => {
    if (userId === game.user.id) game.user.updateTokenTargets?.(ids);
});

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

// Вспышка сгоревшей линии у всех: белые клетки раздуваются и гаснут
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
