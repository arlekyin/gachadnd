/**
 * Gacha Roguelike dnd5e — Шрамы (флаг scar: <вид>)
 *
 * Шрам — не кристалл и не навык на выбор: его кладёт в Память враг, событие или Пожиратель (grantScar).
 * Шрам сразу экипирован и занимает слот; снять его нельзя. Если слоты заняты, он вытесняет из слота
 * случайный обычный навык (тот остаётся в Памяти). Лечат шрам Знахарь в Якоре или Очистка в Магазине;
 * снятый шрам сожжённым навыком не считается.
 *
 *   voice (Чужой голос) — в начале каждого боя один случайный экипированный навык спит до конца первого раунда;
 *   burn  (Ожог памяти) — самый частый тег в слотах считается на один навык меньше;
 *   crack (Трещина)     — использование навыка с зарядами: к20, на 1 — заряд сгорает дважды.
 *
 * Спящие навыки боя просыпаются с концом боя (здесь же — и для правил Босса).
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { HOOKS } from "../../memory-api.js";
import { addSkillToMemory } from "../../inventory.js";
import { getSkillPack } from "../../crystals.js";
import { isMemorySkill, occupiesSlot, naturalSlotCap, setSkillEquipped, updateActorSynergies, isAwake, TAG_COUNT_MODIFIERS } from "../../synergy/synergy.js";
import { sleepSkill, wakeSkill, note, esc } from "./common.js";
import { t } from "../../../core/i18n.js";

export const scarKind = item => item?.flags?.[MODULE_ID]?.scar ?? null;
export const isScar = item => !!scarKind(item) && isMemorySkill(item);
const scarOn = (actor, kind) => actor?.items?.find(i => isScar(i) && scarKind(i) === kind && i.flags[MODULE_ID].is_active) ?? null;

/**
 * Положить шрам в Память персонажа. Мастер.
 * @param {Actor} actor
 * @param {object} [o]  kind — вид шрама (без него — случайный из тех, которых у персонажа нет); reason — откуда
 * @returns {Promise<Item|null>}
 */
export async function grantScar(actor, { kind = null, reason = '' } = {}) {
    if (!actor || !game.user.isGM) return null;
    const pack = getSkillPack();
    const index = await pack?.getIndex({ fields: [`flags.${MODULE_ID}.scar`] });
    const owned = new Set(actor.items.filter(isScar).map(scarKind));
    const pool = [...(index ?? [])].filter(e => e.flags?.[MODULE_ID]?.scar && !owned.has(e.flags[MODULE_ID].scar) && (!kind || e.flags[MODULE_ID].scar === kind));
    if (!pool.length) return null;
    const entry = pool[Math.floor(Math.random() * pool.length)];
    const result = await addSkillToMemory(actor, entry.name, { forced: true, extraFlags: { skill_id: entry._id } });
    if (!['added', 'replaced'].includes(result?.status)) return null;
    const scar = actor.items.find(i => isMemorySkill(i) && i.flags[MODULE_ID].skill_id === entry._id);
    if (!scar) return null;
    // Слоты заняты — шрам вытесняет из слота случайный обычный навык
    let pushed = null;
    const slotted = actor.items.filter(i => isMemorySkill(i) && i.flags[MODULE_ID].is_active && occupiesSlot(i));
    if (slotted.length >= naturalSlotCap(actor)) {
        const movable = slotted.filter(i => !isScar(i) && !i.flags[MODULE_ID].horseman);
        pushed = movable[Math.floor(Math.random() * movable.length)] ?? null;
        if (pushed) await setSkillEquipped(pushed, false);
    }
    await setSkillEquipped(scar, true);
    await updateActorSynergies(actor);
    await note(actor, t('Шрам: {v}', { v: esc(scar.name) }), `<p>${t('{v}{v2} получает шрам — он занимает слот, снять его нельзя. Лечит Знахарь в Якоре или Очистка в Магазине.', { v: reason ? `${esc(reason)}. ` : '', v2: esc(actor.name) })}</p>${pushed ? `<p>${t('Из слота вытеснен «{v}» — он остался в Памяти.', { v: esc(pushed.name) })}</p>` : ''}`, 'fa-heart-crack');
    return scar;
}

// Шрам не снимается
Hooks.on(HOOKS.preChangeSkill, (actor, item, equipping) => {
    if (equipping || !isScar(item)) return;
    ui.notifications.warn(t('{name}: шрам не снять — его лечит Знахарь в Якоре или Очистка в Магазине.', { name: item.name }));
    return false;
});

Hooks.on(HOOKS.terminalSkillView, (item, view) => {
    if (isScar(item)) view.notes.push({ cls: 'gd-scar-note', text: t('✖ Шрам · снять нельзя · лечит Знахарь в Якоре или Очистка в Магазине') });
});

// Снятый шрам — не сожжённый навык (счётчик сожжений его не видит: inventory.js)

// ==========================================
// ЧУЖОЙ ГОЛОС: сон навыка в первом раунде
// ==========================================

Hooks.on('updateCombat', async (combat, changed) => {
    if (!isActiveGM() || !('round' in changed)) return;
    for (const combatant of combat.combatants) {
        const actor = combatant.actor;
        if (!actor) continue;
        // Второй раунд — проснулись спящие до конца первого
        if (combat.round >= 2) {
            for (const item of actor.items.filter(i => i.flags?.[MODULE_ID]?.asleep?.combatId === combat.id && i.flags[MODULE_ID].asleep.until === 'round2')) await wakeSkill(item);
        }
        if (combat.round !== 1 || !scarOn(actor, 'voice') || actor.getFlag(MODULE_ID, 'voiceCombat') === combat.id) continue;
        await actor.setFlag(MODULE_ID, 'voiceCombat', combat.id);
        const awake = actor.items.filter(i => isMemorySkill(i) && isAwake(i) && !isScar(i));
        const victim = awake[Math.floor(Math.random() * awake.length)];
        if (!victim) continue;
        await sleepSkill(victim, { combatId: combat.id, until: 'round2', reason: t('шрам «Чужой голос», до конца первого раунда') });
        await note(actor, t('Чужой голос'), `<p>${t('Чужой голос в голове {v} заглушает «{v2}» — навык спит до конца первого раунда.', { v: esc(actor.name), v2: esc(victim.name) })}</p>`, 'fa-head-side-virus');
    }
});

// Конец боя — все навыки, уснувшие в этом бою, просыпаются
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    for (const actor of game.actors) {
        for (const item of actor.items.filter(i => i.flags?.[MODULE_ID]?.asleep?.combatId === combat.id)) await wakeSkill(item);
    }
});

// ==========================================
// ОЖОГ ПАМЯТИ: самый частый тег — на один навык меньше
// ==========================================

TAG_COUNT_MODIFIERS.push((actor, counts) => {
    if (!scarOn(actor, 'burn')) return;
    const [top] = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (top) counts[top[0]] = top[1] - 1;
});

// ==========================================
// ТРЕЩИНА: на 1 — заряд сгорает дважды
// ==========================================

Hooks.on('dnd5e.postUseActivity', async activity => {
    const item = activity?.item, actor = item?.actor;
    if (!actor?.isOwner || !isMemorySkill(item) || isScar(item) || !scarOn(actor, 'crack')) return;
    const max = Number(item.system?.uses?.max) || 0;
    if (!max) return;
    const roll = await new Roll('1d20').evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: t('Трещина: «{name}»{v}', { name: item.name, v: roll.total === 1 ? t(' — заряд сгорает дважды') : '' }) });
    if (roll.total !== 1) return;
    const spent = Number(item.system.uses.spent) || 0;
    if (spent < max) await item.update({ 'system.uses.spent': spent + 1 });
});

// Шрам по просьбе (макрос Мастера, проверки): game.gachadnd.scar(actor, kind)
onSocket('livingScar', ({ payload }) => {
    if (isActiveGM()) grantScar(game.actors.get(payload.actorId), payload).catch(error => console.error(`${MODULE_ID} | шрам`, error));
});
export const requestScar = (actor, options = {}) => (game.user.isGM ? grantScar(actor, options) : requestGM('livingScar', { actorId: actor.id, ...options }));
