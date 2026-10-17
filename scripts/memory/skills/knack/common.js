/**
 * Gacha Roguelike dnd5e — Навыки, закрывшие пустые редкости тегов: общее
 *
 * Навык — флаг knack: <вид> (firecracker, butcher, through, junk, transfusion, slowpoison, supernova).
 * Каждый вид — свой файл в этой папке. Здесь: поиск навыка, бой персонажа, цели игрока и карточка в чате.
 * Взрыв, расстояния и подавление штатной карточки dnd5e — из навыков огня и взрыва (blast/common.js).
 */

import { MODULE_ID } from "../../../core/constants.js";

export { ref, actorFrom, tokenOf, esc, quiet, dcOf, areaOf, around, blast, boom, boomAt, feetBetween, centerOf } from "../blast/common.js";
import { esc, feetBetween } from "../blast/common.js";

export const knackKind = item => item?.flags?.[MODULE_ID]?.knack ?? null;
export const isKnack = (item, kind) => knackKind(item) === kind && !item.flags[MODULE_ID].is_crystal_item;
/** Экипированный навык этого вида у персонажа */
export const knackSkill = (actor, kind) => actor?.items?.find(i => isKnack(i, kind) && i.flags[MODULE_ID].is_active) ?? null;

/** Начатый бой, в котором участвует персонаж */
export function combatOf(actor) {
    const combat = game.combat;
    return combat?.started && combat.combatants.some(c => c.actor?.id === actor?.id) ? combat : null;
}

/** ПЗ вместе с временными */
export const hpOf = actor => (Number(actor?.system?.attributes?.hp?.value) || 0) + (Number(actor?.system?.attributes?.hp?.temp) || 0);
export const alive = actor => (Number(actor?.system?.attributes?.hp?.value) || 0) > 0;

/**
 * Цели игрока (T) в пределах дальности от токена персонажа (футы, от края до края).
 * @returns {TokenDocument[]}
 */
export function targetsWithin(source, feet) {
    const reach = Math.max(0, feet - (source.parent.grid.distance || 5));
    return [...game.user.targets].map(t => t.document).filter(t => t.parent?.id === source.parent.id && t.id !== source.id && t.actor && feetBetween(source, t) <= reach);
}

/** Существа вплотную к токену (соседние клетки) */
export const adjacent = token => token.parent.tokens.filter(t => t.actor && !t.hidden && t.id !== token.id && feetBetween(token, t) === 0);

/** Атакующий из параметров dnd5e.applyDamage: сообщение лотка урона или навык модуля */
export function sourceOf(options = {}) {
    if (options.gachadndSource) return game.actors.get(options.gachadndSource) ?? null;
    let message = options.origin ?? options.originatingMessage ?? null;
    if (typeof message === 'string') message = game.messages.get(message);
    return message?.speaker ? ChatMessage.getSpeakerActor(message.speaker) : null;
}

/**
 * Карточка навыка в чате. Кнопки бросков — помощники dnd5e в тексте: [[/damage 12 poison]],
 * [[/save con 15]] — кнопки, которые жмут сами игроки и Мастер, как в карточке способности.
 */
export async function card(actor, title, html, { icon = 'fa-star', flags = {} } = {}) {
    const TextEditor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    const content = await TextEditor.enrichHTML(`<div class="gd-blast-card gd-knack-card"><div class="gd-blast-title"><i class="fas ${icon}"></i> ${esc(title)}</div>${html}</div>`,
        { rollData: actor?.getRollData?.() ?? {} });
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content, flags: { [MODULE_ID]: flags } });
}

/**
 * Карточка навыка dnd5e остаётся в чате (кнопки броска — у игроков); модуль убирает только постановку
 * шаблона: область вокруг персонажа он считает сам
 */
export function noTemplate(usage) {
    if (usage) usage.create = { ...(usage.create ?? {}), measuredTemplate: false };
}

/** Вернуть потраченный заряд (отказ, отмена выбора) */
export async function refund(item) {
    const spent = Number(item?.system?.uses?.spent) || 0;
    if (item && spent > 0) await item.update({ 'system.uses.spent': spent - 1 });
}
