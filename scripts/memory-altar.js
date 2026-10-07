/**
 * Gacha Roguelike dnd5e — Алтарь Памяти: погружение в сознание персонажа на Привале
 *
 * В центре ядро сознания, на орбите — экипированные навыки Памяти. Кристаллы и
 * неэкипированные навыки дрейфуют огоньками в тумане; выбранные стягиваются к ядру.
 *
 * Ритуалы за Кости Хитов:
 *   Слияние     — повторный кристалл растворяется в навыке Памяти и повышает его ранг
 *                 (ранг II — 1 КХ, ранг III — 2 КХ); сам навык Память не покидает;
 *   Переплавка  — 3 кристалла одной редкости → случайный кристалл следующей редкости;
 *   Резонанс    — кристалл → случайный кристалл той же редкости с выбранным тегом (1 КХ);
 *   Расщепление — кристалл → Кости Хитов обратно (зелёный, синий — 1, фиолетовый — 2).
 * Воспоминания для ритуалов — кристаллы из инвентаря и неэкипированные навыки Памяти (они сгорают).
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

// Ритуалы: порядок в дуге, подписи, глагол кнопки и цвет свечения сознания
const RITUALS = {
    merge: { name: 'Слияние', verb: 'Слить', icon: 'fa-link', glow: '#e8c26a', text: 'Повторный кристалл растворяется в навыке Памяти и повышает его ранг.' },
    smelt: { name: 'Переплавка', verb: 'Переплавить', icon: 'fa-fire', glow: '#ff7a3c', text: '3 воспоминания одной редкости сливаются в случайный кристалл следующей редкости.' },
    resonate: { name: 'Резонанс', verb: 'Настроить', icon: 'fa-wave-square', glow: '#b066ff', text: 'Кристалл перестраивается на частоту выбранного тега — той же редкости.' },
    split: { name: 'Расщепление', verb: 'Отпустить', icon: 'fa-wind', glow: '#5fe0b8', text: 'Кристалл рассеивается в туман и возвращает телу Кости Хитов.' }
};

// Геометрия сознания в процентах поля: ядро, орбита Памяти, точки фокуса
const CORE = { x: 50, y: 46 };
const ORBIT = { rx: 17, ry: 24 };
const FOCUS = {
    1: [CORE],
    3: [-90, 30, 150].map(deg => ({ x: CORE.x + 8 * Math.cos(deg * Math.PI / 180), y: CORE.y + 11 * Math.sin(deg * Math.PI / 180) }))
};

// Огоньки тумана — по эллиптическому поясу, низ оставлен под кнопку
function fogPosition(n, total) {
    const from = 125, span = 290;
    const deg = from + (span * (n + 0.5)) / Math.max(total, 1);
    const outer = n % 2 === 1;
    const rad = deg * Math.PI / 180;
    return { x: CORE.x + (outer ? 43 : 32) * Math.cos(rad), y: CORE.y + (outer ? 41 : 33) * Math.sin(rad) };
}

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

    #dived = false;

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
            if (!rarity) return { ready: false, note: 'Притяните из тумана 3 воспоминания одной редкости.' };
            if (slotted.some(i => i.rarity !== rarity)) return { ready: false, note: 'Все воспоминания в фокусе должны быть одной редкости.' };
            const smelt = SMELT[rarity];
            if (weight < 3) return { ready: false, cost: smelt.cost, note: `Ещё ${3 - weight} — нужно 3 кристалла редкости «${RARITY[rarity].label}».` };
            return { ready: hd >= smelt.cost, cost: smelt.cost, note: `Случайный кристалл редкости «${RARITY[smelt.to].label}»`, short: hd < smelt.cost ? 'Не хватает Костей Хитов' : null };
        }
        if (this.ritual === 'resonate') {
            const ing = slotted[0];
            if (!ing) return { ready: false, cost: RESONANCE_COST, note: 'Притяните из тумана одно воспоминание и выберите тег.' };
            return { ready: hd >= RESONANCE_COST, cost: RESONANCE_COST, note: `Случайный кристалл редкости «${RARITY[ing.rarity].label}» с тегом «${this.tag}»`, short: hd < RESONANCE_COST ? 'Не хватает Костей Хитов' : null };
        }
        const ing = slotted[0];
        if (!ing) return { ready: false, note: 'Притяните из тумана зелёное, синее или фиолетовое воспоминание.' };
        return { ready: true, gain: SPLIT[ing.rarity], note: `Кости Хитов: +${SPLIT[ing.rarity]}` };
    }

    #slotLimit() {
        return { smelt: 3, resonate: 1, split: 1 }[this.ritual] ?? 0;
    }

    async _renderHTML() {
        const tags = Object.keys(getSynergyDictionary());
        this.tag ??= tags[0];
        const { all, pool, slotted } = this.#state();
        const ritual = RITUALS[this.ritual];
        const recipe = this.#recipe(slotted);
        const hd = availableHitDice(this.actor);
        const hdMax = Math.max(this.actor.system.attributes?.hd?.max ?? hd, hd);
        const merge = this.ritual === 'merge';
        const at = ({ x, y }) => `left: ${x.toFixed(2)}%; top: ${y.toFixed(2)}%`;
        const lines = [];

        // Ритуалы — дуга глифов слева
        const glyphs = Object.entries(RITUALS).map(([key, r]) => `
            <button type="button" class="gd-glyph ${key === this.ritual ? 'active' : ''}" data-action="ritual" data-ritual="${key}" style="--glow: ${r.glow}" title="${r.text}">
                <span class="gd-glyph-name">${r.name}</span>
                <span class="gd-glyph-disc"><i class="fas ${r.icon}"></i></span>
            </button>`).join('');

        // Орбита сознания — экипированные навыки Памяти; в Слиянии их можно выбрать
        const mergeable = new Set(this.actor.items.filter(i => isMemorySkill(i) && canRankUp(i) && findDuplicateCrystal(this.actor, i)).map(i => i.id));
        const equipped = this.actor.items.filter(i => isMemorySkill(i) && i.flags[MODULE_ID].is_active);
        const nodePos = new Map();
        const nodes = equipped.map((item, n) => {
            const angle = -Math.PI / 2 + (2 * Math.PI * n) / equipped.length;
            const pos = { x: CORE.x + ORBIT.rx * Math.cos(angle), y: CORE.y + ORBIT.ry * Math.sin(angle) };
            nodePos.set(item.id, pos);
            lines.push({ from: CORE, to: pos, cls: 'orbit' });
            const flags = item.flags[MODULE_ID];
            const can = merge && mergeable.has(item.id);
            return `
                <div class="gd-node ${can ? 'can-merge' : ''} ${merge && item.id === this.mergeId ? 'chosen' : ''}" style="${at(pos)}; --rarity: ${RARITY[flags.rarity]?.color ?? '#c9a75d'}"
                     ${can ? `data-action="mergePick" data-item-id="${item.id}"` : ''} title="${esc(item.name)} — ранг ${romanRank(flags.rank ?? 1)}">
                    <span class="gd-node-disc"><i class="fas fa-brain"></i><b>${romanRank(flags.rank ?? 1)}</b></span>
                    <span class="gd-node-name">${esc(item.name)}</span>
                </div>`;
        }).join('');

        // Огонёк — кристалл или неэкипированный навык Памяти
        const mote = (ing, pos, { action = '', cls = '', delay = 0 } = {}) => `
            <div class="gd-mote ${ing.kind} ${cls}" style="${at(pos)}; --rarity: ${RARITY[ing.rarity].color}; --delay: ${delay}s" ${action ? `data-action="${action}"` : ''} data-key="${ing.key}" data-item-id="${ing.item.id}"
                 title="${esc(ing.name)}${ing.kind === 'skill' ? ' — навык из Памяти, сгорит в ритуале' : ''}${ing.weight > 1 ? ' — повтор без слияния, весит вдвое' : ''}">
                <span class="gd-mote-body">
                    <span class="gd-mote-orb"><i class="fas ${ing.kind === 'skill' ? 'fa-brain' : 'fa-gem'}"></i>${ing.weight > 1 ? '<b>×2</b>' : ''}</span>
                    <span class="gd-mote-name">${esc(ing.name)}</span>
                </span>
            </div>`;

        // Фокус у ядра: то, что сейчас погружено в ритуал
        let focus = '';
        const dup = merge ? findDuplicateCrystal(this.actor, this.actor.items.get(this.mergeId)) : null;
        const dupKey = dup ? `${dup.id}:0` : null;
        if (merge) {
            const chosen = this.actor.items.get(this.mergeId);
            const target = nodePos.get(this.mergeId);
            const ing = all.find(i => i.key === dupKey);
            if (chosen && ing) {
                focus = mote(ing, CORE, { cls: 'focused' });
                if (target) lines.push({ from: CORE, to: target, cls: 'flow' });
            }
        } else {
            const limit = this.#slotLimit();
            const points = FOCUS[limit] ?? FOCUS[1];
            focus = points.map((pos, n) => {
                const ing = slotted[n];
                if (ing && limit > 1) lines.push({ from: pos, to: CORE, cls: 'flow' });
                return ing ? mote(ing, pos, { action: 'unslot', cls: 'focused' }) : `<div class="gd-focus-empty" style="${at(pos)}"></div>`;
            }).join('');
        }

        // Туман: всё, что ещё не стало частью персонажа, дрейфует по краю
        let drifting;
        if (merge) {
            drifting = all.filter(i => i.key !== dupKey).map(i => ({ ing: i, action: i.kind === 'skill' && mergeable.has(i.item.id) ? 'mergePick' : '', cls: i.kind === 'skill' && mergeable.has(i.item.id) ? (i.item.id === this.mergeId ? 'can-merge chosen' : 'can-merge') : 'dim' }));
        } else {
            const smeltRarity = this.ritual === 'smelt' ? slotted[0]?.rarity : null;
            drifting = pool.filter(i => !this.slots.includes(i.key)).map(i => ({ ing: i, action: 'pick', cls: smeltRarity && i.rarity !== smeltRarity ? 'dim' : '' }));
        }
        const motes = drifting.map(({ ing, action, cls }, n) => mote(ing, fogPosition(n, drifting.length), { action, cls, delay: -(n * 0.7) % 6 })).join('');
        const emptyNote = drifting.length ? '' : `<div class="gd-fog-empty">${merge ? 'Туман пуст.' : 'В тумане нет подходящих воспоминаний.'}</div>`;

        // Связи сознания — тонкие линии поверх тумана
        const svg = `<svg class="gd-links" viewBox="0 0 100 100" preserveAspectRatio="none">${lines.map(l =>
            `<line class="${l.cls}" x1="${l.from.x}" y1="${l.from.y}" x2="${l.to.x}" y2="${l.to.y}" vector-effect="non-scaling-stroke"/>`).join('')}</svg>`;

        const tagsHtml = this.ritual === 'resonate'
            ? `<div class="gd-tags">${tags.map(t => `<button type="button" class="gd-tag ${t === this.tag ? 'active' : ''}" data-action="tag" data-tag="${t}">${t}</button>`).join('')}</div>` : '';
        const cost = recipe.gain ? `+${recipe.gain} КХ` : recipe.cost ? `−${recipe.cost} КХ` : '';
        const pips = Array.from({ length: hdMax }, (_, i) => `<span class="gd-pip ${i < hd ? 'on' : ''}"></span>`).join('');
        const resultHtml = this.result
            ? `<div class="gd-result" style="--rarity: ${this.result.color}"><i class="fas ${this.result.icon}"></i><span>${esc(this.result.text)}</span></div>` : '';
        const dive = this.#dived ? '' : 'diving';
        this.#dived = true;

        return `
            <div class="gd-mindscape ${dive}" style="--glow: ${ritual.glow}">
                <div class="gd-fog"><i></i><i></i><i></i></div>
                <aside class="gd-mind-side">
                    <h1>${ritual.name}</h1>
                    <div class="gd-subtitle">${ritual.text}</div>
                    <div class="gd-glyphs">${glyphs}</div>
                    ${tagsHtml}
                </aside>
                <div class="gd-mind-field">
                    ${svg}
                    <div class="gd-orbit"></div>
                    <div class="gd-core" style="${at(CORE)}"><span></span></div>
                    ${nodes}
                    ${motes}
                    ${focus}
                    ${resultHtml}
                    ${emptyNote}
                    <div class="gd-mind-controls">
                        <div class="gd-recipe">${esc(recipe.note)}${recipe.short ? ` · <em>${recipe.short}</em>` : ''}</div>
                        <button type="button" class="gd-conjure" data-action="conjure" ${recipe.ready ? '' : 'disabled'}>${ritual.verb} ${cost ? `<b>${cost}</b>` : ''}</button>
                        <div class="gd-hd"><span>Кости Хитов ${hd} / ${hdMax}</span><div class="gd-pips">${pips}</div></div>
                    </div>
                </div>
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
        // Переплавка: кристалл другой редкости начинает фокус заново
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
        return { text: `${item.name} — ранг ${romanRank(rank)}`, color: '#e8c26a', icon: 'fa-link' };
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
