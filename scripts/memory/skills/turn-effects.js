/**
 * Gacha Roguelike dnd5e — Эффекты на ход
 *
 * Активный эффект, который держится до конца хода существа и снимается модулем (у Мастера):
 *   - nextTurn — до конца его следующего хода: в начале первого хода после наложения (если эффект
 *     лёг в его же ход — хода следующего раунда) эффект «взводится», когда ход переходит дальше — снимается;
 *   - thisTurn — до конца текущего хода: снимается, как только ход переходит от него.
 * Срок эффекту не задаётся: Foundry и dnd5e снимали бы его по своим часам. Иконка на токене — showIcon.
 * В конце боя снимаются все такие эффекты.
 */

import { MODULE_ID } from "../../core/constants.js";
import { isActiveGM } from "../../core/socket.js";

/**
 * Наложить эффект на ход.
 * @param {Actor} actor
 * @param {Combat} combat
 * @param {object} data       Данные активного эффекта (name, img, description, statuses, changes, flags).
 * @param {object} options    { until: 'nextTurn' | 'thisTurn', tokenId } — tokenId, чтобы найти участника боя.
 */
export async function addTurnEffect(actor, combat, data, { until = 'nextTurn', tokenId = null } = {}) {
    const combatant = combat?.combatants?.find(c => (tokenId && (c.tokenId === tokenId || c.token?.id === tokenId)) || c.actor?.id === actor.id) ?? null;
    const flag = {
        combatantId: combatant?.id ?? null, round: combat?.round ?? 0, until, started: false,
        wasCurrent: !!combatant && combat?.combatant?.id === combatant.id
    };
    const [effect] = await actor.createEmbeddedDocuments('ActiveEffect', [{
        showIcon: 2,
        ...data,
        flags: { ...(data.flags ?? {}), [MODULE_ID]: { ...(data.flags?.[MODULE_ID] ?? {}), turnEffect: flag } }
    }]);
    return effect;
}

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM()) return;
    for (const combatant of combat.combatants) {
        for (const effect of [...(combatant.actor?.effects ?? [])]) {
            const flag = effect.flags?.[MODULE_ID]?.turnEffect;
            if (!flag || (flag.combatantId && flag.combatantId !== combatant.id)) continue;
            const current = combat.combatant?.id === combatant.id;
            if (flag.until === 'thisTurn') {
                if (!current) await effect.delete();
                continue;
            }
            const next = !flag.wasCurrent || combat.round > flag.round;
            if (current && next && !flag.started) await effect.update({ [`flags.${MODULE_ID}.turnEffect.started`]: true });
            else if (!current && flag.started) await effect.delete();
        }
    }
});

Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    for (const combatant of combat.combatants) {
        const ids = (combatant.actor?.effects ?? []).filter(e => e.flags?.[MODULE_ID]?.turnEffect).map(e => e.id);
        if (ids.length) await combatant.actor.deleteEmbeddedDocuments('ActiveEffect', ids);
    }
});
