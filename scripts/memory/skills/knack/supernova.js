/**
 * Gacha Roguelike dnd5e — Сверхновая (красный навык взрыва и щита)
 *
 * Пока навык экипирован, урон, который персонаж получает в начатом бою (убыль ПЗ вместе с временными),
 * копится — не больше максимума ПЗ. Накопленное видно эффектом «Сверхновая: N» и сбрасывается в конце
 * боя. Действием — взрыв: каждое существо в радиусе навыка (20 футов), кроме персонажа, — спасбросок
 * Ловкости против Сл навыка, урон Силовым полем, равный накопленному (успех — половина). Как у способностей
 * dnd5e: спасбросок цели бросают кнопкой из карточки навыка, урон — кнопкой в карточке взрыва, применяет
 * Мастер лотком. Накопление обнуляется, персонаж ошеломлён до конца своего следующего хода. Копить нечего —
 * заряд не тратится.
 *
 * Счёт ведёт Мастер: флаг персонажа supernova { combatId, hp, stored }.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { addTurnEffect } from "../turn-effects.js";
import { isKnack, knackSkill, ref, actorFrom, tokenOf, esc, noTemplate, dcOf, areaOf, around, boom, boomAt, combatOf, hpOf, card } from "./common.js";
import { t } from "../../../core/i18n.js";

const FLAG = 'supernova';
const ICON = 'icons/svg/sun.svg';

export const storedOf = actor => Number(actor?.getFlag(MODULE_ID, FLAG)?.stored) || 0;

Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'supernova') || !actor) return;
    noTemplate(usage);
    if (!tokenOf(actor)) { ui.notifications.warn(t('Сверхновая: токена персонажа нет на сцене.')); return false; }
    if (!storedOf(actor)) { ui.notifications.warn(t('Сверхновая: копить пока нечего — получите урон в бою.')); return false; }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'supernova') || !actor) return;
    requestGM('knackSupernova', { ...ref(actor), dc: dcOf(item), radius: areaOf(item, 20) });
});

onSocket('knackSupernova', ({ payload }) => {
    if (isActiveGM()) explode(payload).catch(error => console.error(`${MODULE_ID} | Сверхновая`, error));
});

async function show(actor, stored) {
    const effect = actor.effects.find(e => e.flags?.[MODULE_ID]?.supernova);
    if (!stored) return effect?.delete();
    const name = t('Сверхновая: {stored}', { stored });
    if (effect) { if (effect.name !== name) await effect.update({ name }); return; }
    await actor.createEmbeddedDocuments('ActiveEffect', [{ name, img: ICON, showIcon: 2, description: t('<p>Накопленный урон — выйдет взрывом.</p>'), flags: { [MODULE_ID]: { supernova: true } } }]);
}

// Накопление: убыль ПЗ владельца в его бою
Hooks.on('updateActor', async (actor, changes) => {
    if (!isActiveGM() || !foundry.utils.hasProperty(changes, 'system.attributes.hp') || !knackSkill(actor, 'supernova')) return;
    const combat = combatOf(actor);
    if (!combat) return;
    const state = actor.getFlag(MODULE_ID, FLAG) ?? {};
    const now = hpOf(actor);
    const fresh = state.combatId !== combat.id;
    const lost = !fresh && now < state.hp ? state.hp - now : 0;
    const max = Number(actor.system.attributes.hp.max) || 0;
    const stored = Math.min(max, (fresh ? 0 : Number(state.stored) || 0) + lost);
    await actor.setFlag(MODULE_ID, FLAG, { combatId: combat.id, hp: now, stored });
    await show(actor, stored);
});

// Начало боя и каждый ход: запомнить ПЗ, чтобы считать убыль с первого удара
Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    for (const c of combat.combatants) {
        const actor = c.actor;
        if (!actor || !knackSkill(actor, 'supernova')) continue;
        const state = actor.getFlag(MODULE_ID, FLAG);
        if (state?.combatId !== combat.id) await actor.setFlag(MODULE_ID, FLAG, { combatId: combat.id, hp: hpOf(actor), stored: 0 });
    }
});

export async function explode({ actorId, tokenId, sceneId, dc, radius }) {
    const actor = actorFrom({ actorId, tokenId, sceneId });
    const token = game.scenes.get(sceneId)?.tokens.get(tokenId);
    const stored = storedOf(actor);
    if (!actor || !token || !stored) return;
    await actor.setFlag(MODULE_ID, FLAG, { ...(actor.getFlag(MODULE_ID, FLAG) ?? {}), stored: 0, hp: hpOf(actor) });
    await show(actor, 0);
    boom({ ...boomAt(token, radius), color: 0xfff1c4 });
    const caught = around(token, radius);
    await card(actor, t('Сверхновая'), `<p>${t('{v} выпускает накопленное:', { v: esc(actor.name) })} <strong>${stored}</strong>.</p>
        <p>${caught.length ? t('В {radius} футах: {v} — спасбросок Ловкости (Сл {dc}) кнопкой из карточки навыка, успех — половина урона.', { radius, v: esc(caught.map(t => t.name).join(', ')), dc }) : t('Рядом никого.')}</p>
        <p>[[/damage ${stored} force]]</p>`, { icon: 'fa-sun', flags: { supernova: { stored, dc } } });
    const combat = game.combat?.started ? game.combat : null;
    const stun = { name: t('Сверхновая: ошеломлён'), img: ICON, statuses: ['stunned'], description: t('<p>После взрыва — ошеломлён до конца своего следующего хода.</p>') };
    if (combat?.combatants.some(c => c.tokenId === token.id)) await addTurnEffect(actor, combat, stun, { until: 'nextTurn', tokenId: token.id });
    else await actor.createEmbeddedDocuments('ActiveEffect', [{ ...stun, showIcon: 2, duration: { rounds: 1 } }]);
}

// Конец боя: накопленное сбрасывается
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    for (const actor of game.actors.filter(a => a.getFlag(MODULE_ID, FLAG)?.combatId === combat.id)) {
        await actor.unsetFlag(MODULE_ID, FLAG);
        await show(actor, 0);
    }
});
