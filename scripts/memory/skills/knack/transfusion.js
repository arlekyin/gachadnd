/**
 * Gacha Roguelike dnd5e — Переливание (красный навык крови и аномалии)
 *
 * Действием персонаж меняется со своей целью (T) в пределах 30 футов долями оставшихся ПЗ: каждый
 * получает текущие ПЗ, равные доле своего максимума, которая была у другого (вниз, не меньше 1).
 * Временные ПЗ не участвуют. Союзник (то же отношение токена) согласен; остальные совершают спасбросок
 * Телосложения против Сл навыка — успех: обмена нет, заряд потрачен. После обмена — 1 степень истощения.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { isKnack, ref, actorFrom, tokenOf, esc, quiet, dcOf, targetsWithin, card } from "./common.js";

const RANGE = 30;

Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'transfusion') || !actor) return;
    quiet(usage, message);
    const token = tokenOf(actor)?.document;
    if (!token) { ui.notifications.warn('Переливание: токена персонажа нет на сцене.'); return false; }
    if (targetsWithin(token, RANGE).length !== 1) { ui.notifications.warn(`Переливание: выберите одну цель (T) в пределах ${RANGE} футов.`); return false; }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'transfusion') || !actor) return;
    const [target] = targetsWithin(tokenOf(actor).document, RANGE);
    if (target) requestGM('knackTransfusion', { ...ref(actor), targetId: target.id, dc: dcOf(item) });
});

onSocket('knackTransfusion', ({ payload }) => {
    if (isActiveGM()) swap(payload).catch(error => console.error(`${MODULE_ID} | Переливание`, error));
});

const share = actor => {
    const hp = actor.system.attributes.hp;
    return hp.max > 0 ? Math.max(0, hp.value) / hp.max : 0;
};

export async function swap({ actorId, tokenId, sceneId, targetId, dc }) {
    const scene = game.scenes.get(sceneId);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    const self = scene?.tokens.get(tokenId);
    const target = scene?.tokens.get(targetId);
    if (!actor || !target?.actor) return;
    const other = target.actor;
    const willing = !!self && target.disposition === self.disposition;
    if (!willing) {
        const rolls = await other.rollSavingThrow({ ability: 'con', target: dc }, { configure: false }, {});
        const roll = Array.isArray(rolls) ? rolls[0] : rolls;
        if (roll && (roll.isSuccess ?? roll.total >= dc)) {
            return card(actor, 'Переливание', `<p>${esc(target.name)} не отдаёт свою кровь: спасбросок Телосложения ${roll.total} против Сл ${dc}. Обмена нет.</p>`, { icon: 'fa-droplet' });
        }
    }
    const a = share(actor), b = share(other);
    const hpA = actor.system.attributes.hp, hpB = other.system.attributes.hp;
    const nextA = Math.max(1, Math.floor(hpA.max * b)), nextB = Math.max(1, Math.floor(hpB.max * a));
    await actor.update({ 'system.attributes.hp.value': nextA });
    await other.update({ 'system.attributes.hp.value': nextB });
    const exhaustion = Math.min(6, (Number(actor.system.attributes.exhaustion) || 0) + 1);
    await actor.update({ 'system.attributes.exhaustion': exhaustion });
    const pct = v => `${Math.round(v * 100)} %`;
    return card(actor, 'Переливание', `<p>${esc(actor.name)} и ${esc(target.name)} меняются кровью:</p>
        <ul class="gd-blast-list"><li>${esc(actor.name)}: ${pct(a)} → ${pct(b)} (${hpA.value} → ${nextA} ПЗ)</li><li>${esc(target.name)}: ${pct(b)} → ${pct(a)} (${hpB.value} → ${nextB} ПЗ)</li></ul>
        <p>Цена: истощение ${exhaustion}.</p>`, { icon: 'fa-droplet' });
}
