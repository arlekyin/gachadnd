/**
 * Gacha Roguelike dnd5e — Переливание (красный навык крови и аномалии)
 *
 * Действием персонаж меняется со своей целью (T) в пределах 30 футов долями оставшихся ПЗ: каждый
 * получает текущие ПЗ, равные доле своего максимума, которая была у другого (вниз, не меньше 1).
 * Временные ПЗ не участвуют. После обмена — 1 степень истощения.
 *
 * Как у способностей dnd5e: карточка навыка в чате с кнопкой спасброска. Союзник (то же отношение токена)
 * согласен — обмен сразу. Иной цели модуль ставит отметку «ждёт спасброска»: цель бросает спасбросок
 * Телосложения сама (кнопкой из карточки), и по его итогу Мастер-клиент меняет ПЗ или нет.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { isKnack, ref, actorFrom, tokenOf, esc, noTemplate, dcOf, targetsWithin, card } from "./common.js";
import { t } from "../../../core/i18n.js";

const RANGE = 30;
const FLAG = 'transfusionPending';

Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'transfusion') || !actor) return;
    noTemplate(usage);
    const token = tokenOf(actor)?.document;
    if (!token) { ui.notifications.warn(t('Переливание: токена персонажа нет на сцене.')); return false; }
    if (targetsWithin(token, RANGE).length !== 1) { ui.notifications.warn(t('Переливание: выберите одну цель (T) в пределах {RANGE} футов.', { RANGE })); return false; }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'transfusion') || !actor) return;
    const [target] = targetsWithin(tokenOf(actor).document, RANGE);
    if (target) requestGM('knackTransfusion', { ...ref(actor), targetId: target.id, dc: dcOf(item) });
});

onSocket('knackTransfusion', ({ payload }) => {
    if (isActiveGM()) begin(payload).catch(error => console.error(`${MODULE_ID} | Переливание`, error));
});
onSocket('knackTransfusionSave', ({ payload }) => {
    if (isActiveGM()) resolve(payload).catch(error => console.error(`${MODULE_ID} | Переливание`, error));
});

/** Союзник — обмен сразу; иная цель — отметка до её спасброска */
export async function begin({ actorId, tokenId, sceneId, targetId, dc }) {
    const scene = game.scenes.get(sceneId);
    const self = scene?.tokens.get(tokenId);
    const target = scene?.tokens.get(targetId);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!actor || !target?.actor) return;
    if (self && target.disposition === self.disposition) return swap(actor, target);
    await target.actor.setFlag(MODULE_ID, FLAG, { actorId: actor.id, tokenId, sceneId, targetId, dc });
    return card(actor, t('Переливание'), `<p>${t('{v} сопротивляется: спасбросок Телосложения кнопкой из карточки навыка (Сл {dc}). Провал — обмен долями ПЗ.', { v: esc(target.name), dc })}</p>`, { icon: 'fa-droplet' });
}

// Спасбросок Телосложения цели с отметкой — у того клиента, где он брошен; решает Мастер
Hooks.on('dnd5e.rollSavingThrow', (rolls, data) => {
    const actor = data?.subject;
    const pending = actor?.getFlag?.(MODULE_ID, FLAG);
    if (!pending || data.ability !== 'con') return;
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if (!roll) return;
    requestGM('knackTransfusionSave', { actorUuid: actor.uuid, total: roll.total, success: roll.total >= pending.dc });
});

export async function resolve({ actorUuid, total, success }) {
    const other = await fromUuid(actorUuid);
    const pending = other?.getFlag(MODULE_ID, FLAG);
    if (!pending) return;
    await other.unsetFlag(MODULE_ID, FLAG);
    const actor = actorFrom(pending);
    const target = game.scenes.get(pending.sceneId)?.tokens.get(pending.targetId);
    if (!actor || !target) return;
    if (success) return card(actor, t('Переливание'), `<p>${t('{v} не отдаёт свою кровь: спасбросок {total} против Сл {dc}. Обмена нет.', { v: esc(target.name), total, dc: pending.dc })}</p>`, { icon: 'fa-droplet' });
    return swap(actor, target);
}

const share = actor => {
    const hp = actor.system.attributes.hp;
    return hp.max > 0 ? Math.max(0, hp.value) / hp.max : 0;
};

async function swap(actor, target) {
    const other = target.actor;
    const a = share(actor), b = share(other);
    const hpA = actor.system.attributes.hp, hpB = other.system.attributes.hp;
    const fromA = hpA.value, fromB = hpB.value;
    const nextA = Math.max(1, Math.floor(hpA.max * b)), nextB = Math.max(1, Math.floor(hpB.max * a));
    await actor.update({ 'system.attributes.hp.value': nextA });
    await other.update({ 'system.attributes.hp.value': nextB });
    const exhaustion = Math.min(6, (Number(actor.system.attributes.exhaustion) || 0) + 1);
    await actor.update({ 'system.attributes.exhaustion': exhaustion });
    const pct = v => `${Math.round(v * 100)} %`;
    return card(actor, t('Переливание'), `<p>${t('{v} и {v2} меняются кровью:', { v: esc(actor.name), v2: esc(target.name) })}</p>
        <ul class="gd-blast-list"><li>${t('{v}: {v2} → {v3} ({fromA} → {nextA} ПЗ)', { v: esc(actor.name), v2: pct(a), v3: pct(b), fromA, nextA })}</li><li>${t('{v}: {v2} → {v3} ({fromB} → {nextB} ПЗ)', { v: esc(target.name), v2: pct(b), v3: pct(a), fromB, nextB })}</li></ul>
        <p>${t('Цена: истощение {exhaustion}.', { exhaustion })}</p>`, { icon: 'fa-droplet' });
}
