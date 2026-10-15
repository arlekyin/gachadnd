/**
 * Gacha Roguelike dnd5e — Счётчик ауры: панель и использование навыка
 *
 * Использование навыка в бою включает ауру (бонусное действие, заряд тратит dnd5e); пока аура горит,
 * использование только открывает панель. Панель: шкала, пороги и долг, кнопка «Позёрство» — окно
 * трюка (описание и цена), у Мастера — ±1 аура. На HUD токена с аурой у Мастера — корона:
 * левый клик +1, правый −1, с Shift — панель. Объявленная поза ложится на ближайший бросок к20
 * персонажа: атаку, проверку или спасбросок.
 */

import { MODULE_ID } from "../../core/constants.js";
import { MAX, FINALE, TIERS, DEBTS, PRICES, isAura, auraOf, poseOf, canPose, declarePose, cancelPose, requestStart, adjust } from "./aura.js";
import { refresh } from "./aura-fx.js";

const { ApplicationV2 } = foundry.applications.api;
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
        const debt = value < 0;
        const gems = Array.from({ length: MAX }, (_, i) => `<i class="${i < Math.abs(value) ? (debt ? 'lit debt' : 'lit') : ''}"></i>`).join('');
        const tiers = TIERS.map(t => `<li class="${value >= t.at ? 'on' : ''}"><b>${t.at}</b> <strong>${t.name}.</strong> ${t.text}</li>`).join('');
        const debts = DEBTS.map(t => `<li class="${value <= t.at ? 'on debt' : ''}"><b>${t.at}</b> <strong>${t.name}.</strong> ${t.text}</li>`).join('');
        if (!aura) {
            return `<div class="gd-aura"><div class="gd-aura-gems off">${gems}</div><p class="gd-aura-note">Аура не горит. Используйте навык в бою, чтобы включить её.</p><ul class="gd-aura-tiers">${tiers}${debts}</ul></div>`;
        }
        const pose = poseOf(this.actor);
        const ready = pose?.status === 'ready';
        const blocked = canPose(this.actor);
        const poseLine = ready
            ? `<p class="gd-aura-pose">Поза: <strong>${PRICES[pose.price]?.label}</strong> — ждёт ближайшего броска к20. <button type="button" data-action="cancel">Отменить</button></p>`
            : `<button type="button" class="gd-aura-pose-btn" data-action="pose" ${blocked ? 'disabled' : ''}><i class="fas fa-star"></i> Позёрство</button>${blocked ? `<p class="gd-aura-note">${esc(blocked)}</p>` : ''}`;
        const gm = game.user.isGM
            ? `<div class="gd-aura-gm"><span>Мастер:</span><button type="button" data-action="minus">−1 аура</button><button type="button" data-action="plus">+1 аура</button></div>`
            : '';
        return `<div class="gd-aura ${debt ? 'debt' : ''}">
            <div class="gd-aura-head"><span class="gd-aura-value">${value < 0 ? `−${-value}` : value}<small>/${MAX}</small></span><div class="gd-aura-gems">${gems}</div></div>
            ${debt ? `<p class="gd-aura-debt">Долг по ауре: ${-value}</p>` : ''}
            <p class="gd-aura-note">${aura.gained ? 'С начала хода аура уже была — убывания не будет.' : 'С начала хода ауры не было: в начале следующего хода −1.'} Аура горит до конца боя.</p>
            ${poseLine}
            ${gm}
            <ul class="gd-aura-tiers">${tiers}${debts}</ul>
            <p class="gd-aura-finale ${value >= FINALE ? 'on' : ''}"><strong>Не в этой арке</strong> — при уроне по вам с аурой ${FINALE}+ можно потратить всю ауру: урон не проходит, аура — 0.</p>
        </div>`;
    }

    _replaceHTML(html, content) {
        content.innerHTML = html;
        content.querySelector('[data-action="pose"]')?.addEventListener('click', () => poseDialog(this.actor));
        content.querySelector('[data-action="cancel"]')?.addEventListener('click', () => cancelPose(this.actor));
        content.querySelector('[data-action="plus"]')?.addEventListener('click', () => adjust(this.actor, 1));
        content.querySelector('[data-action="minus"]')?.addEventListener('click', () => adjust(this.actor, -1));
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

// HUD токена: корона у Мастера — ±1 аура
Hooks.on('renderTokenHUD', (hud, html) => {
    if (!game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    const actor = hud.object?.actor ?? hud.document?.actor;
    if (!root || !auraOf(actor)) return;
    const column = root.querySelector('.col.right') ?? root.querySelector('.right');
    if (!column || column.querySelector('.gd-aura-hud')) return;
    const button = document.createElement('div');
    button.className = 'control-icon gd-aura-hud';
    button.dataset.tooltip = 'Аура: левый клик +1, правый −1, Shift — панель';
    const label = () => { button.innerHTML = `<i class="fas fa-crown"></i><span>${auraOf(actor)?.value ?? 0}</span>`; };
    label();
    const act = (event, delta) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) return AuraPanel.open(actor);
        Promise.resolve(adjust(actor, delta)).then(() => setTimeout(label, 150));
    };
    button.addEventListener('click', event => act(event, 1));
    button.addEventListener('contextmenu', event => act(event, -1));
    column.append(button);
});
