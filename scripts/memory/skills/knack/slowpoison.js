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

const RANGE = 60;
const ROUNDS = 3;
const FLAG = 'slowPoison';
const ICON = 'icons/svg/poison.svg';

Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'slowpoison') || !actor) return;
    noTemplate(usage);
    const token = tokenOf(actor)?.document;
    if (!combatOf(actor) || !token) { ui.notifications.warn('Медленный яд — только в бою, в котором участвует персонаж.'); return false; }
    if (targetsWithin(token, RANGE).length !== 1) { ui.notifications.warn(`Медленный яд: выберите одну цель (T) в пределах ${RANGE} футов.`); return false; }
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
        name: 'Медленный яд: 0', img: ICON, showIcon: 2,
        description: `<p>Яд считает весь урон, который получает существо. В начале раунда ${combat.round + ROUNDS} он вернёт его разом — урон Ядом.</p>`,
        flags: { [MODULE_ID]: { slowPoison: id } }
    }]);
    return card(actor, 'Медленный яд', `<p>${esc(target.name)} отмечен. Весь урон, который он получит до конца раунда ${combat.round + ROUNDS - 1}, вернётся к нему ядом.</p>`, { icon: 'fa-flask' });
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
        if (effect && effect.name !== `Медленный яд: ${entry.sum}`) await effect.update({ name: `Медленный яд: ${entry.sum}` });
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
    if (!alive(actor)) return card(source ?? actor, 'Медленный яд', `<p>${esc(target.name)} не дожил до яда — отметка пропала.</p>`, { icon: 'fa-flask' });
    if (!entry.sum) return card(source ?? actor, 'Медленный яд', `<p>Яд сработал впустую: ${esc(target.name)} за три раунда не получил урона.</p>`, { icon: 'fa-flask' });
    return card(source ?? actor, 'Медленный яд', `<p>Яд сработал: всё, что ${esc(target.name)} получил за три раунда, возвращается разом.</p><p>[[/damage ${entry.sum} poison]]</p>`,
        { icon: 'fa-flask', flags: { slowPoisonRelease: { tokenId: target.id, sceneId: entry.sceneId, sum: entry.sum } } });
}

// Конец боя: отметки и эффекты снимаются
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    for (const entry of combat.getFlag(MODULE_ID, FLAG) ?? []) await effectOf(targetOf(entry)?.actor, entry.id)?.delete();
});
