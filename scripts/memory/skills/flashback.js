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
import { t } from "../../core/i18n.js";

const isFlashback = item => !!item?.flags?.[MODULE_ID]?.flashback;

export const TIERS = {
    simple: { label: t('Простая'), cost: 0, roll: null, hint: t('бесплатно, без проверки'), example: t('я взял с собой верёвку') },
    hard: { label: t('Сложная'), cost: 1, roll: '1d20', hint: t('1 Кость Хитов, проверка'), example: t('вчера я подкупил стражника') },
    wild: { label: t('Невероятная'), cost: 2, roll: '2d20kl', hint: t('2 Кости Хитов, проверка с помехой'), example: t('неделю назад я заминировал этот мост') }
};
const ABILITIES = { str: t('Сила'), dex: t('Ловкость'), con: t('Телосложение'), int: t('Интеллект'), wis: t('Мудрость'), cha: t('Харизма') };
const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Использование навыка — только через окно: заряд тратится, когда заявка подтверждена
Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isFlashback(item) || !item.actor) return;
    const uses = item.system.uses;
    if (uses?.max && Number(uses.value ?? 0) <= 0) {
        ui.notifications.warn(t('Флешбэк уже использован — он восстановится после долгого отдыха.'));
        return false;
    }
    flashback(item.actor, item);
    return false;
});

/** Окно заявки. @returns {Promise<{text, tier, ability}|null>} */
export async function askFlashback(actor) {
    const dice = availableHitDice(actor);
    const tiers = Object.entries(TIERS).map(([key, tier], n) => {
        const off = tier.cost > dice;
        return `<label class="gd-flashback-tier ${off ? 'off' : ''}">
            <input type="radio" name="tier" value="${key}" ${n === 0 ? 'checked' : ''} ${off ? 'disabled' : ''}>
            <strong>${tier.label}</strong> — ${tier.hint}<br><small>${t('например: «{example}»', { example: tier.example })}</small></label>`;
    }).join('');
    const abilities = Object.entries(ABILITIES).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
    return foundry.applications.api.DialogV2.prompt({
        window: { title: t('Флешбэк — {name}', { name: actor.name }) },
        content: `<div class="gd-flashback-form">
            <p>${t('Что вы подготовили заранее?')}</p>
            <textarea name="text" rows="3" placeholder="${t('Я заранее…')}"></textarea>
            <div class="gd-flashback-tiers">${tiers}</div>
            <p class="gd-flashback-ability">${t('Проверка:')} <select name="ability">${abilities}</select></p>
            <p class="gd-flashback-dice">${t('Костей Хитов: {dice}. Правдоподобность и сложность проверки определяет Мастер.', { dice })}</p>
        </div>`,
        ok: {
            label: t('Вспомнить'),
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
    if (!answer.text) return ui.notifications.warn(t('Флешбэк: опишите, что вы подготовили.'));
    const tier = TIERS[answer.tier] ?? TIERS.simple;
    if (tier.cost && !(await spendHitDice(actor, tier.cost))) {
        return ui.notifications.warn(t('Не хватает Костей Хитов: нужно {cost}, доступно {v}.', { cost: tier.cost, v: availableHitDice(actor) }));
    }
    const uses = item?.system?.uses;
    if (uses?.max) await item.update({ 'system.uses.spent': Number(uses.spent ?? 0) + 1 });

    const head = `<div class="gd-flashback-card">
        <div class="gd-flashback-title"><i class="fas fa-clock-rotate-left"></i> ${t('Флешбэк — {v} подготовка', { v: tier.label.toLowerCase() })}</div>
        <blockquote>${esc(answer.text)}</blockquote>
        <p class="gd-flashback-meta">${tier.cost ? t('Потрачено Костей Хитов: {cost}. ', { cost: tier.cost }) : ''}${tier.roll ? t('Проверка: {v}{v2}. Сложность и последствия — за Мастером.', { v: ABILITIES[answer.ability], v2: tier.roll === '2d20kl' ? t(', с помехой') : '' }) : t('Без проверки. Как это сработало — решает Мастер.')}</p>
    </div>`;
    const speaker = ChatMessage.getSpeaker({ actor });
    await ChatMessage.create({ speaker, content: head });
    if (!tier.roll) return;
    // Проверка характеристики dnd5e: все бонусы и модификаторы видны в броске
    return actor.rollAbilityCheck({ ability: answer.ability, disadvantage: tier.roll === '2d20kl' }, { configure: false });
}
