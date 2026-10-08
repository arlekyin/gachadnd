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
 * Ингредиенты ритуалов — только кристаллы из инвентаря. Навыки Памяти уже стали частью
 * персонажа: Алтарь их не сжигает — это делает Очистка в Магазине. В Слиянии неэкипированные
 * навыки с повтором появляются в тумане как цели, а не как ингредиенты.
 * Красные и оранжевые кристаллы в ритуалах не участвуют. Повтор, который нельзя слить
 * (уникальный навык или максимальный ранг), в Переплавке считается за два кристалла.
 */

import { MODULE_ID } from "./constants.js";
import { isMemorySkill, naturalSlotCap } from "./synergy.js";
import { getSynergyDictionary } from "./synergy-data.js";
import { randomCrystal, randomCrystalWithTag, currentSkillName } from "./crystals.js";
import {
    canRankUp, forgeSkill, findDuplicateCrystal, FORGE_COST, romanRank,
    isCrystalItem, isUsableCrystal, availableHitDice, spendHitDice, restoreHitDice, consumeCrystal
} from "./inventory.js";
import { isAtRest } from "./memory-api.js";
import { onSocket, emit } from "./socket.js";
import { MindPhysics } from "./mind-physics.js";
import { AltarSynapses, ResonanceWeave } from "./altar-synapses.js";
import { MindCore } from "./altar-core.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const RARITY = {
    gray: { label: 'Серый', color: '#9d9d9d' },
    green: { label: 'Зелёный', color: '#1eff00' },
    blue: { label: 'Синий', color: '#0070dd' },
    purple: { label: 'Фиолетовый', color: '#a335ee' }
};
// Нити навыков в ядре — и красные, и оранжевые: в ритуалах они не участвуют, но в сознании есть
const THREAD_COLORS = { ...Object.fromEntries(Object.entries(RARITY).map(([k, r]) => [k, r.color])), red: '#ff003c', orange: '#ff8000' };
const RITUAL_RARITIES = Object.keys(RARITY);
const SMELT = { gray: { to: 'green', cost: 1 }, green: { to: 'blue', cost: 1 }, blue: { to: 'purple', cost: 2 } };
const SPLIT = { green: 1, blue: 1, purple: 2 };
const RESONANCE_COST = 1;
const BANNER_MS = 5000;

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Ингредиенты: кристаллы инвентаря серой–фиолетовой редкости
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
        }
    }
    return list.sort((a, b) => RITUAL_RARITIES.indexOf(a.rarity) - RITUAL_RARITIES.indexOf(b.rarity) || a.name.localeCompare(b.name));
}

// Карточка воспоминания: что за навык в огоньке или узле кольца — без похода в инвентарь
function memoryCard(item, kind) {
    return { item, ...memoryCardHead(item, kind) };
}

function memoryCardHead(item, kind) {
    const flags = item.flags?.[MODULE_ID] ?? {};
    const rarity = RARITY[flags.rarity] ?? { label: '', color: '#c9a75d' };
    const crystal = kind === 'crystal';
    const max = flags.max_rank ?? 1;
    return {
        kind: crystal ? `Кристалл · ${rarity.label.toLowerCase()}` : `Навык Памяти · ${rarity.label.toLowerCase()}${flags.is_active ? ' · экипирован' : ''}`,
        name: crystal ? currentSkillName(flags, item.name) : item.name,
        color: rarity.color,
        rank: !crystal && (max > 1 || flags.stacking) ? `Ранг ${romanRank(flags.rank ?? 1)}${max > 1 ? ` из ${romanRank(max)}` : ''}` : '',
        tags: flags.tags ?? []
    };
}

// Полное описание навыка с обогатителями Foundry; шапка (вид, редкость) и вводная кристалла — до последней черты
async function enrichedBody(item) {
    const html = String(item.system?.description?.value ?? '');
    const body = html.includes('<hr') ? html.slice(html.indexOf('>', html.lastIndexOf('<hr')) + 1) : html;
    const editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    if (!editor?.enrichHTML) return body;
    return editor.enrichHTML(body, { relativeTo: item, rollData: item.getRollData?.(), secrets: item.isOwner });
}

// Итог ритуала с новым кристаллом: навык, редкость, теги
function crystalBanner(label, crystal, rarity) {
    const flags = crystal.flags?.[MODULE_ID] ?? {};
    const tags = flags.tags ?? [];
    return {
        label, title: currentSkillName(flags, crystal.name), color: RARITY[rarity]?.color ?? '#c9a75d',
        sub: `${RARITY[rarity]?.label ?? ''} кристалл${tags.length ? ` · ${tags.join(', ')}` : ''}`
    };
}

// Ингредиент уходит в ритуал: кристалл расходуется
async function spend(ingredient) {
    await consumeCrystal(ingredient.item);
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
// Колесо тегов Резонанса — эллипс вокруг ядра, внутри пояса тумана
const WHEEL = { rx: 18, ry: 24 };
const FOCUS = {
    1: [CORE],
    3: [-90, 30, 150].map(deg => ({ x: CORE.x + 10.5 * Math.cos(deg * Math.PI / 180), y: CORE.y + 15 * Math.sin(deg * Math.PI / 180) }))
};

// Фаза покачивания огонька привязана к часам и ключу, а не к моменту отрисовки:
// после перерисовки огонёк продолжает движение с той же точки, а не прыгает в начало
const BOB_PERIOD = 6;
function bobPhase(key) {
    let hash = 0;
    for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    return -((Date.now() / 1000 + (Math.abs(hash) % 600) / 100) % BOB_PERIOD);
}

// Огоньки тумана — плотным эллиптическим поясом вокруг механизма ядра, низ оставлен под кнопку.
// Внутренний ряд — сразу за колесом тегов и кольцом Слияния, внешний — чуть дальше
function fogPosition(n, total) {
    const from = 125, span = 290;
    const deg = from + (span * (n + 0.5)) / Math.max(total, 1);
    const outer = n % 2 === 1;
    const rad = deg * Math.PI / 180;
    return { x: CORE.x + (outer ? 36 : 28) * Math.cos(rad), y: CORE.y + (outer ? 38 : 31) * Math.sin(rad) };
}

const TEMPLATES = 'modules/gachadnd/templates/memory-altar';
const PART_IDS = ['side', 'stage', 'fog', 'controls'];
// Классы огонька, которые зависят от ритуала и выбора, — их меняет синхронизация без перерисовки
const VIEW_CLASSES = ['focused', 'off', 'dim', 'can-merge', 'chosen'];
const at = ({ x, y }) => `left: ${x.toFixed(2)}%; top: ${y.toFixed(2)}%`;

/**
 * Окно из четырёх частей одного размера, наложенных слоями:
 *   side     — название, описание, ритуалы, теги Резонанса;
 *   stage    — ядро, кольцо Памяти, точки фокуса, линии притяжения;
 *   fog      — огоньки (кристаллы и неэкипированные навыки) с физикой;
 *   controls — итог ритуала, рецепт, кнопка, Кости Хитов.
 * Туман перерисовывается только при изменении инвентаря. Выбор, смена ритуала и тега
 * меняют роли огоньков на месте (#syncMotes) и перерисовывают остальные части.
 */
export class MemoryAltar extends HandlebarsApplicationMixin(ApplicationV2) {
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
    #ringShown = false;
    #physics = null;
    #synapses = null;
    #weave = new ResonanceWeave();
    #mind = new MindCore();
    #flareId = null;
    #drift = new Map();
    #cards = new Map();
    #bodies = new Map();
    #cardFor = null;
    #momentum = null;

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

    static PARTS = Object.fromEntries(PART_IDS.map(id => [id, { template: `${TEMPLATES}/${id}.hbs` }]));

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
        if (!isAtRest() && !game.user.isGM) return ui.notifications.warn('Алтарь Памяти доступен только на Привале.');
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

    // Прогноз под ядром: что получится из того, что сейчас в фокусе
    #forecast(slotted, hd, hdMax, memory) {
        const style = at({ x: CORE.x, y: CORE.y + 14 });
        if (this.ritual === 'merge') {
            const item = memory.find(i => i.id === this.mergeId);
            if (!item) return null;
            const rank = item.flags[MODULE_ID].rank ?? 1;
            return { style, color: RARITY[item.flags[MODULE_ID].rarity]?.color ?? '#e8c26a', text: `${item.name}: ранг ${romanRank(rank)} → ${romanRank(rank + 1)}` };
        }
        if (this.ritual === 'smelt') {
            const rarity = slotted[0]?.rarity;
            if (!rarity) return null;
            const weight = Math.min(3, slotted.reduce((sum, i) => sum + i.weight, 0));
            if (slotted.some(i => i.rarity !== rarity)) return { style, color: '#ff8a7a', text: 'Редкости не совпадают' };
            const to = SMELT[rarity]?.to;
            return { style, color: RARITY[to]?.color, text: `→ ${RARITY[to]?.label.toLowerCase()} кристалл`, sub: 'навык выпадет случайно', pips: [0, 1, 2].map(n => n < weight) };
        }
        const ing = slotted[0];
        if (!ing) return null;
        if (this.ritual === 'resonate') return { style, color: RARITY[ing.rarity].color, text: `→ ${RARITY[ing.rarity].label.toLowerCase()} кристалл`, sub: `тег «${this.tag}»` };
        return { style, color: '#5fe0b8', text: `Кости Хитов ${hd} → ${Math.min(hdMax, hd + SPLIT[ing.rarity])}`, sub: 'кристалл рассеется в туман' };
    }

    #slotLimit() {
        return { smelt: 3, resonate: 1, split: 1 }[this.ritual] ?? 0;
    }

    // ==========================================
    // МОДЕЛЬ: всё, что рисуют части окна
    // ==========================================

    // Ошибка в данных не должна запирать Алтарь: выбор сбрасывается, модель строится заново
    async _prepareContext() {
        try {
            return this.#model();
        } catch (err) {
            console.error(`${MODULE_ID} | Алтарь Памяти:`, err);
            ui.notifications.error('Алтарь Памяти: ошибка отрисовки, выбор сброшен. Подробности в консоли (F12).');
            Object.assign(this, { ritual: 'smelt', slots: [], mergeId: null, result: null });
            return this.#model();
        }
    }

    #model() {
        const tags = Object.keys(getSynergyDictionary());
        this.tag ??= tags[0];
        const { all, pool, slotted } = this.#state();
        const ritual = { key: this.ritual, ...RITUALS[this.ritual] };
        const merge = this.ritual === 'merge';
        const recipe = this.#recipe(slotted);
        const hdValue = availableHitDice(this.actor);
        const hdMax = Math.max(this.actor.system.attributes?.hd?.max ?? hdValue, hdValue);

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

        // Кольцо Памяти — только в Слиянии: гнёзда Предела разума, экипированные навыки по порядку
        const cap = naturalSlotCap(this.actor);
        const active = memory.filter(i => i.flags[MODULE_ID].is_active);
        const equipped = merge ? active : [];
        const sockets = Math.max(cap, active.length);
        const orbitAt = n => {
            const angle = -Math.PI / 2 + (2 * Math.PI * n) / sockets;
            return { x: CORE.x + ORBIT.rx * Math.cos(angle), y: CORE.y + ORBIT.ry * Math.sin(angle) };
        };
        const nodePos = new Map(equipped.map((item, n) => [item.id, orbitAt(n)]));
        const nodes = equipped.map(item => {
            const flags = item.flags[MODULE_ID];
            const canMerge = dupOf.has(item.id);
            return {
                id: item.id, name: item.name, rank: romanRank(flags.rank ?? 1), canMerge,
                cls: [canMerge && 'can-merge', item.id === this.mergeId && 'chosen'].filter(Boolean).join(' '),
                style: `${at(nodePos.get(item.id))}; --rarity: ${RARITY[flags.rarity]?.color ?? '#c9a75d'}`
            };
        });

        // Роли огоньков: в фокусе у ядра, доступен ритуалу, приглушён
        const flows = [];
        const focusEmpty = [];
        const views = new Map();
        const dupKey = merge && this.mergeId ? `${dupOf.get(this.mergeId)}:0` : null;
        if (merge) {
            const target = nodePos.get(this.mergeId);
            if (all.some(i => i.key === dupKey)) {
                views.set(dupKey, { cls: ['focused'], tap: 'unmerge', pos: CORE });
                if (target) flows.push({ x1: CORE.x, y1: CORE.y, x2: target.x, y2: target.y });
            }
            for (const i of all) {
                if (i.key === dupKey) continue;
                const skill = skillForCrystal.get(i.item.id);
                views.set(i.key, skill
                    ? { cls: ['can-merge', ...(skill === this.mergeId ? ['chosen'] : [])], tap: 'merge', mergeSkill: skill }
                    : { cls: ['dim'] });
            }
        } else {
            const points = FOCUS[this.#slotLimit()] ?? FOCUS[1];
            points.forEach((pos, n) => {
                const ing = slotted[n];
                // Переплавка: гнёзда соединены треугольником, грань горит, когда заняты оба конца
                if (points.length > 1) {
                    const next = points[(n + 1) % points.length];
                    flows.push({ x1: pos.x, y1: pos.y, x2: next.x, y2: next.y, cls: ing && slotted[(n + 1) % points.length] ? 'edge lit' : 'edge' });
                }
                if (!ing) return focusEmpty.push({ style: at(pos) });
                views.set(ing.key, { cls: ['focused'], tap: 'unslot', pos });
                if (points.length > 1) flows.push({ x1: pos.x, y1: pos.y, x2: CORE.x, y2: CORE.y });
            });
            const smeltRarity = this.ritual === 'smelt' ? slotted[0]?.rarity : null;
            for (const i of all) {
                if (views.has(i.key)) continue;
                if (!pool.includes(i)) views.set(i.key, { cls: ['dim'] });
                else views.set(i.key, { cls: smeltRarity && i.rarity !== smeltRarity ? ['off'] : [], tap: 'pick' });
            }
        }

        // Слияние: неэкипированные навыки с повтором — цели в тумане (не ингредиенты)
        const targets = !merge ? [] : memory.filter(i => !i.flags[MODULE_ID].is_active && dupOf.has(i.id)).map(item => {
            views.set(item.id, { cls: ['can-merge', ...(item.id === this.mergeId ? ['chosen'] : [])], tap: 'merge', mergeSkill: item.id });
            return { key: item.id, item, kind: 'skill', rarity: item.flags[MODULE_ID].rarity, name: item.name, weight: 1 };
        });
        // Место в тумане закрепляется за огоньком при первом появлении: выбор одного
        // не сдвигает раскладку остальных
        const fogItems = [...all, ...targets];
        this.#cards = new Map([
            ...fogItems.map(ing => [ing.key, {
                ...memoryCard(ing.item, ing.kind),
                note: ing.kind === 'skill' ? 'Навык из Памяти: бросьте в него повторный кристалл' : ing.weight > 1 ? 'Повтор без слияния — в Переплавке весит вдвое' : ''
            }]),
            ...equipped.map(item => [item.id, memoryCard(item, 'skill')])
        ]);
        const motes = fogItems.map((ing, n) => {
            if (!this.#drift.has(ing.key)) this.#drift.set(ing.key, fogPosition(n, fogItems.length));
            const view = views.get(ing.key) ?? { cls: [] };
            const pos = view.pos ?? this.#drift.get(ing.key);
            return {
                key: ing.key, itemId: ing.item.id, kind: ing.kind, name: ing.name, view, pos,
                cls: view.cls.join(' '), tap: view.tap ?? '', mergeSkill: view.mergeSkill ?? '',
                double: ing.weight > 1,
                style: `${at(pos)}; --rarity: ${RARITY[ing.rarity]?.color ?? '#c9a75d'}; --delay: ${bobPhase(ing.key)}s`
            };
        });

        // Резонанс: теги колесом вокруг ядра; выбранный обвивают пряди от ядра (ResonanceWeave)
        const wheel = this.ritual !== 'resonate' ? [] : tags.map((name, n) => {
            const angle = -Math.PI / 2 + (2 * Math.PI * n) / tags.length;
            const pos = { x: CORE.x + WHEEL.rx * Math.cos(angle), y: CORE.y + WHEEL.ry * Math.sin(angle) };
            return { name, active: name === this.tag, style: at(pos) };
        });
        // Переплавка накаляет ядро по мере заполнения гнёзд
        const heat = this.ritual === 'smelt' ? Math.min(1, slotted.reduce((sum, i) => sum + i.weight, 0) / 3) : 0;
        // Ядро сознания: нити экипированных навыков крепятся с той стороны, где навык стоит на кольце
        const mind = {
            ritual: this.ritual, glow: ritual.glow, at: CORE, heat, hd: hdValue, hdMax,
            overload: Math.max(0, active.length - cap),
            threads: active.map((item, n) => ({
                id: item.id, rank: item.flags[MODULE_ID].rank ?? 1,
                color: THREAD_COLORS[item.flags[MODULE_ID].rarity] ?? '#c9a75d', ...orbitAt(n)
            })),
            split: this.ritual === 'split' && slotted[0] ? { key: slotted[0].key, color: RARITY[slotted[0].rarity]?.color ?? '#c9a75d' } : null
        };

        return {
            ritual, recipe, motes, nodes, flows, focusEmpty, wheel, mind,
            forecast: this.#forecast(slotted, hdValue, hdMax, memory),
            shards: this.ritual === 'split' && slotted.length ? Array.from({ length: 10 }, (_, n) => ({ a: n * 36 + 8, d: (n % 5) * 0.32 })) : null,
            glyphs: Object.entries(RITUALS).map(([key, r]) => ({ key, ...r, active: key === this.ritual })),
            core: { style: `${at(CORE)}; --heat: ${heat.toFixed(2)}` },
            ring: merge ? { filled: equipped.length, cap } : null,
            sockets: merge ? Array.from({ length: sockets - equipped.length }, (_, n) => ({ style: at(orbitAt(equipped.length + n)) })) : [],
            cost: recipe.gain ? `+${recipe.gain} КХ` : recipe.cost ? `−${recipe.cost} КХ` : '',
            hd: { value: hdValue, max: hdMax, pips: Array.from({ length: hdMax }, (_, i) => i < hdValue) },
            // Баннер итога: продолжает с того же места при перерисовке, через 5 секунд исчезает
            result: this.result && Date.now() - this.result.at < BANNER_MS ? { ...this.result, delay: Date.now() - this.result.at } : null,
            diving: !this.#dived,
            ringIn: merge && !this.#ringShown
        };
    }

    // ==========================================
    // ОТРИСОВКА ЧАСТЕЙ
    // ==========================================

    // Огоньки в полёте запоминают место и скорость, если туман сейчас перерисуется
    async _preRender(context, options) {
        await super._preRender(context, options);
        if (!options.parts?.includes('fog')) return;
        this.#momentum = this.#physics?.snapshot() ?? new Map();
        for (const [key, { x, y }] of this.#momentum) this.#drift.set(key, { x, y });
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this.element.style.setProperty('--glow', context.ritual.glow);
        this.#dived = true;
        this.#bindCard();
        if (options.parts?.includes('stage')) {
            this.#ringShown = !!context.ring;
            // Связи кольца живут вместе со слоем ядра; после слияния по прядям навыка уходит вспышка
            this.#synapses?.stop();
            const canvas = this.#part('stage')?.querySelector('canvas.gd-synapses');
            this.#synapses = canvas ? new AltarSynapses(canvas, this.#part('stage')) : null;
            this.#synapses?.start();
            if (this.#flareId) this.#synapses?.flare(this.#flareId);
            if (this.#flareId) this.#mind.boost(this.#flareId);
            const mindCanvas = this.#part('stage')?.querySelector('canvas.gd-mind-core');
            if (mindCanvas) this.#mind.attach(mindCanvas, this.#part('stage'), context.mind);
            this.#flareId = null;
            // Пряди Резонанса переживают перерисовку: при смене тега втягиваются и прорастают к новому
            const weave = this.#part('stage')?.querySelector('canvas.gd-weave');
            if (weave) this.#weave.attach(weave, this.#part('stage'), this.tag);
            else this.#weave.stop();
        }
        if (!options.parts?.includes('fog')) return this.#physics?.refresh();
        this.#physics?.destroy();
        this.#physics = new MindPhysics(this.#part('fog'), {
            onTap: el => this.#interact(el, { type: 'tap' }),
            onDrop: (el, target) => this.#interact(el, target),
            onSettle: (key, pos) => this.#drift.set(key, pos),
            momentum: this.#momentum,
            obstacles: this.element
        });
        this.#momentum = null;
    }

    // Карточка живёт вне частей окна: перерисовка частей её не трогает. Наведение на огонёк или узел
    // кольца показывает её рядом с ним; при захвате огонька она прячется
    #bindCard() {
        const content = this.element.querySelector('.window-content');
        if (!content || content.querySelector('.gd-memory-card')) return;
        const card = document.createElement('div');
        card.className = 'gd-memory-card';
        content.append(card);
        const target = event => event.target.closest?.('.gd-mote, .gd-node');
        content.addEventListener('pointerover', event => {
            const el = target(event);
            if (!el || content.querySelector('.gd-mote.held')) return;
            this.#showCard(card, el);
        });
        content.addEventListener('pointerout', event => {
            const el = target(event);
            if (el && !el.contains(event.relatedTarget)) card.classList.remove('show');
        });
        content.addEventListener('pointerdown', () => card.classList.remove('show'));
    }

    #showCard(card, el) {
        const data = this.#cards.get(el.dataset.key ?? el.dataset.itemId);
        if (!data) return card.classList.remove('show');
        const token = Symbol();
        this.#cardFor = token;
        card.style.setProperty('--rarity', data.color);
        const body = this.#bodies.get(data.item.id);
        card.innerHTML = `
            <div class="gd-card-kind">${esc(data.kind)}</div>
            <div class="gd-card-name">${esc(data.name)}</div>
            ${data.rank ? `<div class="gd-card-rank">${esc(data.rank)}</div>` : ''}
            ${data.tags.length ? `<div class="gd-card-tags">${data.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
            ${data.note ? `<div class="gd-card-note">${esc(data.note)}</div>` : ''}
            <div class="gd-card-text">${body ?? ''}</div>`;
        this.#placeCard(card, el);
        card.classList.add('show');
        if (body !== undefined) return;
        enrichedBody(data.item).then(html => {
            this.#bodies.set(data.item.id, html);
            if (this.#cardFor !== token) return;
            card.querySelector('.gd-card-text').innerHTML = html;
            this.#placeCard(card, el);
        });
    }

    // Справа от огонька, а у правого края — слева; по высоте — рядом с ним, в пределах окна
    #placeCard(card, el) {
        const box = card.parentElement.getBoundingClientRect();
        const anchor = (el.querySelector('.gd-mote-orb, .gd-node-disc') ?? el).getBoundingClientRect();
        const width = card.offsetWidth, height = card.offsetHeight;
        let left = anchor.right - box.left + 18;
        if (left + width > box.width - 12) left = anchor.left - box.left - 18 - width;
        const top = Math.max(12, Math.min(box.height - height - 12, anchor.top - box.top + anchor.height / 2 - height / 2));
        card.style.left = `${Math.max(12, left)}px`;
        card.style.top = `${top}px`;
    }

    #part(id) {
        return this.parts?.[id] ?? this.element?.querySelector(`[data-application-part="${id}"]`);
    }

    _onClose(options) {
        super._onClose(options);
        this.#physics?.destroy();
        this.#physics = null;
        this.#synapses?.stop();
        this.#synapses = null;
        this.#weave.stop();
        this.#mind.stop();
    }

    // Новые роли огоньков применяются к уже нарисованному туману: класс, действие,
    // место. Огонёк, меняющий место (в фокус или обратно), плавно скользит
    #syncMotes(model) {
        const fog = this.#part('fog');
        if (!fog) return;
        for (const mote of model.motes) {
            const el = fog.querySelector(`.gd-mote[data-key="${CSS.escape(mote.key)}"]`);
            if (!el) continue;
            el.classList.remove(...VIEW_CLASSES);
            if (mote.view.cls.length) el.classList.add(...mote.view.cls);
            el.dataset.tap = mote.tap;
            el.dataset.mergeSkill = mote.mergeSkill;
            const left = `${mote.pos.x.toFixed(2)}%`, top = `${mote.pos.y.toFixed(2)}%`;
            if (Math.abs(parseFloat(el.style.left) - mote.pos.x) > 0.05 || Math.abs(parseFloat(el.style.top) - mote.pos.y) > 0.05) {
                el.classList.add('glide');
                el.style.left = left;
                el.style.top = top;
                clearTimeout(el._gdGlide);
                el._gdGlide = setTimeout(() => el.classList.remove('glide'), 500);
            }
        }
        this.#physics?.refresh();
    }

    // Изменился выбор: роли огоньков — на месте, остальные части — перерисовкой
    #update(parts) {
        if (!this.rendered) return this.render();
        this.#syncMotes(this.#model());
        return this.render({ parts });
    }

    // Нажатие на огонёк или бросок в цель. Возвращает true, если цель его приняла
    #interact(el, target) {
        const { key, tap, mergeSkill } = el.dataset;
        if (el.classList.contains('focused')) {
            // Из фокуса огонёк уходит нажатием или броском прочь; брошенный в ядро — остаётся
            if (target.type === 'tap' || target.type === 'away') {
                if (this.ritual === 'merge') this.mergeId = null;
                else this.slots = this.slots.filter(k => k !== key);
            }
            this.#update(['stage', 'controls']);
            return true;
        }
        if (tap === 'merge' && (target.type === 'tap' || target.type === 'core' || (target.type === 'node' && target.id === mergeSkill))) {
            this.mergeId = mergeSkill;
            this.result = null;
            this.#update(['stage', 'controls']);
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
        this.#update(['stage', 'controls']);
    }

    static #onRitual(event, target) {
        // Цели Слияния (навыки Памяти) есть только в тумане Слияния — тогда туман перерисовывается
        const fog = this.ritual === 'merge' || target.dataset.ritual === 'merge';
        this.ritual = target.dataset.ritual;
        this.slots = [];
        this.result = null;
        this.#update(['side', 'stage', 'controls', ...(fog ? ['fog'] : [])]);
    }

    static #onTag(event, target) {
        this.tag = target.dataset.tag;
        this.#update(['stage', 'controls']);
    }

    static #onMergePick(event, target) {
        this.mergeId = target.dataset.itemId;
        this.result = null;
        this.#update(['stage', 'controls']);
    }

    // Итог ритуала показывается сразу; огоньки исчезают, когда придут изменения предметов
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
            this.result = { ...done, at: Date.now() };
        }
        this.#update(['stage', 'controls']);
    }

    async #merge() {
        const item = this.actor.items.get(this.mergeId);
        if (!item) return null;
        const rank = (item.flags[MODULE_ID].rank ?? 1) + 1;
        await forgeSkill(this.actor, item);
        this.mergeId = null;
        this.#flareId = item.id;
        const max = item.flags[MODULE_ID].max_rank ?? rank;
        return { label: 'Слияние', title: item.name, sub: `Ранг ${romanRank(rank)} из ${romanRank(max)}`, color: RARITY[item.flags[MODULE_ID].rarity]?.color ?? '#e8c26a' };
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
        return crystalBanner('Переплавка', result, smelt.to);
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
        return crystalBanner(`Резонанс · ${this.tag}`, result, ing.rarity);
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
        const hd = availableHitDice(this.actor);
        return { label: 'Расщепление', title: `Кости Хитов +${restored}`, sub: `${ing.name} рассеялся в тумане · Кости Хитов ${hd}`, color: '#5fe0b8' };
    }
}

// Отряд пришёл на Привал — у каждого игрока открывается Алтарь его персонажа
onSocket('openMemoryAltar', () => {
    if (!game.user.isGM && game.user.character) MemoryAltar.open(game.user.character);
});
export function announceRest() {
    emit('openMemoryAltar');
}

// Алтарь перерисовывается при изменении предметов персонажа. Ритуал меняет несколько
// предметов подряд — перерисовка одна, после последнего изменения
const pending = new Map();
const rerender = item => {
    const actor = item?.parent ?? item;
    const app = foundry.applications.instances?.get(`gachadnd-memory-altar-${actor?.id}`);
    if (!app) return;
    clearTimeout(pending.get(app.id));
    pending.set(app.id, setTimeout(() => {
        pending.delete(app.id);
        if (app.rendered) app.render();
    }, 60));
};
Hooks.on('createItem', rerender);
Hooks.on('deleteItem', rerender);
Hooks.on('updateItem', rerender);
