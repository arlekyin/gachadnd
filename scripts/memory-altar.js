/**
 * Gacha Roguelike dnd5e — Алтарь Памяти (полноэкранная мастерская на Привале)
 *
 * Ритуалы за Кости Хитов:
 *   Слияние     — повторный кристалл повышает ранг навыка (ранг II — 1 КХ, ранг III — 2 КХ);
 *   Переплавка  — 3 кристалла одной редкости → случайный кристалл следующей редкости;
 *   Резонанс    — кристалл → случайный кристалл той же редкости с выбранным тегом (1 КХ);
 *   Расщепление — кристалл → Кости Хитов обратно (зелёный, синий — 1, фиолетовый — 2).
 * Ингредиенты — кристаллы из инвентаря и неэкипированные навыки Памяти (они сжигаются).
 * Красные и оранжевые кристаллы в ритуалах не участвуют. Повтор, который нельзя слить
 * (уникальный навык или максимальный ранг), в Переплавке считается за два кристалла.
 */

import { MODULE_ID } from "./constants.js";
import { isMemorySkill } from "./synergy.js";
import { getSynergyDictionary } from "./synergy-data.js";
import { randomCrystal, randomCrystalWithTag, currentSkillName } from "./crystals.js";
import {
    canRankUp, forgeSkill, findDuplicateCrystal, FORGE_COST, romanRank,
    isCrystalItem, isUsableCrystal, availableHitDice, spendHitDice, restoreHitDice, consumeCrystal
} from "./inventory.js";
import { isPartyAtRest } from "./map.js";
import { onSocket, emit } from "./socket.js";

const { ApplicationV2 } = foundry.applications.api;

const RARITY = {
    gray: { label: 'Серый', color: '#9d9d9d' },
    green: { label: 'Зелёный', color: '#1eff00' },
    blue: { label: 'Синий', color: '#0070dd' },
    purple: { label: 'Фиолетовый', color: '#a335ee' }
};
const RITUAL_RARITIES = Object.keys(RARITY);
const SMELT = { gray: { to: 'green', cost: 1 }, green: { to: 'blue', cost: 1 }, blue: { to: 'purple', cost: 2 } };
const SPLIT = { green: 1, blue: 1, purple: 2 };
const RESONANCE_COST = 1;

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Ингредиенты: кристаллы инвентаря и неэкипированные навыки Памяти серой–фиолетовой редкости
function ingredients(actor) {
    const list = [];
    for (const item of actor.items) {
        const flags = item.flags?.[MODULE_ID] ?? {};
        if (!RITUAL_RARITIES.includes(flags.rarity)) continue;
        if (isCrystalItem(item) && isUsableCrystal(item)) {
            const name = currentSkillName(flags, item.name);
            const memory = actor.items.find(i => isMemorySkill(i) && currentSkillName(i.flags[MODULE_ID], i.name) === name);
            // Повтор, который нельзя слить, весит в Переплавке вдвое
            const weight = memory && !canRankUp(memory) ? 2 : 1;
            for (let n = 0; n < (item.system?.quantity ?? 1); n++) {
                list.push({ key: `${item.id}:${n}`, item, kind: 'crystal', rarity: flags.rarity, name, tags: flags.tags ?? [], weight });
            }
        } else if (isMemorySkill(item) && !flags.is_active && !flags.undeletable && !flags.horseman) {
            list.push({ key: item.id, item, kind: 'skill', rarity: flags.rarity, name: item.name, tags: flags.tags ?? [], weight: 1 });
        }
    }
    return list.sort((a, b) => RITUAL_RARITIES.indexOf(a.rarity) - RITUAL_RARITIES.indexOf(b.rarity) || a.name.localeCompare(b.name));
}

// Ингредиент уходит в ритуал: кристалл расходуется, навык Памяти сжигается
async function spend(ingredient) {
    if (ingredient.kind === 'crystal') await consumeCrystal(ingredient.item);
    else await ingredient.item.delete();
}

async function chat(actor, content) {
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="gachadnd-memory-altar-chat">${content}</div>` });
}

export class MemoryAltar extends ApplicationV2 {
    constructor(actor, options = {}) {
        super({ id: `gachadnd-memory-altar-${actor.id}`, ...options });
        this.actor = actor;
        this.selected = new Set();
        this.tag = null;
    }

    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-memory-altar'],
        tag: 'div',
        window: { title: 'Алтарь Памяти', icon: 'fas fa-campground', resizable: false },
        actions: {
            pick: MemoryAltar.#onPick,
            forge: MemoryAltar.#onForge,
            smelt: MemoryAltar.#onSmelt,
            resonate: MemoryAltar.#onResonate,
            split: MemoryAltar.#onSplit,
            clear: MemoryAltar.#onClear
        }
    };

    // Весь экран слева от боковой панели Foundry — чат остаётся виден
    static #fullscreen() {
        const sidebar = document.getElementById('sidebar');
        const width = Math.max(720, window.innerWidth - (sidebar?.offsetWidth ?? 300) - 10);
        return { left: 0, top: 0, width, height: window.innerHeight };
    }

    static open(actor) {
        actor ??= game.user.character ?? canvas.tokens?.controlled[0]?.actor;
        if (!actor) return ui.notifications.warn('Выберите своего персонажа.');
        if (!actor.isOwner) return ui.notifications.warn('Алтарь открывается только для своего персонажа.');
        if (!isPartyAtRest() && !game.user.isGM) return ui.notifications.warn('Алтарь Памяти доступен только на Привале.');
        const existing = foundry.applications.instances?.get(`gachadnd-memory-altar-${actor.id}`);
        if (existing) return existing.render({ force: true });
        return new MemoryAltar(actor, { position: MemoryAltar.#fullscreen() }).render({ force: true });
    }

    get title() {
        return `Алтарь Памяти — ${this.actor.name}`;
    }

    #picked() {
        const all = ingredients(this.actor);
        this.selected = new Set([...this.selected].filter(key => all.some(i => i.key === key)));
        return { all, picked: all.filter(i => this.selected.has(i.key)) };
    }

    async _renderHTML() {
        const { all, picked } = this.#picked();
        const hd = availableHitDice(this.actor);
        const atRest = isPartyAtRest();

        const card = ing => `
            <div class="gd-ing ${this.selected.has(ing.key) ? 'picked' : ''} ${ing.kind}" style="--rarity: ${RARITY[ing.rarity].color}" data-action="pick" data-key="${ing.key}"
                 title="${esc(ing.name)}${ing.kind === 'skill' ? ' — навык из Памяти, сгорит' : ''}${ing.weight > 1 ? ' — повтор без слияния, в Переплавке за два' : ''}">
                <div class="gd-ing-name">${esc(ing.name)}</div>
                <div class="gd-ing-meta">${RARITY[ing.rarity].label}${ing.kind === 'skill' ? ' · Память' : ''}${ing.weight > 1 ? ' · ×2' : ''}</div>
            </div>`;

        // Слияние: навыки Памяти, для которых есть повторный кристалл
        const forgeable = this.actor.items.filter(i => isMemorySkill(i) && canRankUp(i) && findDuplicateCrystal(this.actor, i));
        const forgeHtml = forgeable.length ? forgeable.map(item => {
            const next = (item.flags[MODULE_ID].rank ?? 1) + 1;
            const cost = FORGE_COST[next] ?? 2;
            return `<div class="gd-ritual-row"><span>${esc(item.name)} → ранг ${romanRank(next)}</span>
                <button type="button" data-action="forge" data-item-id="${item.id}" ${hd >= cost ? '' : 'disabled'}>−${cost} КХ</button></div>`;
        }).join('') : '<div class="gd-ritual-note">Нет навыков с повторным кристаллом в инвентаре.</div>';

        // Переплавка: все выбранные одной редкости, суммарный вес не меньше 3
        const rarities = new Set(picked.map(i => i.rarity));
        const smeltRarity = rarities.size === 1 ? [...rarities][0] : null;
        const smelt = SMELT[smeltRarity];
        const weight = picked.reduce((sum, i) => sum + i.weight, 0);
        const smeltReady = smelt && weight >= 3;
        const smeltNote = !picked.length ? 'Выберите 3 кристалла одной редкости (серые, зелёные или синие).'
            : !smeltRarity ? 'Все кристаллы должны быть одной редкости.'
            : !smelt ? 'Фиолетовые в Переплавке не участвуют.'
            : weight < 3 ? `Выбрано ${weight} из 3.` : `→ случайный ${RARITY[smelt.to].label.toLowerCase()} кристалл`;

        // Резонанс и Расщепление: ровно один ингредиент
        const single = picked.length === 1 ? picked[0] : null;
        const tags = Object.keys(getSynergyDictionary());
        this.tag ??= tags[0];
        const splitGain = single ? SPLIT[single.rarity] : null;

        const disabled = !atRest && !game.user.isGM ? 'disabled' : '';
        return `
            <div class="gd-ma-head">
                <span><i class="fas fa-campground"></i> Привал${atRest ? '' : ' — отряд не на Привале'}</span>
                <span class="gd-ma-hd">Кости Хитов: <strong>${hd}</strong></span>
            </div>
            <div class="gd-ma-body">
                <section class="gd-ma-ingredients">
                    <h3>Кристаллы и навыки <button type="button" class="gd-link" data-action="clear">сбросить выбор</button></h3>
                    <div class="gd-ing-grid">${all.map(card).join('') || '<div class="gd-ritual-note">Нет кристаллов для ритуалов.</div>'}</div>
                </section>
                <section class="gd-ma-rituals">
                    <div class="gd-ritual">
                        <h3>Слияние</h3>
                        <p>Повторный кристалл повышает ранг навыка.</p>
                        ${forgeHtml}
                    </div>
                    <div class="gd-ritual">
                        <h3>Переплавка</h3>
                        <p>3 кристалла одной редкости → случайный кристалл следующей редкости.</p>
                        <div class="gd-ritual-note">${smeltNote}</div>
                        <button type="button" data-action="smelt" ${smeltReady && hd >= smelt.cost ? '' : 'disabled'} ${disabled}>Переплавить${smelt ? ` · −${smelt.cost} КХ` : ''}</button>
                    </div>
                    <div class="gd-ritual">
                        <h3>Резонанс</h3>
                        <p>Кристалл → случайный кристалл той же редкости с выбранным тегом.</p>
                        <select class="gd-ma-tag">${tags.map(t => `<option value="${t}" ${t === this.tag ? 'selected' : ''}>${t}</option>`).join('')}</select>
                        <div class="gd-ritual-note">${single ? `${esc(single.name)} → ${RARITY[single.rarity].label.toLowerCase()} с тегом «${this.tag}»` : 'Выберите один кристалл.'}</div>
                        <button type="button" data-action="resonate" ${single && hd >= RESONANCE_COST ? '' : 'disabled'} ${disabled}>Резонанс · −${RESONANCE_COST} КХ</button>
                    </div>
                    <div class="gd-ritual">
                        <h3>Расщепление</h3>
                        <p>Кристалл → Кости Хитов обратно: зелёный и синий — 1, фиолетовый — 2.</p>
                        <div class="gd-ritual-note">${single ? (splitGain ? `${esc(single.name)} → +${splitGain} КХ` : 'Серые не расщепляются.') : 'Выберите один кристалл.'}</div>
                        <button type="button" data-action="split" ${splitGain ? '' : 'disabled'} ${disabled}>Расщепить${splitGain ? ` · +${splitGain} КХ` : ''}</button>
                    </div>
                </section>
            </div>`;
    }

    _replaceHTML(result, content) {
        content.innerHTML = result;
    }

    _onRender() {
        this.element.querySelector('.gd-ma-tag')?.addEventListener('change', event => {
            this.tag = event.target.value;
            this.render();
        });
    }

    static #onPick(event, target) {
        const key = target.dataset.key;
        if (this.selected.has(key)) this.selected.delete(key);
        else this.selected.add(key);
        this.render();
    }

    static #onClear() {
        this.selected.clear();
        this.render();
    }

    static async #onForge(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (!item) return;
        target.disabled = true;
        await forgeSkill(this.actor, item);
        this.render();
    }

    static async #onSmelt() {
        const { picked } = this.#picked();
        const rarity = picked[0]?.rarity;
        const smelt = SMELT[rarity];
        if (!smelt || picked.some(i => i.rarity !== rarity)) return;
        // Берутся выбранные ингредиенты, пока вес не наберёт 3
        const used = [];
        let weight = 0;
        for (const ing of picked) {
            if (weight >= 3) break;
            used.push(ing);
            weight += ing.weight;
        }
        if (weight < 3) return;
        const result = await randomCrystal(smelt.to);
        if (!result) return ui.notifications.error('Не удалось получить кристалл: компендиум навыков недоступен.');
        if (!(await spendHitDice(this.actor, smelt.cost))) return ui.notifications.warn('Не хватает Костей Хитов.');
        for (const ing of used) await spend(ing);
        await this.actor.createEmbeddedDocuments('Item', [result]);
        this.selected.clear();
        await chat(this.actor, `<strong>Переплавка:</strong> ${used.map(i => esc(i.name)).join(', ')} → <strong>${esc(result.name)}</strong>`);
        this.render();
    }

    static async #onResonate() {
        const { picked } = this.#picked();
        const ing = picked.length === 1 ? picked[0] : null;
        if (!ing) return;
        const result = await randomCrystalWithTag(ing.rarity, this.tag);
        if (!result) return ui.notifications.warn(`Нет навыков редкости «${RARITY[ing.rarity].label}» с тегом «${this.tag}».`);
        if (!(await spendHitDice(this.actor, RESONANCE_COST))) return ui.notifications.warn('Не хватает Костей Хитов.');
        await spend(ing);
        await this.actor.createEmbeddedDocuments('Item', [result]);
        this.selected.clear();
        await chat(this.actor, `<strong>Резонанс «${esc(this.tag)}»:</strong> ${esc(ing.name)} → <strong>${esc(result.name)}</strong>`);
        this.render();
    }

    static async #onSplit() {
        const { picked } = this.#picked();
        const ing = picked.length === 1 ? picked[0] : null;
        const gain = ing ? SPLIT[ing.rarity] : null;
        if (!gain) return;
        const spent = [...(this.actor.system.attributes?.hd?.classes ?? [])].reduce((sum, c) => sum + (c.system.hd?.spent ?? 0), 0);
        if (!spent) return ui.notifications.warn('Все Кости Хитов и так на месте — расщеплять нечего.');
        await spend(ing);
        const restored = await restoreHitDice(this.actor, gain);
        this.selected.clear();
        await chat(this.actor, `<strong>Расщепление:</strong> ${esc(ing.name)} → +${restored} КХ${restored < gain ? ' (больше потраченных Костей Хитов нет)' : ''}`);
        this.render();
    }
}

// Отряд пришёл на Привал — у каждого игрока открывается Алтарь его персонажа
onSocket('openMemoryAltar', () => {
    if (!game.user.isGM && game.user.character) MemoryAltar.open(game.user.character);
});
export function announceRest() {
    emit('openMemoryAltar');
}

// Алтарь перерисовывается при изменении предметов персонажа
const rerender = item => {
    const actor = item?.parent ?? item;
    foundry.applications.instances?.get(`gachadnd-memory-altar-${actor?.id}`)?.render();
};
Hooks.on('createItem', rerender);
Hooks.on('deleteItem', rerender);
Hooks.on('updateItem', rerender);
