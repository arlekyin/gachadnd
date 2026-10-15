/**
 * Gacha Roguelike dnd5e — Выбор клетки на сцене для навыков
 *
 * Силуэт под курсором, клик — выбрать, правая кнопка или Esc — отмена. Как у шаблонов dnd5e:
 * на время выбора активен слой шаблонов, чтобы клик не выделял токены.
 */

import { key, cellOf } from "./grid.js";

/**
 * @param {object} o
 * @param {Token} o.caster            Токен персонажа (от него — дальность).
 * @param {number} o.range            Дальность в футах.
 * @param {(cell: number[]) => boolean} [o.allowed]  Можно ли выбрать клетку (кроме дальности).
 * @param {(g: PIXI.Graphics, cell: number[], ok: boolean, size: number) => void} o.draw  Рисунок силуэта.
 * @param {string} [o.hint]           Подсказка при начале выбора.
 * @returns {Promise<number[]|null>}  Клетка [x, y] или null при отмене.
 */
export function pickCell({ caster, range, allowed = () => true, draw, hint }) {
    const size = canvas.grid.size;
    let cell = cellOf(caster.document, size), ok = false;
    const preview = new PIXI.Graphics();
    preview.eventMode = 'none';
    canvas.controls.addChild(preview);
    const initialLayer = canvas.activeLayer;
    canvas.templates?.activate();

    const paint = () => {
        const center = { x: cell[0] * size + size / 2, y: cell[1] * size + size / 2 };
        const feet = Math.hypot(center.x - caster.center.x, center.y - caster.center.y) / size * canvas.dimensions.distance;
        ok = feet <= range + 0.01 && allowed(cell);
        preview.clear();
        draw(preview, cell, ok, size);
    };
    paint();
    if (hint) ui.notifications.info(hint);

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
            const point = event.getLocalPosition ? event.getLocalPosition(canvas.stage) : event.data.getLocalPosition(canvas.stage);
            const next = [Math.floor(point.x / size), Math.floor(point.y / size)];
            if (key(...next) === key(...cell)) return;
            cell = next;
            paint();
        };
        const onConfirm = event => {
            if ((event.button ?? event.data?.button ?? 0) !== 0) return;
            event.stopPropagation();
            if (!ok) return ui.notifications.warn(`Сюда нельзя: свободная клетка не дальше ${range} футов.`);
            finish(cell);
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

/** Перестановка токена без анимации: в v13+ — перемещение «displace», в v12 — обновление */
export function placeToken(token, x, y, options = {}) {
    if (typeof token.move === 'function') {
        return token.move({ x, y, action: 'displace' }, {
            autoRotate: false, showRuler: false, constrainOptions: { ignoreWalls: true, ignoreCost: true }, ...options
        });
    }
    token.object?.stopAnimation?.();
    return token.update({ x, y }, { animate: false, ...options });
}
