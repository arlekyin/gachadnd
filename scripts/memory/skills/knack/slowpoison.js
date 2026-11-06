/**
 * Gacha Roguelike dnd5e — Медленный яд (красный навык яда и проклятья)
 *
 * Бонусным действием в бою персонаж отмечает цель (T) в пределах 60 футов. Отметка считает весь урон,
 * который цель получает от кого угодно (убыль ПЗ вместе с временными) в течение 3 раундов: в раунде
 * отметки и двух следующих. Когда начинается третий раунд после отметки, яд срабатывает: карточка
 * с кнопкой урона Ядом на подсчитанное — бросает игрок, применяет Мастер лотком dnd5e (защиты цели
 * считает dnd5e). Цель умерла раньше — яд пропадает. Карточка навыка dnd5e — в чате, как у способности.
 *
 * Счёт ведёт Мастер: флаг боя slowPoison [{ id, sourceId, tokenId, sceneId, round, hp, sum }], где hp —
 * последние известные ПЗ цели; эффект на цели «Медленный яд: N» показывает набранное.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { isKnack, ref, actorFrom, tokenOf, esc, noTemplate, targetsWithin, combatOf, hpOf, alive, card } from "./common.js";
import { t } from "../../../core/i18n.js";

const RANGE = 60;
const ROUNDS = 3;
const FLAG = 'slowPoison';
const ICON = 'icons/svg/poison.svg';

Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'slowpoison') || !actor) return;
    noTemplate(usage);
    const token = tokenOf(actor)?.document;
    if (!combatOf(actor) || !token) { ui.notifications.warn(t('Медленный яд — только в бою, в котором участвует персонаж.')); return false; }
    if (targetsWithin(token, RANGE).length !== 1) { ui.notifications.warn(t('Медленный яд: выберите одну цель (T) в пределах {RANGE} футов.', { RANGE })); return false; }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'slowpoison') || !actor) return;
    const [target] = targetsWithin(tokenOf(actor).document, RANGE);
    if (target) requestGM('knackSlowPoison', { ...ref(actor), targetId: target.id });
});

onSocket('knackSlowPoison', ({ payload }) => {
    if (isActiveGM()) mark(payload).catch(error => console.error(`${MODULE_ID} | Медленный яд`, error));
});

const entries = combat => foundry.utils.deepClone(combat?.getFlag(MODULE_ID, FLAG) ?? []);
const targetOf = entry => game.scenes.get(entry.sceneId)?.tokens.get(entry.tokenId) ?? null;
const effectOf = (actor, id) => actor?.effects.find(e => e.flags?.[MODULE_ID]?.slowPoison === id) ?? null;

export async function mark({ actorId, tokenId, sceneId, targetId }) {
    const combat = game.combat;
    const actor = actorFrom({ actorId, tokenId, sceneId });
    const target = game.scenes.get(sceneId)?.tokens.get(targetId);
    if (!combat?.started || !actor || !target?.actor) return;
    const id = foundry.utils.randomID();
    const list = entries(combat);
    list.push({ id, sourceId: actor.id, tokenId: target.id, sceneId, round: combat.round, hp: hpOf(target.actor), sum: 0 });
    await combat.setFlag(MODULE_ID, FLAG, list);
    await target.actor.createEmbeddedDocuments('ActiveEffect', [{
        name: t('Медленный яд: 0'), img: ICON, showIcon: 2,
        description: `<p>${t('Яд считает весь урон, который получает существо. В начале раунда {v} он вернёт его разом — урон Ядом.', { v: combat.round + ROUNDS })}</p>`,
        flags: { [MODULE_ID]: { slowPoison: id } }
    }]);
    return card(actor, t('Медленный яд'), `<p>${t('{v} отмечен. Весь урон, который он получит до конца раунда {v2}, вернётся к нему ядом.', { v: esc(target.name), v2: combat.round + ROUNDS - 1 })}</p>`, { icon: 'fa-flask' });
}

// Счёт: убыль ПЗ отмеченной цели — от кого угодно
Hooks.on('updateActor', async (actor, changes) => {
    if (!isActiveGM() || !foundry.utils.hasProperty(changes, 'system.attributes.hp')) return;
    const combat = game.combat;
    const list = entries(combat);
    let changed = false;
    for (const entry of list) {
        const target = targetOf(entry);
        if (target?.actor !== actor) continue;
        const now = hpOf(actor);
        if (now < entry.hp) entry.sum += entry.hp - now;
        entry.hp = now;
        changed = true;
        const effect = effectOf(actor, entry.id);
        if (effect && effect.name !== t('Медленный яд: {sum}', { sum: entry.sum })) await effect.update({ name: t('Медленный яд: {sum}', { sum: entry.sum }) });
    }
    if (changed) await combat.setFlag(MODULE_ID, FLAG, list);
});

// Срабатывание: начался третий раунд после отметки
Hooks.on('updateCombat', async (combat, changed) => {
    if (!('round' in changed) || !isActiveGM() || !combat.started) return;
    const list = entries(combat);
    const due = list.filter(e => combat.round >= e.round + ROUNDS);
    if (!due.length) return;
    await combat.setFlag(MODULE_ID, FLAG, list.filter(e => !due.includes(e)));
    for (const entry of due) await release(entry);
});

async function release(entry) {
    const target = targetOf(entry);
    const source = game.actors.get(entry.sourceId);
    const actor = target?.actor;
    if (!actor) return;
    await effectOf(actor, entry.id)?.delete();
    if (!alive(actor)) return card(source ?? actor, t('Медленный яд'), `<p>${t('{v} не дожил до яда — отметка пропала.', { v: esc(target.name) })}</p>`, { icon: 'fa-flask' });
    if (!entry.sum) return card(source ?? actor, t('Медленный яд'), `<p>${t('Яд сработал впустую: {v} за три раунда не получил урона.', { v: esc(target.name) })}</p>`, { icon: 'fa-flask' });
    return card(source ?? actor, t('Медленный яд'), `<p>${t('Яд сработал: всё, что {v} получил за три раунда, возвращается разом.', { v: esc(target.name) })}</p><p>[[/damage ${entry.sum} poison]]</p>`,
        { icon: 'fa-flask', flags: { slowPoisonRelease: { tokenId: target.id, sceneId: entry.sceneId, sum: entry.sum } } });
}

// Конец боя: отметки и эффекты снимаются
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    for (const entry of combat.getFlag(MODULE_ID, FLAG) ?? []) await effectOf(targetOf(entry)?.actor, entry.id)?.delete();
});
