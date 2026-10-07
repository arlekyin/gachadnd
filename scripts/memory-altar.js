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
import { AltarSynapses } from "./altar-synapses.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

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
    #flareId = null;
    #drift = new Map();
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
        const equipped = merge ? memory.filter(i => i.flags[MODULE_ID].is_active) : [];
        const sockets = Math.max(cap, equipped.length);
        const orbitAt = n => {
            const angle = -Math.PI / 2 + (2 * Math.PI * n) / sockets;
            return { x: CORE.x + ORBIT.rx * Math.cos(angle), y: CORE.y + ORBIT.ry * Math.sin(angle) };
        };
        const nodePos = new Map(equipped.map((item, n) => [item.id, orbitAt(n)]));
        const nodes = equipped.map(item => {
            const flags = item.flags[MODULE_ID];
            const canMerge = dupOf.has(item.id);
            const itemTags = flags.tags ?? [];
            return {
                id: item.id, name: item.name, rank: romanRank(flags.rank ?? 1), canMerge,
                cls: [canMerge && 'can-merge', item.id === this.mergeId && 'chosen'].filter(Boolean).join(' '),
                style: `${at(nodePos.get(item.id))}; --rarity: ${RARITY[flags.rarity]?.color ?? '#c9a75d'}`,
                title: `${item.name} — ранг ${romanRank(flags.rank ?? 1)}${itemTags.length ? `\nТеги: ${itemTags.join(', ')}` : ''}`
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
        const motes = fogItems.map((ing, n) => {
            if (!this.#drift.has(ing.key)) this.#drift.set(ing.key, fogPosition(n, fogItems.length));
            const view = views.get(ing.key) ?? { cls: [] };
            const pos = view.pos ?? this.#drift.get(ing.key);
            return {
                key: ing.key, itemId: ing.item.id, kind: ing.kind, name: ing.name, view, pos,
                cls: view.cls.join(' '), tap: view.tap ?? '', mergeSkill: view.mergeSkill ?? '',
                double: ing.weight > 1,
                style: `${at(pos)}; --rarity: ${RARITY[ing.rarity]?.color ?? '#c9a75d'}; --delay: ${bobPhase(ing.key)}s`,
                title: `${ing.name}${ing.kind === 'skill' ? ' — навык из Памяти: бросьте в него повтор' : ''}${ing.weight > 1 ? ' — повтор без слияния, весит вдвое' : ''}`
            };
        });

        return {
            ritual, recipe, motes, nodes, flows, focusEmpty,
            glyphs: Object.entries(RITUALS).map(([key, r]) => ({ key, ...r, active: key === this.ritual })),
            tags: this.ritual === 'resonate' ? tags.map(name => ({ name, active: name === this.tag })) : null,
            core: { style: at(CORE) },
            ring: merge ? { filled: equipped.length, cap } : null,
            sockets: merge ? Array.from({ length: sockets - equipped.length }, (_, n) => ({ style: at(orbitAt(equipped.length + n)) })) : [],
            cost: recipe.gain ? `+${recipe.gain} КХ` : recipe.cost ? `−${recipe.cost} КХ` : '',
            hd: { value: hdValue, max: hdMax, pips: Array.from({ length: hdMax }, (_, i) => i < hdValue) },
            result: this.result,
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
        if (options.parts?.includes('stage')) {
            this.#ringShown = !!context.ring;
            // Связи кольца живут вместе со слоем ядра; после слияния по прядям навыка уходит вспышка
            this.#synapses?.stop();
            const canvas = this.#part('stage')?.querySelector('canvas.gd-synapses');
            this.#synapses = canvas ? new AltarSynapses(canvas, this.#part('stage')) : null;
            this.#synapses?.start();
            if (this.#flareId) this.#synapses?.flare(this.#flareId);
            this.#flareId = null;
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

    #part(id) {
        return this.parts?.[id] ?? this.element?.querySelector(`[data-application-part="${id}"]`);
    }

    _onClose(options) {
        super._onClose(options);
        this.#physics?.destroy();
        this.#physics = null;
        this.#synapses?.stop();
        this.#synapses = null;
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
        this.#update(['side', 'controls']);
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
            this.result = done;
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
