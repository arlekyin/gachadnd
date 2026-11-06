/**
 * Gacha Roguelike dnd5e — Солнечная батарея (синий навык света)
 *
 * Персонаж с экипированной батареей закончил ход на ярком свету — батарея получает 1 заряд, но не
 * больше бонуса мастерства (свет проверяет Мастер, когда ход переходит дальше). Заряды — флаг навыка
 * battery, отдых их не сбрасывает. Использование: 3 заряда батареи → 1 заряд другого экипированного
 * навыка. Заряд возвращается через Перегрев (recharge): он заёмный и греет фиолетовые и красные навыки.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { isActiveGM } from "../../../core/socket.js";
import { isMemorySkill } from "../../synergy/synergy.js";
import { recharge, heatable, heatOf, nextRisk, riskText } from "../../overheat.js";
import { isLight, lightSkill, tokenOf, centerOf, inBrightLight, lightCard, esc } from "./common.js";
import { t } from "../../../core/i18n.js";

export const COST = 3;
const FLAG = 'battery';

export const chargesOf = item => Number(item?.getFlag?.(MODULE_ID, FLAG)) || 0;
export const capacityOf = actor => Number(actor?.system?.attributes?.prof) || 2;

/** Цели: экипированные навыки Памяти с потраченными зарядами, кроме батареи */
export function batteryTargets(battery) {
    return (battery?.actor?.items ?? []).filter(item => item.id !== battery.id && isMemorySkill(item)
        && item.flags[MODULE_ID].is_active && Number(item.system.uses?.max) > 0
        && Number(item.system.uses?.spent) > 0 && !heatOf(item).locked);
}

// Конец хода на ярком свету: +1 заряд
Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const previous = combat.previous?.combatantId ? combat.combatants.get(combat.previous.combatantId) : null;
    const actor = previous?.actor;
    const battery = lightSkill(actor, 'battery');
    if (!battery) return;
    const token = previous.token ?? tokenOf(actor)?.document;
    if (!token || token.parent?.id !== canvas.scene?.id || !inBrightLight(centerOf(token))) return;
    const charges = chargesOf(battery), cap = capacityOf(actor);
    if (charges >= cap) return;
    await battery.setFlag(MODULE_ID, FLAG, charges + 1);
    await lightCard(actor, t('Солнечная батарея'), `<p>${t('Ход на ярком свету: заряд {v}/{cap}.', { v: charges + 1, cap })}</p>`, { icon: 'fa-solar-panel' });
});

// Использование — только окно: 3 заряда батареи за 1 заряд навыка
Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isLight(item, 'battery') || !item.actor) return;
    discharge(item).catch(error => console.error(`gachadnd | Солнечная батарея`, error));
    return false;
});

export async function discharge(battery, targetId = null) {
    const actor = battery.actor;
    const charges = chargesOf(battery);
    if (charges < COST) return ui.notifications.warn(t('Солнечная батарея: заряд {charges}/{v}, нужно {COST}. Заканчивайте ход на ярком свету.', { charges, v: capacityOf(actor), COST }));
    const targets = batteryTargets(battery);
    if (!targets.length) return ui.notifications.warn(t('Солнечная батарея: нет экипированного навыка, которому нужен заряд.'));
    const target = targetId ? targets.find(t => t.id === targetId) : await chooseTarget(battery, targets);
    if (!target) return;
    await battery.setFlag(MODULE_ID, FLAG, charges - COST);
    const amount = await recharge(target, 1);
    const risk = heatable(target) ? `<p class="gd-heat-risk">${t('Следующее использование заёмного заряда — {v}.', { v: riskText(nextRisk(target)) })}</p>` : '';
    await lightCard(actor, t('Солнечная батарея → {name}', { name: target.name }), `<p>${t('Восстановлено зарядов: {amount}. В батарее осталось {v}.', { amount, v: charges - COST })}</p>${risk}`, { icon: 'fa-solar-panel' });
    return target;
}

async function chooseTarget(battery, targets) {
    const options = targets.map(item => {
        const max = Number(item.system.uses.max), spent = Number(item.system.uses.spent);
        const risk = heatable(item) ? riskText(nextRisk(item)) : t('не греется');
        return `<option value="${item.id}">${t('{v} — заряды {v2}/{max}, {risk}', { v: esc(item.name), v2: max - spent, max, risk })}</option>`;
    }).join('');
    const id = await foundry.applications.api.DialogV2.prompt({
        window: { title: t('Солнечная батарея — {v}/{v2}', { v: chargesOf(battery), v2: capacityOf(battery.actor) }) },
        content: `<p>${t('{COST} заряда батареи — 1 заряд навыку:', { COST })}</p><select name="target">${options}</select>`,
        ok: { label: t('Подзарядить'), callback: (event, button) => button.form.elements.target.value },
        rejectClose: false
    }).catch(() => null);
    return targets.find(item => item.id === id) ?? null;
}
