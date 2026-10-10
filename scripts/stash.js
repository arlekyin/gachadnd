/**
 * Gacha Roguelike dnd5e — Хранилище кристаллов
 *
 * Личный тайник персонажа у Алтаря Памяти: кристаллы, отложенные здесь, не лежат в инвентаре —
 * не пахнут для Пожирателя и не пропадают вместе с сумкой. Доступно там же, где Алтарь: в Лабиринте —
 * только в Якоре. Кристалл переносится целиком (со всем количеством); данные предмета хранятся во флаге
 * персонажа stash и при возврате создаются заново.
 */

import { MODULE_ID } from "./constants.js";
import { isAtRest } from "./memory-api.js";
import { isCrystalItem } from "./inventory.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const RARITY_COLORS = { gray: '#9d9d9d', green: '#1eff00', blue: '#0070dd', purple: '#a335ee', red: '#ff003c', orange: '#ff8000' };
const RARITY_ORDER = ['gray', 'green', 'blue', 'purple', 'red', 'orange'];

export function getStash(actor) {
    return foundry.utils.deepClone(actor.getFlag(MODULE_ID, 'stash') ?? []);
}

// Отложить кристалл: данные предмета уходят во флаг, сам предмет удаляется
export async function depositCrystal(actor, item) {
    if (!isCrystalItem(item)) return;
    const data = item.toObject();
    delete data._id;
    delete data._stats;
    data.flags ??= {};
    data.flags[MODULE_ID] = { ...data.flags[MODULE_ID], stash_key: foundry.utils.randomID() };
    await actor.setFlag(MODULE_ID, 'stash', [...getStash(actor), data]);
    await item.delete();
}

// Забрать кристалл: предмет создаётся заново, запись уходит из флага
export async function withdrawCrystal(actor, key) {
    const stash = getStash(actor);
    const index = stash.findIndex(d => d.flags?.[MODULE_ID]?.stash_key === key);
    if (index < 0) return;
    const [data] = stash.splice(index, 1);
    delete data.flags[MODULE_ID].stash_key;
    await actor.update({ [`flags.${MODULE_ID}.stash`]: stash });
    await actor.createEmbeddedDocuments('Item', [data]);
}

const view = (name, rarity, quantity, img, extra) => ({
    name: String(name).replace(/^Кристалл:\s*/, ''), rarity, color: RARITY_COLORS[rarity] ?? '#aaa',
    quantity, img, ...extra
});
const byRarity = (a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || a.name.localeCompare(b.name);

export class StashWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(actor, options = {}) {
        super({ ...options, id: `gachadnd-stash-${actor.id}` });
        this.actor = actor;
    }

    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-stash'],
        tag: 'div',
        window: { title: 'Хранилище', icon: 'fas fa-box-archive', resizable: true },
        position: { width: 620, height: 520 },
        actions: {
            deposit: StashWindow.#onDeposit,
            withdraw: StashWindow.#onWithdraw
        }
    };

    static PARTS = { body: { template: 'modules/gachadnd/templates/stash/body.hbs', scrollable: ['.gd-stash-list'] } };

    static open(actor) {
        actor ??= game.user.character ?? canvas.tokens?.controlled[0]?.actor;
        if (!actor) return ui.notifications.warn('Выберите своего персонажа.');
        if (!actor.isOwner) return ui.notifications.warn('Хранилище открывается только для своего персонажа.');
        if (!isAtRest() && !game.user.isGM) return ui.notifications.warn('Хранилище доступно только у Алтаря Памяти.');
        const existing = foundry.applications.instances?.get(`gachadnd-stash-${actor.id}`);
        if (existing) return existing.render({ force: true });
        return new StashWindow(actor).render({ force: true });
    }

    get title() {
        return `Хранилище · ${this.actor.name}`;
    }

    async _prepareContext() {
        const bag = this.actor.items.filter(isCrystalItem)
            .map(item => view(item.name, item.flags[MODULE_ID]?.rarity ?? 'gray', item.system?.quantity ?? 1, item.img, { id: item.id }))
            .sort(byRarity);
        const stash = getStash(this.actor)
            .map(d => view(d.name, d.flags?.[MODULE_ID]?.rarity ?? 'gray', d.system?.quantity ?? 1, d.img, { key: d.flags?.[MODULE_ID]?.stash_key }))
            .sort(byRarity);
        return { bag, stash, open: isAtRest() || game.user.isGM };
    }

    // Пока идёт перенос, щелчки не принимаются: один кристалл не уйдёт дважды
    #busy = false;
    async #run(task) {
        if (this.#busy) return;
        if (!isAtRest() && !game.user.isGM) return ui.notifications.warn('Хранилище доступно только у Алтаря Памяти.');
        this.#busy = true;
        try {
            await task();
        } finally {
            this.#busy = false;
        }
    }

    static #onDeposit(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (item) this.#run(() => depositCrystal(this.actor, item));
    }

    static #onWithdraw(event, target) {
        this.#run(() => withdrawCrystal(this.actor, target.dataset.key));
    }
}

// Инвентарь или Хранилище изменились — окно перерисовывается
const rerender = actor => {
    const app = foundry.applications.instances?.get(`gachadnd-stash-${actor?.id}`);
    if (app?.rendered) app.render();
};
for (const hook of ['createItem', 'updateItem', 'deleteItem']) Hooks.on(hook, item => rerender(item.parent));
Hooks.on('updateActor', (actor, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.stash`)) rerender(actor);
});
