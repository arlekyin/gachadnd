/**
 * Gacha Roguelike dnd5e — «Сыграем... в гвинт?»: панель руки
 *
 * Три карты руки, счётчики колоды и сброса. Клик по карте — розыгрыш: если карте нужна цель,
 * сначала выбор на сцене (точка, союзник) или из сброса (Медик). Карты, которые сейчас сыграть
 * нельзя (не бой, не свой ход, уже сыграна), видны, но приглушены — причина написана внизу.
 */

import { MODULE_ID } from "../../core/constants.js";
import { CARDS, HAND, stateOf, ensureState, canPlay, requestPlay, isGwent } from "./gwent.js";
import { pickCell } from "./pick.js";
import { key, cellOf } from "./grid.js";

const { ApplicationV2 } = foundry.applications.api;
const RANGE = 30, ZONE = 15;
const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '');

export class GwentPanel extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-gwent'],
        tag: 'div',
        window: { title: 'Гвинт', icon: 'fas fa-layer-group', resizable: false },
        position: { width: 470, height: 'auto' }
    };

    static instance(actor) {
        return foundry.applications.instances?.get(`gachadnd-gwent-${actor.id}`) ?? null;
    }

    static async open(actor) {
        try {
            const app = GwentPanel.instance(actor) ?? new GwentPanel(actor);
            await app.render({ force: true });
            app.bringToFront?.();
            return app;
        } catch (error) {
            console.error(`${MODULE_ID} | Гвинт: панель не открылась`, error);
            ui.notifications.error(`Гвинт: панель не открылась — ${error?.message ?? error}. Подробности в консоли (F12).`);
            return null;
        }
    }

    constructor(actor) {
        super({ id: `gachadnd-gwent-${actor.id}` });
        this.actor = actor;
        this.busy = false;
    }

    get title() {
        return `Сыграем... в гвинт? — ${this.actor.name}`;
    }

    async _prepareContext() {
        // В бою колода собирается при первом открытии, если Мастер ещё не собрал её в начале хода
        const combat = game.combat?.started ? game.combat : null;
        let state = stateOf(this.actor);
        if (combat && state?.combatId !== combat.id && this.actor.isOwner) {
            state = ensureState(this.actor, combat);
            await this.actor.update({ [`flags.${MODULE_ID}.gwent`]: state });
        }
        this.state = state;
        return {};
    }

    async _renderHTML() {
        const state = this.state;
        const blocked = canPlay(this.actor);
        if (!state) {
            return `<div class="gd-gwent"><p class="gd-gwent-empty">Колода тасуется в начале боя.</p></div>`;
        }
        const cards = state.hand.map((k, i) => {
            const card = CARDS[k];
            return `<button type="button" class="gd-gwent-card ${blocked ? 'off' : ''}" data-index="${i}" title="${esc(card.text)}">
                <span class="gd-gwent-art"><i class="fas ${card.icon}"></i></span>
                <span class="gd-gwent-name">${card.name}</span>
                <span class="gd-gwent-text">${card.text}</span>
            </button>`;
        }).join('') || '<p class="gd-gwent-empty">Рука пуста.</p>';
        return `<div class="gd-gwent">
            <div class="gd-gwent-hand">${cards}</div>
            <footer class="gd-gwent-status">
                <span><i class="fas fa-layer-group"></i> колода ${state.deck.length}</span>
                <span><i class="fas fa-trash-can"></i> сброс ${state.discard.length}</span>
                <p>${blocked ? esc(blocked) : `Бонусным действием сыграйте карту. В начале хода рука добирается до ${HAND}.`}</p>
            </footer>
        </div>`;
    }

    _replaceHTML(html, content) {
        content.innerHTML = html;
        content.querySelectorAll('.gd-gwent-card').forEach(el => el.addEventListener('click', () => this.#play(Number(el.dataset.index))));
    }

    async #play(index) {
        if (this.busy) return;
        const reason = canPlay(this.actor);
        if (reason) return ui.notifications.warn(reason);
        const keyName = this.state.hand[index];
        const card = CARDS[keyName];
        const token = this.actor.getActiveTokens?.()[0];
        if (!card || !token) return ui.notifications.warn('Токена персонажа нет на сцене.');
        this.busy = true;
        try {
            const target = await chooseTarget(card, token, this.state);
            if (card.target && !target) return;
            requestPlay(this.actor, token, index, target);
        } finally {
            this.busy = false;
        }
    }
}

/** Цель карты: точка, союзник или карта из сброса */
async function chooseTarget(card, caster, state) {
    if (!card.target) return null;
    const size = canvas.grid.size;
    if (card.target === 'point') {
        const cell = await pickCell({
            caster, range: RANGE,
            hint: `${card.name}: клик — центр зоны, правая кнопка или Esc — отмена.`,
            draw: (g, [x, y], ok, s) => {
                const r = ZONE / canvas.dimensions.distance * s;
                const tint = ok ? 0x9fe3ff : 0xff4d4d;
                g.lineStyle(3, tint, 0.9).beginFill(tint, 0.15).drawCircle(x * s + s / 2, y * s + s / 2, r).endFill();
            }
        });
        return cell ? { x: cell[0] * size + size / 2, y: cell[1] * size + size / 2 } : null;
    }
    if (card.target === 'ally') {
        const disposition = caster.document.disposition;
        const allyAt = cell => canvas.tokens.placeables.find(t => t !== caster && t.document.disposition === disposition
            && key(...cellOf(t.document, size)) === key(...cell));
        const cell = await pickCell({
            caster, range: RANGE, allowed: cell => !!allyAt(cell),
            hint: `${card.name}: клик по союзнику в пределах ${RANGE} футов, правая кнопка или Esc — отмена.`,
            draw: (g, [x, y], ok, s) => {
                const tint = ok ? 0x7dff8a : 0xff4d4d;
                g.lineStyle(3, tint, 0.95).drawRect(x * s + 2, y * s + 2, s - 4, s - 4);
            }
        });
        const ally = cell ? allyAt(cell) : null;
        return ally ? { tokenId: ally.document.id } : null;
    }
    if (card.target === 'discard') {
        const options = [...new Set(state.discard.filter(k => k !== 'medic'))];
        if (!options.length) { ui.notifications.warn('В сбросе нечего вернуть.'); return null; }
        const choice = await foundry.applications.api.DialogV2.prompt({
            window: { title: 'Медик' },
            content: `<p>Какую карту вернуть в руку?</p><select name="card">${options.map(k => `<option value="${k}">${CARDS[k].name}</option>`).join('')}</select>`,
            ok: { label: 'Вернуть', callback: (event, button) => button.form.elements.card.value },
            rejectClose: false
        }).catch(() => null);
        return choice ? { card: choice } : null;
    }
    return null;
}

// Использование навыка — открыть панель (карты разыгрываются из неё); обычное использование отменяется
Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isGwent(item) || !item.actor) return;
    console.log(`${MODULE_ID} | Гвинт: открываю панель — ${item.actor.name}`);
    GwentPanel.open(item.actor);
    return false;
});

// Рука меняется (добор, розыгрыш) — панель перерисовывается
Hooks.on('updateActor', (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.gwent`)) return;
    const app = GwentPanel.instance(actor);
    if (app?.rendered) app.render();
});
// Ход сменился — карты становятся доступны или нет
Hooks.on('updateCombat', () => {
    for (const app of foundry.applications.instances?.values?.() ?? []) if (app instanceof GwentPanel && app.rendered) app.render();
});
// Начало боя — панель открывается у тех, кто управляет персонажем с Гвинтом
Hooks.on('updateCombat', (combat, changed) => {
    if (changed.round !== 1 || !combat.started) return;
    for (const combatant of combat.combatants) {
        const actor = combatant.actor;
        if (!actor?.isOwner || !actor.items.some(i => isGwent(i) && i.flags[MODULE_ID].is_active)) continue;
        if (game.user.isGM && actor.hasPlayerOwner) continue;
        GwentPanel.open(actor);
    }
});
