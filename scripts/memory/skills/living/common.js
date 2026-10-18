/**
 * Gacha Roguelike dnd5e — Живые навыки: общее
 *
 * Живой навык (флаг living: <вид>) ведёт счётчик — флаг counter на навыке: зарубки, провалы, убийства.
 * Число видно в Терминале и значком на токене (badges.js). Каждый вид — свой файл в этой папке.
 * Двойные навыки (флаг duo: [тег, тег]) — тоже живые: выпадают, только если у кого-то в отряде в Памяти
 * есть навыки обоих тегов (memory/crystals.js → lootable).
 *
 * Счётчик меняет владелец навыка или Мастер: события, которые видит только Мастер (убийство, урон),
 * идут через сокет livingCounter.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { isAwake, updateActorSynergies } from "../../synergy/synergy.js";
import { HOOKS } from "../../memory-api.js";

export { ref, actorFrom, tokenOf, esc, quiet, dcOf, damageOf, around, inCircle, blast, boom, boomAt, feetBetween, centerOf, feetToPx, isDead } from "../blast/common.js";
export { sourceOf, combatOf } from "../knack/common.js";

export const livingKind = item => item?.flags?.[MODULE_ID]?.living ?? null;
export const isLiving = (item, kind) => livingKind(item) === kind && !item.flags[MODULE_ID].is_crystal_item;
/** Действующий (экипирован, не спит) живой навык этого вида у персонажа */
export const livingSkill = (actor, kind) => actor?.items?.find(i => isLiving(i, kind) && isAwake(i)) ?? null;

export const counterOf = item => Number(item?.flags?.[MODULE_ID]?.counter) || 0;
/** Предел счётчика на текущем ранге навыка */
export const counterMax = (item, fallback) => item?.flags?.[MODULE_ID]?.living_max_by_rank?.[(item.flags[MODULE_ID].rank ?? 1) - 1] ?? fallback;

/** Счётчик навыка: у владельца или Мастера — сразу, у прочих — просьбой Мастеру */
export async function setCounter(item, value) {
    if (!item) return;
    if (item.isOwner) return item.setFlag(MODULE_ID, 'counter', value);
    requestGM('livingCounter', { actorId: item.actor?.id, itemId: item.id, value });
}
onSocket('livingCounter', ({ payload }) => {
    if (!isActiveGM()) return;
    const item = game.actors.get(payload.actorId)?.items.get(payload.itemId);
    if (item) item.setFlag(MODULE_ID, 'counter', payload.value).catch(error => console.error(`${MODULE_ID} | счётчик`, error));
});

/** Пользователь, который отвечает за персонажа: игрок-владелец в сети, иначе Мастер */
export function responder(actor) {
    const owner = game.users.find(u => u.active && !u.isGM && actor?.testUserPermission(u, 'OWNER'));
    return owner ?? game.users.activeGM ?? null;
}

/** Строка навыка в чат: короткая карточка от лица персонажа */
export function note(actor, title, html, icon = 'fa-star') {
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-blast-card gd-living-card"><div class="gd-blast-title"><i class="fas ${icon}"></i> ${title}</div>${html}</div>`
    });
}

/**
 * Усыпить навык: занимает слот, но не действует. data — когда проснётся ({ combatId, reason, … }).
 * Мастер: навыки персонажей игроков.
 */
export async function sleepSkill(item, data) {
    await item.setFlag(MODULE_ID, 'asleep', data);
    await updateActorSynergies(item.actor);
}
export async function wakeSkill(item) {
    if (!item?.flags?.[MODULE_ID]?.asleep) return;
    await item.unsetFlag(MODULE_ID, 'asleep');
    await updateActorSynergies(item.actor);
}

// Терминал: счётчик живого навыка и пометка двойного
const LABELS = { hone: 'зарубки', third: 'провалы подряд', ember: 'убито огнём' };
Hooks.on(HOOKS.terminalSkillView, (item, view) => {
    const flags = item.flags?.[MODULE_ID] ?? {};
    const kind = flags.living;
    if (LABELS[kind]) {
        const max = kind === 'hone' ? counterMax(item, 4) : kind === 'third' ? 2 : null;
        view.notes.push({ cls: 'gd-living-note', text: `◆ ${LABELS[kind]}: ${counterOf(item)}${max ? ` / ${max}` : ''}` });
    }
    if (flags.duo) view.notes.push({ cls: 'gd-living-note', text: `◆ двойной навык: ${flags.duo.join(' + ')}` });
    if (flags.asleep) view.notes.push({ cls: 'gd-living-note asleep', text: `☾ спит — ${flags.asleep.reason ?? 'до конца боя'}` });
});

// Спящий навык не используется
Hooks.on('dnd5e.preUseActivity', activity => {
    const item = activity?.item;
    const sleep = item?.flags?.[MODULE_ID]?.asleep;
    if (!sleep || item.flags[MODULE_ID].is_crystal_item) return;
    ui.notifications.warn(`${item.name} спит — ${sleep.reason ?? 'до конца боя'}.`);
    return false;
});
