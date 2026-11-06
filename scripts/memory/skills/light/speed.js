/**
 * Gacha Roguelike dnd5e — Скорость света (зелёный навык света)
 *
 * Сразу после чужого хода (или в начале раунда) ход персонажа начинается вне очереди, если в этом
 * раунде он ещё не ходил. Свой обычный ход в этом раунде он пропускает, со следующего раунда место
 * в очереди прежнее.
 *
 * Инициатива не меняется — двигается указатель хода. Флаг боя lightSpeed { round, combatantId,
 * fromId, phase }: active — идёт ход вне очереди; когда он кончается, очередь переходит к тому, кто
 * шёл после fromId (phase: done); когда очередь доходит до персонажа в этом раунде — он пропускается.
 * Перенаправление — в preUpdateCombat, синхронно, у того, кто передаёт ход.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { isLight, ref, actorFrom, tokenOf, lightCard, esc } from "./common.js";
import { t } from "../../../core/i18n.js";

const FLAG = 'lightSpeed';

/** Участник боя этого персонажа */
function combatantOf(combat, actor, tokenId = null) {
    return combat?.combatants?.find(c => (tokenId && c.tokenId === tokenId) || c.actor?.id === actor?.id) ?? null;
}

/** Причина отказа или null */
export function cannotJump(combat, combatant) {
    if (!combat?.started) return t('Скорость света — только в начатом бою.');
    if (!combatant) return t('Персонаж не участвует в бою.');
    if (combat.combatant?.id === combatant.id) return t('Сейчас и так ваш ход.');
    const state = combat.getFlag(MODULE_ID, FLAG);
    if (state?.round === combat.round && state.phase === 'active') return t('Сейчас уже идёт ход вне очереди.');
    if (state?.round === combat.round && state.combatantId === combatant.id) return t('В этом раунде вы уже ходили.');
    if (combat.turns.indexOf(combatant) < combat.turn) return t('В этом раунде вы уже ходили.');
    return null;
}

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLight(item, 'speed') || !actor) return;
    const combat = game.combat;
    const reason = cannotJump(combat, combatantOf(combat, actor, tokenOf(actor)?.document?.id));
    if (reason) {
        ui.notifications.warn(reason);
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isLight(item, 'speed') || !item.actor) return;
    requestGM('lightSpeed', ref(item.actor));
});

onSocket('lightSpeed', ({ payload }) => {
    if (!isActiveGM()) return;
    jump(payload).catch(error => console.error(`gachadnd | Скорость света`, error));
});

/** Мастер: ход персонажа начинается немедленно */
export async function jump({ actorId, tokenId, sceneId }) {
    const combat = game.combat;
    const actor = actorFrom({ actorId, tokenId, sceneId });
    const combatant = combatantOf(combat, actor, tokenId);
    const reason = cannotJump(combat, combatant);
    if (reason) return ui.notifications.warn(reason);
    const from = combat.combatant;
    await combat.update({
        turn: combat.turns.indexOf(combatant),
        [`flags.${MODULE_ID}.${FLAG}`]: { round: combat.round, combatantId: combatant.id, fromId: from?.id ?? null, phase: 'active' }
    }, { direction: 1 });
    await lightCard(actor, t('Скорость света'), `<p>${t('{v} ходит вне очереди{v2}.', { v: esc(combatant.name), v2: from ? t(' — сразу после {v}', { v: esc(from.name) }) : '' })}</p>`, { icon: 'fa-bolt' });
}

/** Следующий индекс хода после index, пропуская побеждённых, как Combat#nextTurn; null — раунд кончился */
function nextIndex(combat, index) {
    const skip = combat.settings?.skipDefeated;
    for (let i = index + 1; i < combat.turns.length; i++) {
        if (skip && combat.turns[i].isDefeated) continue;
        return i;
    }
    return null;
}

Hooks.on('preUpdateCombat', (combat, changes, options) => {
    const state = combat.getFlag(MODULE_ID, FLAG);
    if (!state || state.round !== combat.round || !('turn' in changes)) return;
    // Только шаг вперёд; сам прыжок (флаг в изменениях) не перенаправляется
    if ((options.direction ?? 1) < 0 || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG}`)) return;
    const ours = combat.turns.findIndex(t => t.id === state.combatantId);
    if (ours < 0) return;
    // Если персонаж последний в очереди, конец его хода вне очереди — это nextRound
    const roundEnds = 'round' in changes && changes.round !== combat.round;

    let target = roundEnds ? null : changes.turn;
    let phase = state.phase;
    if (phase === 'active' && combat.combatant?.id === state.combatantId) {
        // Ход вне очереди кончился: очередь — тому, кто шёл после fromId
        const from = combat.turns.findIndex(t => t.id === state.fromId);
        target = nextIndex(combat, from);
        phase = 'done';
        foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${FLAG}.phase`, phase);
    } else if (roundEnds) return;
    // Свой обычный ход в этом раунде пропускается
    if (target === ours && phase === 'done') target = nextIndex(combat, ours);

    if (target === null) {
        changes.round = combat.round + 1;
        changes.turn = nextIndex(combat, -1) ?? 0;
    } else {
        // Раунд продолжается: nextRound отменён вместе со сдвигом игрового времени
        if (roundEnds) delete options.worldTime;
        changes.round = combat.round;
        changes.turn = target;
    }
});
