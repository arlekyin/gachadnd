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
import { MindPhysics } from "./mind-physics.js";

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

// Фаза покачивания огонька привязана к часам и ключу, а не к моменту отрисовки:
// после перерисовки огонёк продолжает движение с той же точки, а не прыгает в начало
const BOB_PERIOD = 6;
function bobPhase(key) {
    let hash = 0;
    for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    return -((Date.now() / 1000 + (Math.abs(hash) % 600) / 100) % BOB_PERIOD);
}

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
    #physics = null;
    #drift = new Map();

    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-memory-altar'],
        tag: 'div',
        window: { title: 'Алтарь Памяти', icon: 'fas fa-campground', resizable: false },
        actions: {
            ritual: MemoryAltar.#onRitual,
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

    // Ошибка отрисовки не должна запирать Алтарь: состояние сбрасывается, и он рисуется заново
    async _renderHTML() {
        try {
            return this.#html();
        } catch (err) {
            console.error(`${MODULE_ID} | Алтарь Памяти:`, err);
            ui.notifications.error('Алтарь Памяти: ошибка отрисовки, выбор сброшен. Подробности в консоли (F12).');
            Object.assign(this, { ritual: 'smelt', slots: [], mergeId: null, result: null });
            return this.#html();
        }
    }

    #html() {
        const dictionary = getSynergyDictionary();
        const tags = Object.keys(dictionary);
        this.tag ??= tags[0];
        const { all, pool, slotted } = this.#state();
        const ritual = RITUALS[this.ritual];
        const recipe = this.#recipe(slotted);
        const hd = availableHitDice(this.actor);
        const hdMax = Math.max(this.actor.system.attributes?.hd?.max ?? hd, hd);
        const merge = this.ritual === 'merge';
        const at = ({ x, y }) => `left: ${x.toFixed(2)}%; top: ${y.toFixed(2)}%`;
        const tagColor = tag => `hsl(${Math.round(tags.indexOf(tag) * 360 / Math.max(tags.length, 1))}, 85%, 66%)`;

        // Ритуалы — дуга глифов слева
        const glyphs = Object.entries(RITUALS).map(([key, r]) => `
            <button type="button" class="gd-glyph ${key === this.ritual ? 'active' : ''}" data-action="ritual" data-ritual="${key}" style="--glow: ${r.glow}" title="${r.text}">
                <span class="gd-glyph-name">${r.name}</span>
                <span class="gd-glyph-disc"><i class="fas ${r.icon}"></i></span>
            </button>`).join('');

        // Слияние: навык Памяти ↔ его повторный кристалл в инвентаре
        const memory = this.actor.items.filter(isMemorySkill);
        const dupOf = new Map();
        for (const skill of memory) {
            if (!canRankUp(skill)) continue;
            const crystal = findDuplicateCrystal(this.actor, skill);
            if (crystal) dupOf.set(skill.id, crystal.id);
        }
        const skillForCrystal = new Map([...dupOf].map(([skill, crystal]) => [crystal, skill]));
        if (this.mergeId && !dupOf.has(this.mergeId)) this.mergeId = null;

        // Предел разума: гнёзда на орбите, экипированные навыки занимают их по порядку
        const level = this.actor.system.details?.level || 1;
        const cap = 6 + Math.floor(level / 2);
        const equipped = memory.filter(i => i.flags[MODULE_ID].is_active);
        const sockets = Math.max(cap, equipped.length);
        const orbitAt = n => {
            const angle = -Math.PI / 2 + (2 * Math.PI * n) / sockets;
            return { x: CORE.x + ORBIT.rx * Math.cos(angle), y: CORE.y + ORBIT.ry * Math.sin(angle) };
        };
        const nodePos = new Map(equipped.map((item, n) => [item.id, orbitAt(n)]));
        const nodes = equipped.map(item => {
            const flags = item.flags[MODULE_ID];
            const can = merge && dupOf.has(item.id);
            const itemTags = flags.tags ?? [];
            return `
                <div class="gd-node ${can ? 'can-merge' : ''} ${merge && item.id === this.mergeId ? 'chosen' : ''}" style="${at(nodePos.get(item.id))}; --rarity: ${RARITY[flags.rarity]?.color ?? '#c9a75d'}"
                     data-item-id="${item.id}" ${can ? 'data-action="mergePick"' : ''} title="${esc(item.name)} — ранг ${romanRank(flags.rank ?? 1)}${itemTags.length ? `\nТеги: ${esc(itemTags.join(', '))}` : ''}">
                    <span class="gd-node-disc"><i class="fas fa-brain"></i><b>${romanRank(flags.rank ?? 1)}</b></span>
                    <span class="gd-node-name">${esc(item.name)}</span>
                </div>`;
        }).join('');
        const emptySockets = Array.from({ length: sockets - equipped.length }, (_, n) => `<div class="gd-socket" style="${at(orbitAt(equipped.length + n))}"></div>`).join('');

        // Нити сознания: общий тег связывает два навыка — из таких нитей и растут синергии
        const threads = [];
        const tagTotals = {};
        for (const item of equipped) for (const t of item.flags[MODULE_ID].tags ?? []) tagTotals[t] = (tagTotals[t] ?? 0) + 1;
        equipped.forEach((a, i) => equipped.slice(i + 1).forEach(b => {
            const shared = (a.flags[MODULE_ID].tags ?? []).filter(t => (b.flags[MODULE_ID].tags ?? []).includes(t));
            shared.forEach((tag, k) => {
                const p = nodePos.get(a.id), q = nodePos.get(b.id);
                const bend = 0.45 + 0.18 * k;
                const c = { x: (p.x + q.x) / 2 + (CORE.x - (p.x + q.x) / 2) * bend, y: (p.y + q.y) / 2 + (CORE.y - (p.y + q.y) / 2) * bend };
                threads.push(`<path d="M ${p.x} ${p.y} Q ${c.x} ${c.y} ${q.x} ${q.y}" style="--thread: ${tagColor(tag)}" data-a="${a.id}" data-b="${b.id}" vector-effect="non-scaling-stroke"/>`);
            });
        }));
        const flows = [];

        // Огонёк — кристалл или неэкипированный навык Памяти
        const mote = (ing, pos, { tap = '', cls = '', delay = 0, mergeSkill = '' } = {}) => `
            <div class="gd-mote ${ing.kind} ${cls}" style="${at(pos)}; --rarity: ${RARITY[ing.rarity].color}; --delay: ${delay}s" data-key="${ing.key}" data-item-id="${ing.item.id}"
                 data-tap="${tap}" ${mergeSkill ? `data-merge-skill="${mergeSkill}"` : ''}
                 title="${esc(ing.name)}${ing.kind === 'skill' ? ' — навык из Памяти, сгорит в ритуале' : ''}${ing.weight > 1 ? ' — повтор без слияния, весит вдвое' : ''}">
                <span class="gd-mote-body">
                    <span class="gd-mote-orb"><i class="fas ${ing.kind === 'skill' ? 'fa-brain' : 'fa-gem'}"></i>${ing.weight > 1 ? '<b>×2</b>' : ''}</span>
                    <span class="gd-mote-name">${esc(ing.name)}</span>
                </span>
            </div>`;

        // Фокус у ядра: то, что сейчас погружено в ритуал
        let focus = '';
        let dupKey = null;
        if (merge) {
            dupKey = this.mergeId ? `${dupOf.get(this.mergeId)}:0` : null;
            const ing = all.find(i => i.key === dupKey);
            if (ing) {
                focus = mote(ing, CORE, { tap: 'unmerge', cls: 'focused' });
                const target = nodePos.get(this.mergeId);
                if (target) flows.push(`<line x1="${CORE.x}" y1="${CORE.y}" x2="${target.x}" y2="${target.y}" vector-effect="non-scaling-stroke"/>`);
            }
        } else {
            const limit = this.#slotLimit();
            const points = FOCUS[limit] ?? FOCUS[1];
            focus = points.map((pos, n) => {
                const ing = slotted[n];
                if (ing && limit > 1) flows.push(`<line x1="${pos.x}" y1="${pos.y}" x2="${CORE.x}" y2="${CORE.y}" vector-effect="non-scaling-stroke"/>`);
                return ing ? mote(ing, pos, { tap: 'unslot', cls: 'focused' }) : `<div class="gd-focus-empty" style="${at(pos)}"></div>`;
            }).join('');
        }

        // Туман: всё, что ещё не стало частью персонажа; брошенные огоньки остаются там, где упали
        let drifting;
        if (merge) {
            drifting = all.filter(i => i.key !== dupKey).map(i => {
                const skill = i.kind === 'skill' ? (dupOf.has(i.item.id) ? i.item.id : null) : skillForCrystal.get(i.item.id);
                return { ing: i, tap: skill ? 'merge' : '', mergeSkill: skill ?? '', cls: skill ? (skill === this.mergeId ? 'can-merge chosen' : 'can-merge') : 'dim' };
            });
        } else {
            const smeltRarity = this.ritual === 'smelt' ? slotted[0]?.rarity : null;
            drifting = pool.filter(i => !this.slots.includes(i.key)).map(i => ({ ing: i, tap: 'pick', cls: smeltRarity && i.rarity !== smeltRarity ? 'off' : '' }));
            // Неподходящие ритуалу воспоминания тоже плавают в тумане — их можно бросать
            drifting.push(...all.filter(i => !pool.includes(i)).map(i => ({ ing: i, tap: '', cls: 'dim' })));
        }
        // Место в тумане закрепляется за огоньком при первом появлении: иначе выбор одного
        // сдвигал бы раскладку остальных
        const motes = drifting.map(({ ing, tap, cls, mergeSkill }, n) => {
            if (!this.#drift.has(ing.key)) this.#drift.set(ing.key, fogPosition(n, drifting.length));
            return mote(ing, this.#drift.get(ing.key), { tap, cls, mergeSkill, delay: bobPhase(ing.key) });
        }).join('');
        const emptyNote = drifting.length ? '' : '<div class="gd-fog-empty">Туман пуст.</div>';

        // Легенда нитей — какие теги уже сплетены и насколько
        const legend = Object.entries(tagTotals).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([tag, n]) => {
            const next = dictionary[tag]?.thresholds?.find(t => t.count > n)?.count;
            return `<div class="gd-legend-row" style="--thread: ${tagColor(tag)}"><i></i><span>${esc(tag)}</span><b>${n}${next ? ` / ${next}` : ''}</b></div>`;
        }).join('');

        const svg = `<svg class="gd-links" viewBox="0 0 100 100" preserveAspectRatio="none">
            <g class="gd-threads">${threads.join('')}</g><g class="gd-flows">${flows.join('')}</g></svg>`;

        const tagsHtml = this.ritual === 'resonate'
            ? `<div class="gd-tags">${tags.map(t => `<button type="button" class="gd-tag ${t === this.tag ? 'active' : ''}" data-action="tag" data-tag="${t}" style="--thread: ${tagColor(t)}">${t}</button>`).join('')}</div>` : '';
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
                    ${legend ? `<div class="gd-legend"><div class="gd-legend-title">Нити сознания</div>${legend}</div>` : ''}
                </aside>
                <div class="gd-mind-field">
                    ${svg}
                    <div class="gd-orbit"></div>
                    <div class="gd-core" style="${at(CORE)}"><span></span><em>${equipped.length} / ${cap}</em></div>
                    ${emptySockets}
                    ${nodes}
                    ${motes}
                    ${focus}
                    ${resultHtml}
                    ${emptyNote}
                    <div class="gd-mind-hint">Огоньки можно брать, бросать и опускать в ядро</div>
                    <div class="gd-mind-controls">
                        <div class="gd-recipe">${esc(recipe.note)}${recipe.short ? ` · <em>${recipe.short}</em>` : ''}</div>
                        <button type="button" class="gd-conjure" data-action="conjure" ${recipe.ready ? '' : 'disabled'}>${ritual.verb} ${cost ? `<b>${cost}</b>` : ''}</button>
                        <div class="gd-hd"><span>Кости Хитов ${hd} / ${hdMax}</span><div class="gd-pips">${pips}</div></div>
                    </div>
                </div>
            </div>`;
    }

    // Физика огоньков и подсветка нитей узла
    _onRender(context, options) {
        super._onRender?.(context, options);
        this.#physics?.destroy();
        const field = this.element.querySelector('.gd-mind-field');
        if (!field) return;
        this.#physics = new MindPhysics(field, {
            onTap: el => this.#interact(el, { type: 'tap' }),
            onDrop: (el, target) => this.#interact(el, target),
            onSettle: (key, pos) => this.#drift.set(key, pos)
        });
        for (const node of field.querySelectorAll('.gd-node')) {
            const id = node.dataset.itemId;
            const lit = on => field.querySelectorAll(`.gd-threads path[data-a="${id}"], .gd-threads path[data-b="${id}"]`).forEach(p => p.classList.toggle('lit', on));
            node.addEventListener('pointerenter', () => lit(true));
            node.addEventListener('pointerleave', () => lit(false));
        }
    }

    _onClose(options) {
        super._onClose?.(options);
        this.#physics?.destroy();
        this.#physics = null;
    }

    // Нажатие на огонёк или бросок в цель. Возвращает true, если цель его приняла
    #interact(el, target) {
        const { key, tap, mergeSkill } = el.dataset;
        const focused = el.classList.contains('focused');
        if (focused) {
            if (target.type === 'tap' || target.type === 'away') {
                if (this.ritual === 'merge') this.mergeId = null;
                else this.slots = this.slots.filter(k => k !== key);
                this.render();
                return true;
            }
            return false;
        }
        if (tap === 'merge' && (target.type === 'tap' || target.type === 'core' || (target.type === 'node' && target.id === mergeSkill))) {
            this.mergeId = mergeSkill;
            this.result = null;
            this.render();
            return true;
        }
        if (tap === 'pick' && (target.type === 'tap' || target.type === 'core')) {
            this.#pick(key);
            return true;
        }
        if (target.type === 'tap' && el.classList.contains('dim')) ui.notifications.info('Это воспоминание не подходит выбранному ритуалу.');
        return false;
    }

    #pick(key) {
        // Переплавка: кристалл другой редкости начинает фокус заново
        if (this.ritual === 'smelt') {
            const { all } = this.#state();
            const rarity = all.find(i => i.key === key)?.rarity;
            const current = all.find(i => i.key === this.slots[0])?.rarity;
            if (current && rarity !== current) this.slots = [];
        }
        if (this.slots.length >= this.#slotLimit()) this.slots.shift();
        this.slots.push(key);
        this.result = null;
        this.render();
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
