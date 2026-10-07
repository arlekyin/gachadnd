/**
 * Gacha Roguelike dnd5e — Алтарь Памяти (полноэкранная мастерская на Привале)
 *
 * Ритуалы за Кости Хитов:
 *   Слияние     — повторный кристалл растворяется в навыке Памяти и повышает его ранг
 *                 (ранг II — 1 КХ, ранг III — 2 КХ); сам навык Память не покидает;
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

// Ритуалы: порядок в списке, подписи и цвет пламени котла
const RITUALS = {
    merge: { name: 'Слияние', icon: 'fa-hammer', flame: '#ffb347', text: 'Повторный кристалл растворяется в навыке Памяти и повышает его ранг.' },
    smelt: { name: 'Переплавка', icon: 'fa-fire', flame: '#ff6a2b', text: '3 кристалла одной редкости → случайный кристалл следующей редкости.' },
    resonate: { name: 'Резонанс', icon: 'fa-gem', flame: '#b066ff', text: 'Кристалл → случайный кристалл той же редкости с выбранным тегом.' },
    split: { name: 'Расщепление', icon: 'fa-burst', flame: '#5fe0b8', text: 'Кристалл → Кости Хитов обратно.' }
};

export class MemoryAltar extends ApplicationV2 {
    constructor(actor, options = {}) {
        super({ id: `gachadnd-memory-altar-${actor.id}`, ...options });
        this.actor = actor;
        this.ritual = 'smelt';
        this.slots = [];
        this.tag = null;
        this.mergeId = null;
        this.result = null;
    }

    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-memory-altar'],
        tag: 'div',
        window: { title: 'Алтарь Памяти', icon: 'fas fa-campground', resizable: false },
        actions: {
            ritual: MemoryAltar.#onRitual,
            pick: MemoryAltar.#onPick,
            unslot: MemoryAltar.#onUnslot,
            tag: MemoryAltar.#onTag,
            mergePick: MemoryAltar.#onMergePick,
            conjure: MemoryAltar.#onConjure
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

    // Ингредиенты, подходящие выбранному ритуалу
    #pool(all) {
        if (this.ritual === 'smelt') return all.filter(i => SMELT[i.rarity]);
        if (this.ritual === 'split') return all.filter(i => SPLIT[i.rarity]);
        if (this.ritual === 'resonate') return all;
        return [];
    }

    #state() {
        const all = ingredients(this.actor);
        this.slots = this.slots.filter(key => this.#pool(all).some(i => i.key === key));
        const slotted = this.slots.map(key => all.find(i => i.key === key));
        return { all, pool: this.#pool(all), slotted };
    }

    // Что получится и можно ли сотворить
    #recipe(slotted) {
        const hd = availableHitDice(this.actor);
        if (this.ritual === 'merge') {
            const item = this.actor.items.get(this.mergeId);
            if (!item) return { ready: false, note: 'Выберите навык Памяти, для которого в инвентаре есть повторный кристалл.' };
            const next = (item.flags[MODULE_ID].rank ?? 1) + 1;
            const cost = FORGE_COST[next] ?? 2;
            return { ready: hd >= cost, cost, note: `${item.name} → ранг ${romanRank(next)}`, short: hd < cost ? 'Не хватает Костей Хитов' : null };
        }
        if (this.ritual === 'smelt') {
            const rarity = slotted[0]?.rarity;
            const weight = slotted.reduce((sum, i) => sum + i.weight, 0);
            if (!rarity) return { ready: false, note: 'Положите в котёл 3 кристалла одной редкости.' };
            if (slotted.some(i => i.rarity !== rarity)) return { ready: false, note: 'Все кристаллы в котле должны быть одной редкости.' };
            const smelt = SMELT[rarity];
            if (weight < 3) return { ready: false, cost: smelt.cost, note: `Ещё ${3 - weight} — нужно 3 кристалла редкости «${RARITY[rarity].label}».` };
            return { ready: hd >= smelt.cost, cost: smelt.cost, note: `Случайный кристалл редкости «${RARITY[smelt.to].label}»`, short: hd < smelt.cost ? 'Не хватает Костей Хитов' : null };
        }
        if (this.ritual === 'resonate') {
            const ing = slotted[0];
            if (!ing) return { ready: false, cost: RESONANCE_COST, note: 'Положите в котёл один кристалл и выберите тег.' };
            return { ready: hd >= RESONANCE_COST, cost: RESONANCE_COST, note: `Случайный кристалл редкости «${RARITY[ing.rarity].label}» с тегом «${this.tag}»`, short: hd < RESONANCE_COST ? 'Не хватает Костей Хитов' : null };
        }
        const ing = slotted[0];
        if (!ing) return { ready: false, note: 'Положите в котёл зелёный, синий или фиолетовый кристалл.' };
        return { ready: true, gain: SPLIT[ing.rarity], note: `Кости Хитов: +${SPLIT[ing.rarity]}` };
    }

    #slotLimit() {
        return { smelt: 3, resonate: 1, split: 1 }[this.ritual] ?? 0;
    }

    async _renderHTML() {
        const tags = Object.keys(getSynergyDictionary());
        this.tag ??= tags[0];
        const { pool, slotted } = this.#state();
        const ritual = RITUALS[this.ritual];
        const recipe = this.#recipe(slotted);
        const hd = availableHitDice(this.actor);
        const hdMax = this.actor.system.attributes?.hd?.max ?? hd;

        // Медальоны ритуалов — дуга слева от котла
        const medals = Object.entries(RITUALS).map(([key, r]) => `
            <button type="button" class="gd-medal ${key === this.ritual ? 'active' : ''}" data-action="ritual" data-ritual="${key}" style="--flame: ${r.flame}" title="${r.text}">
                <span class="gd-medal-name">${r.name}</span>
                <span class="gd-medal-disc"><i class="fas ${r.icon}"></i></span>
            </button>`).join('');

        // Над котлом — ячейки ингредиентов
        const crystalCard = (ing, action, extra = '') => `
            <div class="gd-crystal ${ing.kind}" style="--rarity: ${RARITY[ing.rarity].color}" data-action="${action}" data-key="${ing.key}" ${extra}
                 title="${esc(ing.name)}${ing.kind === 'skill' ? ' — навык из Памяти, сгорит в ритуале' : ''}${ing.weight > 1 ? ' — повтор без слияния, весит вдвое' : ''}">
                <i class="fas fa-gem"></i>
                <span>${esc(ing.name)}</span>
                ${ing.weight > 1 ? '<b class="gd-crystal-x2">×2</b>' : ''}
            </div>`;
        let slotsHtml = '';
        if (this.ritual === 'merge') {
            const item = this.actor.items.get(this.mergeId);
            // Навык не покидает Память: в котёл опускается только повторный кристалл
            const color = RARITY[item?.flags[MODULE_ID].rarity]?.color ?? '#ccc';
            slotsHtml = item
                ? `<div class="gd-mind" style="--rarity: ${color}"><i class="fas fa-brain"></i><span>${esc(item.name)}</span><small>в Памяти · ранг ${romanRank(item.flags[MODULE_ID].rank ?? 1)}</small></div>
                   <div class="gd-slot-plus"><i class="fas fa-arrow-left"></i></div>
                   <div class="gd-slot filled"><div class="gd-crystal" style="--rarity: ${color}"><i class="fas fa-gem"></i><span>${esc(item.name)}</span></div></div>`
                : '<div class="gd-mind empty"><i class="fas fa-brain"></i><span>Навык в Памяти</span></div><div class="gd-slot-plus"><i class="fas fa-arrow-left"></i></div><div class="gd-slot"></div>';
        } else {
            for (let i = 0; i < this.#slotLimit(); i++) {
                const ing = slotted[i];
                slotsHtml += `<div class="gd-slot ${ing ? 'filled' : ''}">${ing ? crystalCard(ing, 'unslot') : ''}</div>`;
            }
        }

        // Снизу — лента ингредиентов (для Слияния — навыки с повтором)
        let tray;
        if (this.ritual === 'merge') {
            const forgeable = this.actor.items.filter(i => isMemorySkill(i) && canRankUp(i) && findDuplicateCrystal(this.actor, i));
            tray = forgeable.map(item => `
                <div class="gd-crystal ${item.id === this.mergeId ? 'chosen' : ''}" style="--rarity: ${RARITY[item.flags[MODULE_ID].rarity]?.color ?? '#ccc'}" data-action="mergePick" data-item-id="${item.id}">
                    <i class="fas fa-brain"></i><span>${esc(item.name)}</span><b class="gd-crystal-x2">${romanRank(item.flags[MODULE_ID].rank ?? 1)}</b>
                </div>`).join('') || '<div class="gd-tray-empty">Нет навыков с повторным кристаллом в инвентаре.</div>';
        } else {
            // В Переплавке кристаллы другой редкости приглушены: их выбор начнёт котёл заново
            const smeltRarity = this.ritual === 'smelt' ? slotted[0]?.rarity : null;
            tray = pool.filter(i => !this.slots.includes(i.key))
                .map(i => crystalCard(i, 'pick', smeltRarity && i.rarity !== smeltRarity ? 'data-dim="1"' : '')).join('')
                || '<div class="gd-tray-empty">Нет подходящих кристаллов.</div>';
        }

        const tagsHtml = this.ritual === 'resonate'
            ? `<div class="gd-tags">${tags.map(t => `<button type="button" class="gd-tag ${t === this.tag ? 'active' : ''}" data-action="tag" data-tag="${t}">${t}</button>`).join('')}</div>` : '';

        const cost = recipe.gain ? `+${recipe.gain} КХ` : recipe.cost ? `−${recipe.cost} КХ` : '';
        const pips = Array.from({ length: Math.max(hdMax, hd) }, (_, i) => `<span class="gd-pip ${i < hd ? 'on' : ''}"></span>`).join('');
        const resultHtml = this.result
            ? `<div class="gd-result" style="--rarity: ${this.result.color}"><i class="fas ${this.result.icon}"></i><span>${esc(this.result.text)}</span></div>` : '';

        return `
            <div class="gd-cauldron-scene" style="--flame: ${ritual.flame}">
                <div class="gd-stage">
                    <h1>${ritual.name}</h1>
                    <div class="gd-subtitle">${ritual.text}</div>
                    <div class="gd-slots">${slotsHtml}</div>
                    <div class="gd-altar-row">
                        <div class="gd-medals">${medals}</div>
                        <div class="gd-cauldron">
                            <div class="gd-glow"></div>
                            <div class="gd-pot"><div class="gd-brew"><i></i><i></i><i></i><i></i><i></i></div></div>
                            <div class="gd-embers"><i></i><i></i><i></i><i></i><i></i><i></i></div>
                            ${resultHtml}
                        </div>
                        <div class="gd-medals-balance"></div>
                    </div>
                    ${tagsHtml}
                    <div class="gd-recipe">${esc(recipe.note)}${recipe.short ? ` · <em>${recipe.short}</em>` : ''}</div>
                    <button type="button" class="gd-conjure" data-action="conjure" ${recipe.ready ? '' : 'disabled'}>Сотворить ${cost ? `<b>${cost}</b>` : ''}</button>
                    <div class="gd-hd"><span>Кости Хитов ${hd} / ${Math.max(hdMax, hd)}</span><div class="gd-pips">${pips}</div></div>
                </div>
                <div class="gd-tray">${tray}</div>
            </div>`;
    }

    _replaceHTML(result, content) {
        content.innerHTML = result;
    }

    static #onRitual(event, target) {
        this.ritual = target.dataset.ritual;
        this.slots = [];
        this.result = null;
        this.render();
    }

    static #onPick(event, target) {
        // Переплавка: кристалл другой редкости начинает котёл заново
        if (this.ritual === 'smelt') {
            const { all } = this.#state();
            const rarity = all.find(i => i.key === target.dataset.key)?.rarity;
            const current = all.find(i => i.key === this.slots[0])?.rarity;
            if (current && rarity !== current) this.slots = [];
        }
        if (this.slots.length >= this.#slotLimit()) this.slots.shift();
        this.slots.push(target.dataset.key);
        this.result = null;
        this.render();
    }

    static #onUnslot(event, target) {
        this.slots = this.slots.filter(key => key !== target.dataset.key);
        this.render();
    }

    static #onTag(event, target) {
        this.tag = target.dataset.tag;
        this.render();
    }

    static #onMergePick(event, target) {
        this.mergeId = target.dataset.itemId;
        this.result = null;
        this.render();
    }

    static async #onConjure(event, target) {
        target.disabled = true;
        const { slotted } = this.#state();
        const done = await {
            merge: () => this.#merge(),
            smelt: () => this.#smelt(slotted),
            resonate: () => this.#resonate(slotted),
            split: () => this.#split(slotted)
        }[this.ritual]();
        if (done) {
            this.slots = [];
            this.result = done;
        }
        this.render();
    }

    async #merge() {
        const item = this.actor.items.get(this.mergeId);
        if (!item) return null;
        const rank = (item.flags[MODULE_ID].rank ?? 1) + 1;
        await forgeSkill(this.actor, item);
        this.mergeId = null;
        return { text: `${item.name} — ранг ${romanRank(rank)}`, color: '#ffb347', icon: 'fa-hammer' };
    }

    async #smelt(slotted) {
        const rarity = slotted[0]?.rarity;
        const smelt = SMELT[rarity];
        if (!smelt || slotted.some(i => i.rarity !== rarity)) return null;
        let weight = 0;
        const used = [];
        for (const ing of slotted) {
            if (weight >= 3) break;
            used.push(ing);
            weight += ing.weight;
        }
        if (weight < 3) return null;
        const result = await randomCrystal(smelt.to);
        if (!result) return ui.notifications.error('Не удалось получить кристалл: компендиум навыков недоступен.') && null;
        if (!(await spendHitDice(this.actor, smelt.cost))) return ui.notifications.warn('Не хватает Костей Хитов.') && null;
        for (const ing of used) await spend(ing);
        await this.actor.createEmbeddedDocuments('Item', [result]);
        await chat(this.actor, `<strong>Переплавка:</strong> ${used.map(i => esc(i.name)).join(', ')} → <strong>${esc(result.name)}</strong>`);
        return { text: result.name, color: RARITY[smelt.to].color, icon: 'fa-gem' };
    }

    async #resonate(slotted) {
        const ing = slotted[0];
        if (!ing) return null;
        const result = await randomCrystalWithTag(ing.rarity, this.tag);
        if (!result) {
            ui.notifications.warn(`Нет навыков редкости «${RARITY[ing.rarity].label}» с тегом «${this.tag}».`);
            return null;
        }
        if (!(await spendHitDice(this.actor, RESONANCE_COST))) return ui.notifications.warn('Не хватает Костей Хитов.') && null;
        await spend(ing);
        await this.actor.createEmbeddedDocuments('Item', [result]);
        await chat(this.actor, `<strong>Резонанс «${esc(this.tag)}»:</strong> ${esc(ing.name)} → <strong>${esc(result.name)}</strong>`);
        return { text: result.name, color: RARITY[ing.rarity].color, icon: 'fa-gem' };
    }

    async #split(slotted) {
        const ing = slotted[0];
        const gain = ing ? SPLIT[ing.rarity] : null;
        if (!gain) return null;
        const spent = [...(this.actor.system.attributes?.hd?.classes ?? [])].reduce((sum, c) => sum + (c.system.hd?.spent ?? 0), 0);
        if (!spent) {
            ui.notifications.warn('Все Кости Хитов и так на месте — расщеплять нечего.');
            return null;
        }
        await spend(ing);
        const restored = await restoreHitDice(this.actor, gain);
        await chat(this.actor, `<strong>Расщепление:</strong> ${esc(ing.name)} → +${restored} КХ`);
        return { text: `Кости Хитов +${restored}`, color: '#5fe0b8', icon: 'fa-heart' };
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
