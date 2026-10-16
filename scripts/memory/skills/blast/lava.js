/**
 * Gacha Roguelike dnd5e — Пол — это лава (синий навык огня)
 *
 * Использование в бою: 10 раундов или до конца боя каждое существо, которое заканчивает ход в той же
 * клетке, где его начало, получает урон навыка (огонь, без спасброска). Касается и владельца.
 * Не горят те, кто выше пола: высота токена больше 0 или состояние «летит».
 *
 * Флаг боя lava { actorId, until, formula, starts }: starts — клетка каждого участника в начале его
 * хода. Пока лава горит, у всех на сцене — красное свечение по краям экрана.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { cellOf } from "../grid.js";
import { isBlast, ref, actorFrom, esc, quiet, damageOf, blast } from "./common.js";

const ROUNDS = 10;
const FLAG = 'lava';

const stateOf = combat => combat?.getFlag(MODULE_ID, FLAG) ?? null;

Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isBlast(item, 'lava') || !actor) return;
    quiet(usage, message);
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id)) {
        ui.notifications.warn('Пол — это лава: только в бою, в котором участвует персонаж.');
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isBlast(item, 'lava') || !item.actor) return;
    requestGM('blastLava', { ...ref(item.actor), formula: damageOf(item, { formula: '2d6' }).formula });
});

onSocket('blastLava', ({ payload }) => {
    if (isActiveGM()) start(payload).catch(error => console.error(`${MODULE_ID} | Лава`, error));
});

const where = token => token ? cellOf(token, token.parent.grid.size).join(',') : null;

export async function start({ actorId, tokenId, sceneId, formula }) {
    const combat = game.combat;
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!combat || !actor) return;
    // Ход того, кто сейчас ходит, уже начался: его клетка — с этого момента
    const current = combat.combatant;
    const starts = current?.token ? { [current.id]: where(current.token) } : {};
    await combat.setFlag(MODULE_ID, FLAG, { actorId: actor.id, until: combat.round + ROUNDS, formula, starts });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-blast-card lava"><div class="gd-blast-title"><i class="fas fa-volcano"></i> Пол — это лава!</div><p>До конца раунда ${combat.round + ROUNDS - 1}: кто закончит ход там же, где начал, — получает ${esc(formula)} урона огнём. Всех касается.</p></div>`
    });
}

const above = token => (Number(token.elevation) || 0) > 0 || token.actor?.statuses?.has?.('fly') || token.actor?.statuses?.has?.('hover');

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const state = stateOf(combat);
    if (!state) return;
    // Конец хода: стоял на месте — обжёгся
    const previous = combat.previous?.combatantId ? combat.combatants.get(combat.previous.combatantId) : null;
    const token = previous?.token;
    if (token && state.starts?.[previous.id] && where(token) === state.starts[previous.id] && !above(token)
        && (token.actor?.system?.attributes?.hp?.value ?? 1) > 0) {
        const owner = actorFrom({ actorId: state.actorId, tokenId: null, sceneId: token.parent.id });
        await blast({ actor: owner ?? token.actor, title: `Пол — это лава: ${token.name} стоял на месте`, icon: 'fa-volcano', victims: [token], formula: state.formula, type: 'fire' });
    }
    if ('round' in changed && combat.round >= state.until) {
        await combat.unsetFlag(MODULE_ID, FLAG);
        await ChatMessage.create({ content: '<div class="gd-blast-card lava"><div class="gd-blast-title"><i class="fas fa-volcano"></i> Пол — это лава</div><p>Пол остыл.</p></div>' });
        return;
    }
    // Начало хода: клетка запоминается
    const current = combat.combatant;
    if (current?.token) await combat.update({ [`flags.${MODULE_ID}.${FLAG}.starts.${current.id}`]: where(current.token) });
});

// Красное свечение по краям экрана, пока лава горит
function render() {
    const on = !!stateOf(game.combat) && game.combat?.started;
    let el = document.getElementById('gd-lava-glow');
    if (!on) return el?.remove();
    if (!el) {
        el = document.createElement('div');
        el.id = 'gd-lava-glow';
        document.body.append(el);
    }
}
for (const hook of ['ready', 'updateCombat', 'deleteCombat']) Hooks.on(hook, () => setTimeout(render, 0));
