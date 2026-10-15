/**
 * Gacha Roguelike dnd5e — Навыки света: общее
 *
 * Навык света — флаг light: <вид> (ultraviolet, speed, prism, battery, ...). Каждый вид — свой файл
 * в этой папке. Здесь: поиск навыка, токен и ссылка на персонажа для сокета, расстояния, яркий свет
 * и карточка в чате.
 */

import { MODULE_ID } from "../../../core/constants.js";

export const lightKind = item => item?.flags?.[MODULE_ID]?.light ?? null;
export const isLight = (item, kind) => lightKind(item) === kind && !item.flags[MODULE_ID].is_crystal_item;
/** Экипированный навык света этого вида у персонажа */
export const lightSkill = (actor, kind) => actor?.items?.find(i => isLight(i, kind) && i.flags[MODULE_ID].is_active) ?? null;

export const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '');

/** Токен персонажа на текущей сцене */
export const tokenOf = actor => actor?.getActiveTokens?.()[0] ?? null;

/** Ссылка на персонажа для сокета: { actorId, tokenId, sceneId } */
export function ref(actor) {
    const token = tokenOf(actor);
    return { actorId: actor.id, tokenId: token?.document?.id ?? null, sceneId: token?.document?.parent?.id ?? canvas?.scene?.id ?? null };
}
export function actorFrom({ actorId, tokenId, sceneId }) {
    const token = tokenId ? game.scenes.get(sceneId)?.tokens.get(tokenId) : null;
    return token?.actor ?? game.actors.get(actorId);
}

/** Футы в пиксели сцены */
export function feetToPx(feet, scene = canvas.scene) {
    return feet / (scene?.grid?.distance || 5) * (scene?.grid?.size || 100);
}

/** Центр токена (документа) в пикселях */
export function centerOf(doc) {
    const size = doc.parent?.grid?.size ?? canvas.grid.size;
    return { x: doc.x + (doc.width || 1) * size / 2, y: doc.y + (doc.height || 1) * size / 2, elevation: doc.elevation ?? 0 };
}

/** Расстояние от точки до отрезка [a, b] в пикселях */
export function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Яркий свет в точке на текущей сцене: глобальное освещение (если оно горит при этой темноте) или
 * яркий радиус источника света, до которого доходит луч (форма источника учитывает стены).
 */
export function inBrightLight(point) {
    const effects = canvas?.effects;
    if (!effects) return false;
    const lit = effects.testInsideLight(point, {
        condition: source => {
            if (source === canvas.environment?.globalLightSource) return true;
            const bright = Number(source.data?.bright) || 0;
            const origin = source.origin ?? source.data ?? {};
            return bright > 0 && Math.hypot(point.x - origin.x, point.y - origin.y) <= bright;
        }
    });
    return lit && !effects.testInsideDarkness?.(point);
}

/** Карточка навыка света в чате */
export function lightCard(actor, title, body, { icon = 'fa-sun', cls = '' } = {}) {
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-light-card ${cls}"><div class="gd-light-title"><i class="fas ${icon}"></i> ${esc(title)}</div>${body}</div>`
    });
}
