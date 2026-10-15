/**
 * Gacha Roguelike dnd5e — Флешбэк (фиолетовый навык)
 *
 * Механика из Blades in the Dark: игрок объявляет задним числом, что подготовился заранее.
 * Использование открывает окно: что подготовлено и насколько это сложно.
 *   - простая подготовка — бесплатно, без проверки;
 *   - сложная — 1 Кость Хитов и проверка характеристики;
 *   - невероятная — 2 Кости Хитов и проверка с помехой.
 * Сложность проверки и последствия — за Мастером: он решает, правдоподобно ли, и импровизирует.
 * Заряд и Кости Хитов списываются, только когда заявка подтверждена.
 */

import { MODULE_ID } from "../../core/constants.js";
import { availableHitDice, spendHitDice } from "../inventory.js";

const isFlashback = item => !!item?.flags?.[MODULE_ID]?.flashback;

export const TIERS = {
    simple: { label: 'Простая', cost: 0, roll: null, hint: 'бесплатно, без проверки', example: 'я взял с собой верёвку' },
    hard: { label: 'Сложная', cost: 1, roll: '1d20', hint: '1 Кость Хитов, проверка', example: 'вчера я подкупил стражника' },
    wild: { label: 'Невероятная', cost: 2, roll: '2d20kl', hint: '2 Кости Хитов, проверка с помехой', example: 'неделю назад я заминировал этот мост' }
};
const ABILITIES = { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' };
const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Использование навыка — только через окно: заряд тратится, когда заявка подтверждена
Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isFlashback(item) || !item.actor) return;
    const uses = item.system.uses;
    if (uses?.max && Number(uses.value ?? 0) <= 0) {
        ui.notifications.warn('Флешбэк уже использован — он восстановится после долгого отдыха.');
        return false;
    }
    flashback(item.actor, item);
    return false;
});

/** Окно заявки. @returns {Promise<{text, tier, ability}|null>} */
export async function askFlashback(actor) {
    const dice = availableHitDice(actor);
    const tiers = Object.entries(TIERS).map(([key, t], n) => {
        const off = t.cost > dice;
        return `<label class="gd-flashback-tier ${off ? 'off' : ''}">
            <input type="radio" name="tier" value="${key}" ${n === 0 ? 'checked' : ''} ${off ? 'disabled' : ''}>
            <strong>${t.label}</strong> — ${t.hint}<br><small>например: «${t.example}»</small></label>`;
    }).join('');
    const abilities = Object.entries(ABILITIES).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
    return foundry.applications.api.DialogV2.prompt({
        window: { title: `Флешбэк — ${actor.name}` },
        content: `<div class="gd-flashback-form">
            <p>Что вы подготовили заранее?</p>
            <textarea name="text" rows="3" placeholder="Я заранее…"></textarea>
            <div class="gd-flashback-tiers">${tiers}</div>
            <p class="gd-flashback-ability">Проверка: <select name="ability">${abilities}</select></p>
            <p class="gd-flashback-dice">Костей Хитов: ${dice}. Правдоподобность и сложность проверки определяет Мастер.</p>
        </div>`,
        ok: {
            label: 'Вспомнить',
            callback: (event, button) => {
                const form = button.form.elements;
                return { text: form.text.value.trim(), tier: form.tier.value, ability: form.ability.value };
            }
        },
        rejectClose: false
    }).catch(() => null);
}

export async function flashback(actor, item) {
    const answer = await askFlashback(actor);
    if (!answer) return;
    if (!answer.text) return ui.notifications.warn('Флешбэк: опишите, что вы подготовили.');
    const tier = TIERS[answer.tier] ?? TIERS.simple;
    if (tier.cost && !(await spendHitDice(actor, tier.cost))) {
        return ui.notifications.warn(`Не хватает Костей Хитов: нужно ${tier.cost}, доступно ${availableHitDice(actor)}.`);
    }
    const uses = item?.system?.uses;
    if (uses?.max) await item.update({ 'system.uses.spent': Number(uses.spent ?? 0) + 1 });

    const head = `<div class="gd-flashback-card">
        <div class="gd-flashback-title"><i class="fas fa-clock-rotate-left"></i> Флешбэк — ${tier.label.toLowerCase()} подготовка</div>
        <blockquote>${esc(answer.text)}</blockquote>
        <p class="gd-flashback-meta">${tier.cost ? `Потрачено Костей Хитов: ${tier.cost}. ` : ''}${tier.roll ? `Проверка: ${ABILITIES[answer.ability]}${tier.roll === '2d20kl' ? ', с помехой' : ''}. Сложность и последствия — за Мастером.` : 'Без проверки. Как это сработало — решает Мастер.'}</p>
    </div>`;
    const speaker = ChatMessage.getSpeaker({ actor });
    if (!tier.roll) return ChatMessage.create({ speaker, content: head });
    const mod = actor.system?.abilities?.[answer.ability]?.mod ?? 0;
    const roll = await new Roll(`${tier.roll} + @mod`, { mod }).evaluate();
    return roll.toMessage({ speaker, flavor: head });
}
