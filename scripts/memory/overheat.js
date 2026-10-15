/**
 * Gacha Roguelike dnd5e — Перегрев
 *
 * Заряды, которые навыку вернул другой навык (поле recharger: Перезарядка, Оверклокинг), — заёмные.
 * Касается фиолетовых и красных навыков и самих зарядчиков. Первое использование заёмного заряда до
 * долгого отдыха — без последствий; каждое следующее — перегрев: навык срабатывает, затем открытая
 * кость d6, выпало не больше уровня перегрева — навык сгорает (неудаляемый — блокируется до долгого
 * отдыха). Долгий отдых снимает перегрев, короткий — сжигает незатраченный заём.
 *
 * Флаг навыка heat { borrowed, extra, locked }: borrowed — сколько заёмных зарядов ещё не потрачено,
 * extra — сколько заёмных зарядов потрачено с долгого отдыха. Трата заряда ловится в preUpdateItem
 * (рост system.uses.spent) у того, кто тратит; бросок — после использования навыка.
 */

import { MODULE_ID } from "../core/constants.js";
import { isMemorySkill } from "./synergy/synergy.js";

/** Сколько заёмных использований за долгий отдых проходят без броска */
export const FREE = 1;
const DIE = 6;

const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '');
export const rechargerOf = item => item?.flags?.[MODULE_ID]?.recharger ?? null;
const maxUses = item => Number(item?.system?.uses?.max) || 0;
const spentOf = item => Number(item?.system?.uses?.spent) || 0;

/** Навык, который греется от заёмных зарядов */
export function heatable(item) {
    const flags = item?.flags?.[MODULE_ID];
    if (!flags || !isMemorySkill(item) || !(maxUses(item) > 0)) return false;
    return flags.rarity === 'purple' || flags.rarity === 'red' || !!flags.recharger;
}

export function heatOf(item) {
    const heat = item?.flags?.[MODULE_ID]?.heat ?? {};
    return { borrowed: Number(heat.borrowed) || 0, extra: Number(heat.extra) || 0, locked: !!heat.locked };
}

/** Уровень перегрева для заёмного использования номер n (с долгого отдыха) */
export const levelFor = n => Math.min(DIE, Math.max(0, n - FREE));
/** Риск следующего заёмного использования: уровень и шанс в процентах */
export function nextRisk(item) {
    const level = levelFor(heatOf(item).extra + 1);
    return { level, chance: Math.round(level / DIE * 100) };
}
export const riskText = ({ level, chance }) => level ? `перегрев ${level}: сгорает на 1–${level} (${chance}%)` : 'без перегрева';

// ==========================================
// ПОДЗАРЯДКА
// ==========================================

/**
 * Вернуть навыку заряды извне: заёмные, если навык греется.
 * @param {Item} target
 * @param {'all'|number} restore
 * @returns {Promise<number>} сколько зарядов вернулось
 */
export async function recharge(target, restore) {
    const spent = spentOf(target);
    const amount = restore === 'all' ? spent : Math.min(spent, Number(restore) || 0);
    if (!amount) return 0;
    const update = { 'system.uses.spent': spent - amount };
    if (heatable(target)) {
        const heat = heatOf(target);
        update[`flags.${MODULE_ID}.heat`] = { ...heat, borrowed: heat.borrowed + amount };
    }
    await target.update(update, { gachadndRecharge: true });
    return amount;
}

/** Цели зарядчика: навыки Памяти с тратой зарядов, кроме него самого */
export function rechargeTargets(source) {
    const config = rechargerOf(source);
    const actor = source?.actor;
    if (!config || !actor) return [];
    return actor.items.filter(item => {
        if (item.id === source.id || !isMemorySkill(item) || !(maxUses(item) > 0) || heatOf(item).locked) return false;
        if (config.target === 'equipped_empty') return !!item.flags[MODULE_ID].is_active && spentOf(item) >= maxUses(item);
        return spentOf(item) > 0;
    });
}

// Выбранная цель ждёт, пока использование зарядчика пройдёт целиком (заряд, цена ПЗ)
const chosen = new Map();

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!item?.actor) return;
    if (heatOf(item).locked && isMemorySkill(item)) {
        ui.notifications.warn(`«${item.name}» перегрет и заблокирован до долгого отдыха.`);
        return false;
    }
    const config = rechargerOf(item);
    if (!config || chosen.has(item.id)) return;
    const targets = rechargeTargets(item);
    if (!targets.length) {
        ui.notifications.warn(config.target === 'equipped_empty'
            ? `${item.name}: нет экипированного навыка, у которого закончились заряды.`
            : `${item.name}: нет навыка, которому нужно восстановить заряды.`);
        return false;
    }
    // Сначала цель, затем использование заново — тогда заряд и цена тратятся только при выборе
    chooseTarget(item, targets).then(target => {
        if (!target) return;
        chosen.set(item.id, target.id);
        return Promise.resolve(activity.use?.()).finally(() => chosen.delete(item.id));
    }).catch(error => console.error(`${MODULE_ID} | Подзарядка`, error));
    return false;
});

Hooks.on('dnd5e.postUseActivity', async (activity) => {
    const item = activity?.item;
    const targetId = chosen.get(item?.id);
    if (!targetId) return;
    chosen.delete(item.id);
    const target = item.actor?.items.get(targetId);
    if (!target) return;
    const config = rechargerOf(item);
    const amount = await recharge(target, config.restore);
    const risk = heatable(target) ? `<p class="gd-heat-risk">Следующее использование заёмного заряда — ${riskText(nextRisk(target))}.</p>` : '';
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: item.actor }),
        content: `<div class="gd-heat-card"><div class="gd-heat-title"><i class="fas fa-bolt"></i> ${esc(item.name)} → ${esc(target.name)}</div><p>Восстановлено зарядов: ${amount}.</p>${risk}</div>`
    });
});

async function chooseTarget(source, targets) {
    if (targets.length === 1 && rechargerOf(source).target === 'equipped_empty') return targets[0];
    const options = targets.map(item => {
        const value = maxUses(item) - spentOf(item);
        const risk = heatable(item) ? riskText(nextRisk(item)) : 'не греется';
        return `<option value="${item.id}">${esc(item.name)} — заряды ${value}/${maxUses(item)}, ${risk}</option>`;
    }).join('');
    const id = await foundry.applications.api.DialogV2.prompt({
        window: { title: source.name },
        content: `<p>Какому навыку вернуть заряды?</p><select name="target">${options}</select><p class="gd-heat-note">Заёмные заряды греют фиолетовые и красные навыки и навыки подзарядки: с второго заёмного использования до долгого отдыха навык может сгореть.</p>`,
        ok: { label: 'Подзарядить', callback: (event, button) => button.form.elements.target.value },
        rejectClose: false
    }).catch(() => null);
    return targets.find(item => item.id === id) ?? null;
}

// ==========================================
// ТРАТА ЗАЁМНЫХ ЗАРЯДОВ И БРОСОК
// ==========================================

Hooks.on('preUpdateItem', (item, changes, options) => {
    if (options.isRest || options.gachadndRecharge || !heatable(item)) return;
    // Изменения приходят и развёрнутыми, и плоскими ключами
    const next = changes['system.uses.spent'] ?? foundry.utils.getProperty(changes, 'system.uses.spent');
    if (next === undefined) return;
    const before = spentOf(item);
    let count = Number(next) - before;
    if (!(count > 0)) return;
    const heat = heatOf(item);
    // Заём не больше оставшихся зарядов: свои заряды могли вернуться перезарядкой навыка
    let borrowed = Math.min(heat.borrowed, Math.max(0, maxUses(item) - before));
    let extra = heat.extra;
    const levels = [];
    while (count-- > 0 && borrowed > 0) {
        borrowed--;
        extra++;
        const level = levelFor(extra);
        if (level) levels.push(level);
    }
    if (borrowed === heat.borrowed && extra === heat.extra) return;
    foundry.utils.mergeObject(changes, { flags: { [MODULE_ID]: { heat: { ...heat, borrowed, extra } } } });
    if (levels.length) options.gachadndHeat = levels;
});

// Бросок — когда использование навыка прошло (эффект срабатывает всегда), иначе — чуть позже
const pending = new Map();
Hooks.on('updateItem', (item, changes, options, userId) => {
    if (userId !== game.user.id || !options.gachadndHeat) return;
    const levels = [...(pending.get(item.id)?.levels ?? []), ...options.gachadndHeat];
    clearTimeout(pending.get(item.id)?.timer);
    pending.set(item.id, { item, levels, timer: setTimeout(() => flush(item.id), 3000) });
});
Hooks.on('dnd5e.postUseActivity', (activity) => {
    const id = activity?.item?.id;
    if (pending.has(id)) setTimeout(() => flush(id), 400);
});

function flush(id) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    overheat(entry.item, entry.levels).catch(error => console.error(`${MODULE_ID} | Перегрев`, error));
}

/** Броски перегрева по очереди; сгорел — дальше не бросается */
export async function overheat(item, levels) {
    const actor = item.actor;
    for (const level of levels) {
        if (!actor?.items.get(item.id)) return;
        const roll = await new Roll(`1d${DIE}`).evaluate();
        const burned = roll.total <= level;
        const undeletable = !!item.flags[MODULE_ID].undeletable;
        const verdict = !burned ? 'выдержал' : undeletable ? 'перегорел — заблокирован до долгого отдыха' : 'сгорел';
        const flavor = `<div class="gd-heat-card ${burned ? 'burn' : ''}"><div class="gd-heat-title"><i class="fas fa-temperature-high"></i> Перегрев: ${esc(item.name)}</div><p>Уровень ${level}: сгорает на 1–${level} (${Math.round(level / DIE * 100)}%). Выпало ${roll.total} — ${verdict}.</p></div>`;
        if (roll.toMessage) await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor });
        else await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: flavor });
        if (!burned) continue;
        if (undeletable) await item.update({ [`flags.${MODULE_ID}.heat.locked`]: true });
        else await item.delete();
        return;
    }
}

// ==========================================
// ОТДЫХ
// ==========================================

Hooks.on('dnd5e.restCompleted', async (actor, result, config) => {
    if (!actor?.isOwner) return;
    const isLong = result?.longRest ?? (config?.type === 'long');
    const updates = actor.items.filter(item => {
        const flag = item.flags?.[MODULE_ID]?.heat;
        return flag && (isLong || flag.borrowed);
    }).map(item => ({
        _id: item.id,
        [`flags.${MODULE_ID}.heat`]: isLong ? { borrowed: 0, extra: 0, locked: false } : { ...heatOf(item), borrowed: 0 }
    }));
    if (updates.length) await actor.updateEmbeddedDocuments('Item', updates, { gachadndRecharge: true });
});
