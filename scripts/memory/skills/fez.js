/**
 * Gacha Roguelike dnd5e — Fez (красный навык)
 *
 * Как в игре Fez, мир поворачивается на 90°: все существа в пределах дальности навыка (по сетке, как
 * в dnd5e) поворачиваются вокруг персонажа. Использование — призраки на местах назначения: колесо
 * и R меняют направление, клик поворачивает, правая кнопка и Esc отменяют (заряд возвращается).
 *
 * Существо остаётся на месте, если его клетка назначения за краем сцены или занята (блоком,
 * существом, которое не поворачивается) или если между персонажем и ним — или его новым местом —
 * стена. Это не передвижение: атак по возможности нет.
 *
 * У всех карта плавно поворачивается вокруг персонажа, вспышка — и карта на месте, а существа
 * уже стоят по-новому. Мастер переставляет токены в момент вспышки.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { stageCamera } from "../../cutscene/camera.js";
import { clamp01, easeInOut } from "../../cutscene/math.js";
import { footprint, occupied, inside, wallBetween } from "./grid.js";

const SPIN_MS = 900, FLASH_MS = 320;
const isFez = item => !!item?.flags?.[MODULE_ID]?.fez;

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isFez(item) || !item.actor) return;
    if (!canvas?.ready || !canvas.grid?.isSquare) {
        ui.notifications.warn('Fez работает только на сцене с квадратной сеткой.');
        return false;
    }
    if (!item.actor.getActiveTokens?.()[0]) {
        ui.notifications.warn('Токена персонажа нет на сцене: миру не вокруг кого поворачиваться.');
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isFez(item) || !item.actor) return;
    const range = Number(activity.range?.value ?? item.system.range?.value) || 20;
    chooseTurn(item.actor, item, range);
});

// ==========================================
// ПОВОРОТ: КТО КУДА
// ==========================================

/**
 * Перестановки поворота. dir: 1 — по часовой, −1 — против.
 * @param {object[]} tokens  Документы токенов, которые учитываются (у игрока — видимые).
 * @returns {{id, x, y, from: {x, y}, ok: boolean}[]}  x, y — новый верхний левый угол в пикселях.
 */
export function plan(scene, size, caster, tokens, range, dir, { walls = true } = {}) {
    const distance = scene.grid?.distance ?? canvas?.dimensions?.distance ?? 5;
    const cx = caster.x + (caster.width || 1) * size / 2, cy = caster.y + (caster.height || 1) * size / 2;
    // По сетке, как в dnd5e: шаг по диагонали — тоже 5 футов
    const near = tokens.filter(t => t.id !== caster.id && Math.max(
        Math.abs(t.x + (t.width || 1) * size / 2 - cx), Math.abs(t.y + (t.height || 1) * size / 2 - cy)
    ) - ((t.width || 1) - 1) * size / 2 <= range / distance * size + 1);
    // Кто не может повернуться, остаётся и занимает свои клетки: пересчёт, пока таких не прибавится
    const stay = new Set();
    let moves = [];
    for (let pass = 0; pass < near.length + 1; pass++) {
        const taken = occupied(scene, size, { except: near.filter(t => !stay.has(t.id)).map(t => t.id) });
        moves = [];
        let changed = false;
        for (const t of near) {
            const w = (t.width || 1) * size, h = (t.height || 1) * size;
            const origin = { x: t.x + w / 2, y: t.y + h / 2 };
            if (stay.has(t.id)) { moves.push({ id: t.id, x: t.x, y: t.y, from: { x: t.x, y: t.y }, ok: false }); continue; }
            // Поворот на 90°: по часовой (ось y вниз) — (x, y) → (−y, x)
            const tx = origin.x - cx, ty = origin.y - cy;
            const nx = dir > 0 ? -ty : ty, ny = dir > 0 ? tx : -tx;
            const gx = Math.round((cx + nx - w / 2) / size), gy = Math.round((cy + ny - h / 2) / size);
            const cells = footprint(t, gx, gy);
            const target = { x: gx * size + w / 2, y: gy * size + h / 2 };
            const ok = inside(scene, size, t, gx, gy) && cells.every(k => !taken.has(k))
                && !(walls && (wallBetween({ x: cx, y: cy }, origin) || wallBetween({ x: cx, y: cy }, target)));
            if (!ok) { stay.add(t.id); changed = true; }
            else cells.forEach(k => taken.add(k));
            moves.push({ id: t.id, x: gx * size, y: gy * size, from: { x: t.x, y: t.y }, ok });
        }
        if (!changed) break;
    }
    return moves;
}

function chooseTurn(actor, item, range) {
    const caster = actor.getActiveTokens()[0];
    const scene = canvas.scene, size = canvas.grid.size;
    let dir = 1, moves = [];
    const preview = new PIXI.Graphics();
    preview.eventMode = 'none';
    canvas.controls.addChild(preview);
    const initialLayer = canvas.activeLayer;
    canvas.templates?.activate();
    const visible = canvas.tokens.placeables.filter(t => t.visible).map(t => t.document);

    const draw = () => {
        moves = plan(scene, size, caster.document, visible, range, dir);
        const c = caster.center;
        preview.clear();
        // Граница поворота и стрелка направления
        const r = range / canvas.dimensions.distance * size + size / 2;
        preview.lineStyle(2, 0xb48cff, 0.7).drawRect(c.x - r, c.y - r, r * 2, r * 2);
        const a0 = -Math.PI / 2, a1 = a0 + dir * Math.PI / 2;
        preview.lineStyle(4, 0xb48cff, 0.9).arc(c.x, c.y, r * 0.55, Math.min(a0, a1), Math.max(a0, a1));
        const tip = { x: c.x + Math.cos(a1) * r * 0.55, y: c.y + Math.sin(a1) * r * 0.55 };
        preview.beginFill(0xb48cff, 0.9).drawCircle(tip.x, tip.y, 7).endFill();
        for (const m of moves) {
            const doc = visible.find(t => t.id === m.id);
            const w = (doc.width || 1) * size, h = (doc.height || 1) * size;
            if (!m.ok) {
                preview.lineStyle(3, 0xff4d4d, 0.9).drawRect(m.from.x + 3, m.from.y + 3, w - 6, h - 6);
                continue;
            }
            preview.lineStyle(2, 0xffffff, 0.5).moveTo(m.from.x + w / 2, m.from.y + h / 2).lineTo(m.x + w / 2, m.y + h / 2);
            preview.lineStyle(3, 0xb48cff, 1).beginFill(0xb48cff, 0.25).drawEllipse(m.x + w / 2, m.y + h / 2, w * 0.42, h * 0.42).endFill();
        }
    };
    draw();

    const finish = () => {
        canvas.stage.off('mouseup', onConfirm);
        canvas.app.view.oncontextmenu = null;
        canvas.app.view.onwheel = null;
        document.removeEventListener('keydown', onKey, true);
        preview.destroy();
        initialLayer?.activate();
    };
    const turn = () => { dir = -dir; draw(); };
    const onWheel = event => {
        if (event.ctrlKey) event.preventDefault();
        event.stopPropagation();
        turn();
    };
    const cancel = async () => {
        finish();
        const spent = Number(item.system.uses?.spent ?? 0);
        if (spent > 0) await item.update({ 'system.uses.spent': spent - 1 });
        ui.notifications.info('Fez отменён, заряд возвращён.');
    };
    const onKey = event => {
        if (event.target?.closest?.('input, textarea, [contenteditable]')) return;
        if (event.code === 'KeyR') { turn(); event.preventDefault(); event.stopPropagation(); }
        if (event.code === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    const onConfirm = event => {
        if (event.button === 2 || (event.data?.button ?? 0) === 2) return;
        event.stopPropagation();
        finish();
        requestGM('fezTurn', { sceneId: scene.id, casterId: caster.document.id, range, dir, ids: moves.filter(m => m.ok).map(m => m.id) });
    };

    canvas.stage.on('mouseup', onConfirm);
    canvas.app.view.oncontextmenu = cancel;
    canvas.app.view.onwheel = onWheel;
    document.addEventListener('keydown', onKey, true);
    ui.notifications.info('Fez: колесо или R — сменить направление, клик — повернуть мир, правая кнопка или Esc — отмена.');
}

// ==========================================
// МАСТЕР: ПЕРЕСТАНОВКА
// ==========================================

onSocket('fezTurn', ({ payload }) => {
    if (!isActiveGM()) return;
    turnWorld(payload).catch(error => console.error(`${MODULE_ID} | Fez`, error));
});

async function turnWorld({ sceneId, casterId, range, dir, ids }) {
    const scene = game.scenes.get(sceneId);
    const caster = scene?.tokens.get(casterId);
    if (!caster) return;
    const size = scene.grid.size;
    // Заново, по всем токенам (у игрока могли быть невидимые); поворачиваются те, кого видел игрок
    const moves = plan(scene, size, caster, [...scene.tokens], range, dir).filter(m => m.ok && ids.includes(m.id));
    const center = { x: caster.x + (caster.width || 1) * size / 2, y: caster.y + (caster.height || 1) * size / 2 };
    const spin = { sceneId, center, dir };
    emit('fezSpin', spin);
    playSpin(spin);
    await new Promise(resolve => setTimeout(resolve, spinTime()));
    if (moves.length) await scene.updateEmbeddedDocuments('Token', moves.map(m => ({ _id: m.id, x: m.x, y: m.y })), { animate: false });
    const names = moves.map(m => scene.tokens.get(m.id)?.name).filter(Boolean).join(', ');
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token: caster }),
        content: `<div class="gd-fez-card"><strong>Fez</strong> — мир повернулся ${dir > 0 ? 'по часовой' : 'против часовой'}. ${names ? `Сменили место: ${foundry.utils.escapeHTML?.(names) ?? names}.` : 'Никто не сдвинулся.'}</div>`
    });
}

// ==========================================
// ПОВОРОТ КАРТЫ У ВСЕХ
// ==========================================

const frames = () => { try { return game.settings.get(MODULE_ID, 'impactFrames') !== false; } catch (error) { return true; } };
const calm = () => { try { return !!game.settings.get(MODULE_ID, 'impactCalm'); } catch (error) { return false; } };
// Когда Мастер переставляет токены: в середине вспышки; без анимаций — сразу
const spinTime = () => frames() ? (calm() ? 0 : SPIN_MS) + FLASH_MS / 2 : 0;

onSocket('fezSpin', data => playSpin(data));

/** Карта поворачивается вокруг center на 90°, вспышка, карта на месте */
export function playSpin({ sceneId, center, dir }) {
    if (!frames() || !canvas?.ready || canvas.scene?.id !== sceneId) return Promise.resolve();
    const camera = stageCamera();
    if (!camera) return Promise.resolve();
    const turnMs = calm() ? 0 : SPIN_MS;
    return new Promise(resolve => {
        const start = performance.now();
        const step = now => {
            const k = easeInOut(clamp01((now - start) / Math.max(1, turnMs)));
            if (turnMs) camera.place({ k, center, rot: dir * Math.PI / 2 });
            if (now - start < turnMs) return requestAnimationFrame(step);
            flash(() => camera.restore()).then(resolve);
        };
        requestAnimationFrame(step);
    });
}

// Белая вспышка поверх экрана; в её пике — after()
function flash(after) {
    const el = document.createElement('div');
    el.className = 'gd-fez-flash';
    document.body.append(el);
    const half = FLASH_MS / 2;
    return el.animate([{ opacity: 0 }, { opacity: calm() ? 0.5 : 0.9 }], { duration: half, easing: 'ease-in', fill: 'forwards' }).finished
        .then(() => { after(); return el.animate([{ opacity: calm() ? 0.5 : 0.9 }, { opacity: 0 }], { duration: half, easing: 'ease-out', fill: 'forwards' }).finished; })
        .catch(() => after())
        .finally(() => el.remove());
}
