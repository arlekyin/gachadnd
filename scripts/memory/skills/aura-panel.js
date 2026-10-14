/**
 * Gacha Roguelike dnd5e — Счётчик ауры: панель и использование навыка
 *
 * Использование навыка в бою включает ауру (бонусное действие, заряд тратит dnd5e); пока аура горит,
 * использование только открывает панель. Панель: шкала, пороги, раунды до конца, кнопка
 * «Позёрство» — окно трюка (описание и цена). Объявленная поза ложится на ближайший бросок к20
 * персонажа: атаку, проверку или спасбросок.
 */

import { MODULE_ID } from "../../core/constants.js";
import { MAX, ROUNDS, FINALE, TIERS, PRICES, isAura, auraOf, poseOf, canPose, declarePose, cancelPose, requestStart } from "./aura.js";
import { refresh } from "./aura-fx.js";

const { ApplicationV2 } = foundry.applications.api;
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '');

export class AuraPanel extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-aura'],
        tag: 'div',
        window: { title: 'Счётчик ауры', icon: 'fas fa-crown', resizable: false },
        position: { width: 340, height: 'auto' }
    };

    static instance(actor) {
        return foundry.applications.instances?.get(`gachadnd-aura-${actor.id}`) ?? null;
    }

    static async open(actor) {
        try {
            const app = AuraPanel.instance(actor) ?? new AuraPanel(actor);
            await app.render({ force: true });
            app.bringToFront?.();
            return app;
        } catch (error) {
            console.error(`${MODULE_ID} | Аура: панель не открылась`, error);
            ui.notifications.error(`Счётчик ауры: панель не открылась — ${error?.message ?? error}. Подробности в консоли (F12).`);
            return null;
        }
    }

    constructor(actor) {
        super({ id: `gachadnd-aura-${actor.id}` });
        this.actor = actor;
    }

    get title() {
        return `Счётчик ауры — ${this.actor.name}`;
    }

    async _renderHTML() {
        const aura = auraOf(this.actor);
        const value = aura?.value ?? 0;
        const gems = Array.from({ length: MAX }, (_, i) => `<i class="${i < value ? 'lit' : ''}"></i>`).join('');
        const tiers = TIERS.map(t => `<li class="${value >= t.at ? 'on' : ''}"><b>${t.at}</b> <strong>${t.name}.</strong> ${t.text}</li>`).join('');
        if (!aura) {
            return `<div class="gd-aura"><div class="gd-aura-gems off">${gems}</div><p class="gd-aura-note">Аура не горит. Используйте навык в бою, чтобы включить её.</p><ul class="gd-aura-tiers">${tiers}</ul></div>`;
        }
        const combat = game.combat;
        const left = combat?.started && aura.combatId === combat.id ? Math.max(0, (aura.round ?? 0) + ROUNDS - combat.round) : null;
        const pose = poseOf(this.actor);
        const ready = pose?.status === 'ready';
        const blocked = canPose(this.actor);
        const poseLine = ready
            ? `<p class="gd-aura-pose">Поза: <strong>${PRICES[pose.price]?.label}</strong> — ждёт ближайшего броска к20. <button type="button" data-action="cancel">Отменить</button></p>`
            : `<button type="button" class="gd-aura-pose-btn" data-action="pose" ${blocked ? 'disabled' : ''}><i class="fas fa-star"></i> Позёрство</button>${blocked ? `<p class="gd-aura-note">${esc(blocked)}</p>` : ''}`;
        return `<div class="gd-aura">
            <div class="gd-aura-head"><span class="gd-aura-value">${value}<small>/${MAX}</small></span><div class="gd-aura-gems">${gems}</div></div>
            <p class="gd-aura-note">${aura.gained ? 'С начала хода аура уже была — убывания не будет.' : 'С начала хода ауры не было: в начале следующего хода −1.'}${left !== null ? ` До конца минуты: ${left} ${plural(left, 'раунд', 'раунда', 'раундов')}.` : ''}</p>
            ${poseLine}
            <ul class="gd-aura-tiers">${tiers}</ul>
            <p class="gd-aura-finale ${value >= FINALE ? 'on' : ''}"><strong>Не в этой арке</strong> — при уроне по вам с аурой ${FINALE}+ можно потратить всю ауру: урон не проходит, навык гаснет.</p>
        </div>`;
    }

    _replaceHTML(html, content) {
        content.innerHTML = html;
        content.querySelector('[data-action="pose"]')?.addEventListener('click', () => poseDialog(this.actor));
        content.querySelector('[data-action="cancel"]')?.addEventListener('click', () => cancelPose(this.actor));
    }
}

/** Окно трюка: описание и цена */
export async function poseDialog(actor) {
    const reason = canPose(actor);
    if (reason) return ui.notifications.warn(reason);
    const prices = Object.entries(PRICES).map(([key, p], n) => `<label class="gd-aura-price-opt">
        <input type="radio" name="price" value="${key}" ${n === 0 ? 'checked' : ''}>
        <strong>${p.label}</strong> — ${p.hint}<br><small>удалось: +${p.gain} аура${p.loss ? `, не удалось: −${p.loss}` : ', не удалось: без потерь'}</small></label>`).join('');
    const answer = await foundry.applications.api.DialogV2.prompt({
        window: { title: `Позёрство — ${actor.name}` },
        content: `<div class="gd-aura-form">
            <p>Как это выглядит?</p>
            <textarea name="text" rows="2" placeholder="Не оборачиваясь, я…"></textarea>
            <div class="gd-aura-prices">${prices}</div>
            <p class="gd-aura-note">Цена ляжет на ближайший бросок к20: атаку, проверку или спасбросок.</p>
        </div>`,
        ok: {
            label: 'Позёрство',
            callback: (event, button) => ({ text: button.form.elements.text.value, price: button.form.elements.price.value })
        },
        rejectClose: false
    }).catch(() => null);
    if (!answer?.price) return;
    await declarePose(actor, answer.price, answer.text);
}

// Использование навыка: включить ауру в бою; аура горит — только панель
Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isAura(item) || !actor) return;
    if (auraOf(actor)) {
        AuraPanel.open(actor);
        return false;
    }
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id)) {
        ui.notifications.warn('Счётчик ауры включается только в бою, в котором участвует персонаж.');
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isAura(item) || !actor || auraOf(actor)) return;
    requestStart(actor);
    AuraPanel.open(actor);
});

// Аура или поза изменились — панель перерисовывается
Hooks.on('updateActor', (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) return;
    const flags = changes.flags[MODULE_ID];
    if (!('aura' in flags || 'auraPose' in flags || '-=auraPose' in flags)) return;
    const app = AuraPanel.instance(actor);
    if (app?.rendered) app.render();
});
Hooks.on('updateCombat', () => {
    for (const app of foundry.applications.instances?.values?.() ?? []) if (app instanceof AuraPanel && app.rendered) app.render();
});
Hooks.once('ready', () => refresh());
