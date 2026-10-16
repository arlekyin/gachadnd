/**
 * Gacha Roguelike dnd5e — Феникс (красный навык огня)
 *
 * Пока навык экипирован и у него есть заряд, ПЗ персонажа в бою опускаются до 0 — он сгорает:
 * токен становится кучкой пепла, заряд тратится. В начале его следующего хода он возрождается
 * с половиной максимума ПЗ (состояния без сознания, ничком и смерти снимаются, спасброски от
 * смерти — с нуля), а каждое существо вплотную получает урон навыка огнём.
 *
 * Кнопка «Растоптать пепел» на карточке — возрождения не будет: токен снова персонаж, ПЗ — 0.
 * Флаг персонажа phoenixAsh { combatId, tokenId, sceneId, img }; всё делает Мастер.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { isBlast, blastSkill, tokenOf, esc, damageOf, around, blast, boomAt } from "./common.js";

const FLAG = 'phoenixAsh';
const ASH = 'icons/magic/fire/explosion-embers-orange.webp';

const usesLeft = item => {
    const max = Number(item?.system?.uses?.max) || 0;
    return max - (Number(item?.system?.uses?.spent) || 0);
};

// Навык срабатывает сам — использование только напоминает
Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isBlast(item, 'phoenix')) return;
    ui.notifications.info(usesLeft(item) > 0 ? 'Феникс сработает сам, когда ПЗ опустятся до 0 в бою.' : 'Феникс уже сгорал — он восстановится после долгого отдыха.');
    return false;
});

// До 0 ПЗ — в пепел
Hooks.on('updateActor', async (actor, changes) => {
    const hp = changes?.system?.attributes?.hp?.value;
    if (hp === undefined || hp > 0 || !isActiveGM() || actor.getFlag(MODULE_ID, FLAG)) return;
    const combat = game.combat;
    const phoenix = blastSkill(actor, 'phoenix');
    const token = tokenOf(actor)?.document;
    if (!phoenix || usesLeft(phoenix) <= 0 || !combat?.started || !token || !combat.combatants.some(c => c.actor?.id === actor.id)) return;
    await phoenix.update({ 'system.uses.spent': (Number(phoenix.system.uses.spent) || 0) + 1 });
    await actor.setFlag(MODULE_ID, FLAG, { combatId: combat.id, tokenId: token.id, sceneId: token.parent.id, img: token.texture.src });
    await token.update({ 'texture.src': ASH });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-blast-card phoenix"><div class="gd-blast-title"><i class="fas fa-feather"></i> Феникс</div><p>${esc(actor.name)} сгорает дотла. В начале своего хода — возродится из пепла.</p><div class="gd-blast-buttons"><button type="button" data-phoenix-stomp="${actor.id}"><i class="fas fa-shoe-prints"></i> Растоптать пепел</button></div></div>`,
        flags: { [MODULE_ID]: { phoenix: { actorId: actor.id } } }
    });
});

async function restore(actor, flag) {
    const token = game.scenes.get(flag.sceneId)?.tokens.get(flag.tokenId);
    if (token) await token.update({ 'texture.src': flag.img });
    await actor.unsetFlag(MODULE_ID, FLAG);
    return token;
}

/** Мастер: возрождение в начале хода */
export async function rise(actor) {
    const flag = actor.getFlag(MODULE_ID, FLAG);
    if (!flag) return;
    const token = await restore(actor, flag);
    const max = Number(actor.system.attributes.hp.max) || 1;
    await actor.update({ 'system.attributes.hp.value': Math.max(1, Math.floor(max / 2)), 'system.attributes.death.success': 0, 'system.attributes.death.failure': 0 });
    for (const status of ['unconscious', 'prone', 'dead']) if (actor.statuses?.has(status)) await actor.toggleStatusEffect(status, { active: false });
    const phoenix = blastSkill(actor, 'phoenix');
    const damage = damageOf(phoenix, { formula: '4d6', type: 'fire' });
    const victims = token ? around(token, 5) : [];
    await blast({ actor, title: `Феникс: ${actor.name} возрождается из пепла`, icon: 'fa-feather', victims, formula: damage.formula, type: 'fire', at: token ? boomAt(token, 10) : null });
}

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const actor = combat.combatant?.actor;
    if (actor?.getFlag(MODULE_ID, FLAG)?.combatId === combat.id) await rise(actor);
});

onSocket('blastPhoenixStomp', ({ payload }) => {
    if (isActiveGM()) stomp(payload).catch(error => console.error(`${MODULE_ID} | Феникс`, error));
});

/** Мастер: пепел растоптан */
export async function stomp({ actorId }) {
    const actor = game.actors.get(actorId);
    const flag = actor?.getFlag(MODULE_ID, FLAG);
    if (!flag) return;
    await restore(actor, flag);
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="gd-blast-card phoenix"><div class="gd-blast-title"><i class="fas fa-shoe-prints"></i> Феникс</div><p>Пепел растоптан — ${esc(actor.name)} не возродится и лежит без сознания.</p></div>` });
}

onRenderChatMessage((message, html) => {
    const button = html?.querySelector?.('[data-phoenix-stomp]');
    if (!button) return;
    const actor = game.actors.get(button.dataset.phoenixStomp);
    if (!actor?.getFlag(MODULE_ID, FLAG)) { button.disabled = true; return; }
    button.addEventListener('click', () => requestGM('blastPhoenixStomp', { actorId: actor.id }));
});

// Бой кончился, а пепел остался — токен снова персонаж
Hooks.on('deleteCombat', async (combat) => {
    if (!isActiveGM()) return;
    for (const c of combat.combatants) {
        const flag = c.actor?.getFlag(MODULE_ID, FLAG);
        if (flag?.combatId === combat.id) await restore(c.actor, flag);
    }
});
