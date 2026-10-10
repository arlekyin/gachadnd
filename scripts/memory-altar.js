/**
 * Gacha Roguelike dnd5e — Алтарь Памяти: погружение в сознание персонажа на Привале или в Якоре
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
 * Красные и оранжевые кристаллы в ритуалах не участвуют. Каждый кристалл в Переплавке весит 1,
 * в том числе повтор навыка, который слить уже нельзя.
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
            const weight = 1;
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
// Гнёзда Переплавки лежат на настоящей окружности радиусом SIGIL_R пикселей вокруг ядра: проценты
// пересчитываются по размеру окна, иначе на широком экране круг ритуала стал бы эллипсом
const SIGIL_R = 150;
const SIGIL_DEG = [-90, 30, 150];
function focusPoints(count, width, height) {
    if (count < 3) return [CORE];
    return SIGIL_DEG.map(deg => ({
        x: CORE.x + SIGIL_R * Math.cos(deg * Math.PI / 180) / width * 100,
        y: CORE.y + SIGIL_R * Math.sin(deg * Math.PI / 180) / height * 100
    }));
}

// Руны круга: палочные знаки в духе футарка — ствол и одна–три ветви. Детерминированы: круг одинаков
const RUNES = (() => {
    let seed = 1913;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const branches = [
        'M0 -7 L4 -3', 'M0 -7 L-4 -3', 'M0 -2 L4 -6', 'M0 -2 L-4 -6', 'M0 0 L4 4', 'M0 0 L-4 4',
        'M0 -4 L4 0 L0 4', 'M0 -7 L4 -4 L0 -1', 'M-4 -5 L4 3', 'M4 -5 L-4 3'
    ];
    return Array.from({ length: 24 }, () => {
        const parts = ['M0 -7 L0 7'];
        const count = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < count; k++) parts.push(branches[Math.floor(rnd() * branches.length)]);
        return parts.join(' ');
    });
})();

const f1 = n => n.toFixed(1);
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// Звезда {n/k}: вершины соединяются через k — «n-грамма». k ≈ 0,38n и взаимно просто с n, чтобы линия
// обошла все вершины одним ходом; для 3–4 вершин — простой многоугольник
function starStep(n) {
    if (n < 5) return 1;
    let k = Math.max(2, Math.round(n * 0.38));
    while (k > 1 && gcd(n, k) !== 1) k--;
    return k;
}

// Руна на позиции эллипса (rx, ry) под углом deg, повёрнута вдоль него
function runeAt(d, n, total, rx, ry, lit) {
    const a = (n * 360 / total - 90) * Math.PI / 180;
    const x = rx * Math.cos(a), y = ry * Math.sin(a);
    const turn = Math.atan2(ry * Math.cos(a), -rx * Math.sin(a)) * 180 / Math.PI;
    return `<path class="gd-rune ${lit ? 'on' : ''}" d="${d}" transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(turn - 90)})"/>`;
}

/**
 * Круг ритуала — фон за ядром. Координаты — в пикселях от центра ядра.
 * @param {object} o
 * @param {number[][]} [o.points]   Вершины (гнёзда, места кольца, теги).
 * @param {boolean[]} [o.filled]    Заняты ли вершины.
 * @param {number|'hexagram'} [o.star]  Шаг звезды или гексаграмма (треугольник и обратный ему).
 * @param {boolean[]} [o.edgeLit]   Горит ли грань звезды, начинающаяся в вершине i (по умолчанию — заняты оба конца).
 * @param {{rx:number, ry:number, cls?:string}[]} [o.rings]  Кольца-эллипсы.
 * @param {{rx:number, ry:number, lit:number}} [o.runes]      Кольцо рун и сколько из них горит.
 * @param {{r:number, lit:boolean}} [o.center]  Паз в центре — вокруг ядра.
 * @param {{count:number, r0:number, r1:number, lit:boolean}} [o.rays]  Лучи от центра наружу.
 * @param {boolean} [o.spokes]  Лучи от занятых вершин к ядру.
 * @param {string} o.kind       Ритуал — класс круга.
 */
function sigilSvg(o) {
    const points = o.points ?? [];
    const filled = o.filled ?? points.map(() => false);
    const extra = (o.crown?.depth ?? 0) + (o.braid?.amp ?? 0);
    const extentX = Math.max(60, ...points.map(p => Math.abs(p[0])), ...(o.rings ?? []).map(r => r.rx), o.runes?.rx ?? 0, o.rays?.r1 ?? 0, (o.crown?.rx ?? o.braid?.rx ?? 0) + extra);
    const extentY = Math.max(60, ...points.map(p => Math.abs(p[1])), ...(o.rings ?? []).map(r => r.ry), o.runes?.ry ?? 0, o.rays?.r1 ?? 0, (o.crown?.ry ?? o.braid?.ry ?? 0) + extra);
    const w = 2 * (extentX + 40), h = 2 * (extentY + 40);
    const parts = [];
    for (const r of o.rings ?? []) parts.push(`<ellipse class="gd-sigil-ring ${r.cls ?? ''}" cx="0" cy="0" rx="${f1(r.rx)}" ry="${f1(r.ry)}"/>`);
    if (o.runes) {
        parts.push(`<g class="gd-runes">${RUNES.map((d, n) => runeAt(d, n, RUNES.length, o.runes.rx, o.runes.ry, n < o.runes.lit)).join('')}</g>`);
    }
    if (o.rays) {
        for (let n = 0; n < o.rays.count; n++) {
            const a = (n * 360 / o.rays.count - 90) * Math.PI / 180;
            parts.push(`<line class="gd-sigil-ray ${o.rays.lit ? 'lit' : ''}" x1="${f1(Math.cos(a) * o.rays.r0)}" y1="${f1(Math.sin(a) * o.rays.r0)}" x2="${f1(Math.cos(a) * o.rays.r1)}" y2="${f1(Math.sin(a) * o.rays.r1)}"/>`);
        }
    }
    const ell = (a, rx, ry) => [rx * Math.cos(a), ry * Math.sin(a)];
    if (o.crown) {
        // Корона Слияния: зубец за каждым местом кольца — наружу от навыка; горит за занятым местом
        const { angles, filled: lit, rx, ry, depth } = o.crown;
        const sorted = angles.map((a, i) => ({ a, i })).sort((x, y) => x.a - y.a);
        const mid = (x, y) => { let d = y - x; if (d <= 0) d += 2 * Math.PI; return x + d / 2; };
        sorted.forEach(({ a, i }, n) => {
            const prev = sorted[(n - 1 + sorted.length) % sorted.length].a, next = sorted[(n + 1) % sorted.length].a;
            const v1 = ell(mid(prev, a), rx, ry), peak = ell(a, rx + depth, ry + depth), v2 = ell(mid(a, next), rx, ry);
            parts.push(`<polyline class="gd-sigil-crown ${lit[i] ? 'lit' : ''}" points="${[v1, peak, v2].map(p => p.map(f1).join(',')).join(' ')}"/>`);
        });
    }
    if (o.braid) {
        // Плетение Резонанса: две нити, перевитые вдоль кольца; у выбранного тега — горят.
        // На каждом перекрёстке одна нить уходит под другую — разрыв у пересечения
        const { rx, ry, amp, waves, active } = o.braid;
        const steps = 240;
        for (const sign of [1, -1]) {
            for (let n = 0; n < steps; n++) {
                const a0 = n / steps * 2 * Math.PI, a1 = (n + 1) / steps * 2 * Math.PI;
                const r = a => sign * amp * Math.sin(waves * a);
                const cross = Math.floor(waves * a0 / Math.PI + 0.5);
                if (Math.abs(Math.sin(waves * a0)) < 0.2 && (cross % 2 === 0) === (sign > 0)) continue;
                const p0 = ell(a0, rx + r(a0), ry + r(a0)), p1 = ell(a1, rx + r(a1), ry + r(a1));
                let d = Math.abs(a0 - (active ?? -10)); d = Math.min(d, 2 * Math.PI - d);
                const lit = active !== null && active !== undefined && d < 0.32;
                parts.push(`<line class="gd-sigil-braid ${lit ? 'lit' : ''}" x1="${f1(p0[0])}" y1="${f1(p0[1])}" x2="${f1(p1[0])}" y2="${f1(p1[1])}"/>`);
            }
        }
    }
    const n = points.length;
    if (o.star === 'hexagram' && n === 3) {
        parts.push(`<polygon class="gd-sigil-inverse" points="${points.map(([x, y]) => `${f1(-x)},${f1(-y)}`).join(' ')}"/>`);
    }
    if (n >= 3) {
        const k = o.star === 'hexagram' ? 1 : (o.star ?? starStep(n));
        for (let i = 0; i < n; i++) {
            const j = (i + k) % n;
            const lit = o.edgeLit ? o.edgeLit[i] : filled[i] && filled[j];
            parts.push(`<line class="gd-sigil-edge ${lit ? 'lit' : ''}" x1="${f1(points[i][0])}" y1="${f1(points[i][1])}" x2="${f1(points[j][0])}" y2="${f1(points[j][1])}"/>`);
        }
    }
    if (o.spokes) points.forEach(([x, y], i) => {
        const r = Math.hypot(x, y) || 1;
        parts.push(`<line class="gd-sigil-spoke ${filled[i] ? 'lit' : ''}" x1="${f1(x)}" y1="${f1(y)}" x2="${f1(x / r * 44)}" y2="${f1(y / r * 44)}"/>`);
    });
    if (o.sockets) points.forEach(([x, y], i) => parts.push(`<circle class="gd-sigil-socket ${filled[i] ? 'lit' : ''}" cx="${f1(x)}" cy="${f1(y)}" r="${o.sockets}"/>`));
    if (o.center) parts.push(`<circle class="gd-sigil-socket center ${o.center.lit ? 'lit' : ''}" cx="0" cy="0" r="${o.center.r}"/>`);
    return `<svg class="gd-sigil gd-sigil-${o.kind}" viewBox="${f1(-w / 2)} ${f1(-h / 2)} ${f1(w)} ${f1(h)}" width="${f1(w)}" height="${f1(h)}" aria-hidden="true">${parts.join('')}</svg>`;
}

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
    // Расстояние от ядра до низа круга Переплавки в процентах высоты поля
    #sigilBelow = 0;
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
        if (!isAtRest() && !game.user.isGM) return ui.notifications.warn('Алтарь Памяти доступен только в Якоре.');
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
        // Под кругом ритуала, если он ниже прогноза
        const style = at({ x: CORE.x, y: CORE.y + Math.max(14, this.#sigilBelow) });
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
            // Размер поля сознания (без левой панели): от него считаются проценты огоньков и ядра.
            // До первой отрисовки — по окну браузера без ширины панели
            const field = this.#part('stage') ?? this.#part('fog');
            const points = focusPoints(this.#slotLimit(), field?.clientWidth || innerWidth - 290, field?.clientHeight || innerHeight);
            points.forEach((pos, n) => {
                const ing = slotted[n];
                // Переплавка: гнёзда и связи рисует круг ритуала (sigil), пустые гнёзда — только в одиночном фокусе
                if (!ing) return points.length === 1 && focusEmpty.push({ style: at(pos) });
                views.set(ing.key, { cls: ['focused'], tap: 'unslot', pos });
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
                note: ing.kind === 'skill' ? 'Навык из Памяти: бросьте в него повторный кристалл' : ''
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
                style: `${at(pos)}; --rarity: ${RARITY[ing.rarity]?.color ?? '#c9a75d'}; --delay: ${bobPhase(ing.key)}s`
            };
        });

        // Резонанс: теги колесом вокруг ядра; выбранный обвивают пряди от ядра (ResonanceWeave)
        const wheel = this.ritual !== 'resonate' ? [] : tags.map((name, n) => {
            const angle = -Math.PI / 2 + (2 * Math.PI * n) / tags.length;
            const pos = { x: CORE.x + WHEEL.rx * Math.cos(angle), y: CORE.y + WHEEL.ry * Math.sin(angle) };
            return { name, active: name === this.tag, pos, style: at(pos) };
        });
        // Переплавка накаляет ядро по мере заполнения гнёзд
        const heat = this.ritual === 'smelt' ? Math.min(1, slotted.reduce((sum, i) => sum + i.weight, 0) / 3) : 0;
        const sigil = this.#sigil({ slotted, wheel, sockets, orbitAt, filled: active.length });
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
            ritual, recipe, motes, nodes, flows, focusEmpty, wheel, mind, sigil,
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
        // Ритуал — классом окна: огоньки не перерисовываются при смене ритуала
        for (const key of Object.keys(RITUALS)) this.element.classList.toggle(`gd-ritual-${key}`, key === context.ritual.key);
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

    /**
     * Круг ритуала за ядром. Рисунок ритуала живёт в полосе снаружи того, что занято ядром, прядями
     * и тегами, — иначе линии ритуала путаются с нитями навыков. Переплавка — гексаграмма с тремя гнёздами,
     * Слияние — корона с зубцом за каждым местом кольца, Резонанс — перевитые нити за колесом тегов,
     * Расщепление — лучи рассеивания за облаком. Проценты разметки переводятся в пиксели поля.
     */
    #sigil({ slotted, wheel, sockets, orbitAt, filled }) {
        const field = this.#part('stage') ?? this.#part('fog');
        const W = field?.clientWidth || innerWidth - 290, H = field?.clientHeight || innerHeight;
        const px = pos => [(pos.x - CORE.x) / 100 * W, (pos.y - CORE.y) / 100 * H];
        const slot = !!slotted[0];
        const allRunes = RUNES.length;
        this.#sigilBelow = 0;
        if (this.ritual === 'smelt') {
            const R = SIGIL_R;
            const weight = slotted.reduce((sum, i) => sum + (i?.weight ?? 0), 0);
            this.#sigilBelow = (R + 50) / H * 100;
            return sigilSvg({
                kind: 'smelt', star: 'hexagram', sockets: 21, spokes: true,
                points: SIGIL_DEG.map(deg => [R * Math.cos(deg * Math.PI / 180), R * Math.sin(deg * Math.PI / 180)]),
                filled: SIGIL_DEG.map((_, n) => !!slotted[n]),
                rings: [{ rx: R + 38, ry: R + 38 }, { rx: R + 10, ry: R + 10 }, { rx: R, ry: R, cls: 'faint' }],
                runes: { rx: R + 24, ry: R + 24, lit: Math.round(allRunes * Math.min(1, weight / 3)) }
            });
        }
        if (this.ritual === 'merge') {
            // Всё — снаружи кольца Памяти: внутри живут пряди навыков. Корона держит каждое место кольца
            const ox = ORBIT.rx / 100 * W, oy = ORBIT.ry / 100 * H;
            const angles = Array.from({ length: sockets }, (_, n) => { const [x, y] = px(orbitAt(n)); return Math.atan2(y / oy, x / ox); });
            const rx = ox + 44, ry = oy + 44;
            return sigilSvg({
                kind: 'merge',
                crown: { angles, filled: angles.map((_, n) => n < filled), rx, ry, depth: 22 },
                rings: [{ rx, ry }, { rx: rx + 48, ry: ry + 48 }],
                runes: { rx: rx + 36, ry: ry + 36, lit: Math.round(allRunes * Math.min(1, filled / Math.max(1, sockets))) }
            });
        }
        if (this.ritual === 'resonate') {
            // Всё — снаружи колеса тегов: внутри нити оплетают выбранный тег. Кольцо — перевитые нити,
            // у выбранного тега они горят
            const active = wheel.find(w => w.active);
            const wx = WHEEL.rx / 100 * W, wy = WHEEL.ry / 100 * H;
            let angle = null;
            if (active) {
                const [x, y] = px(active.pos);
                angle = Math.atan2(y / wy, x / wx);
                if (angle < 0) angle += 2 * Math.PI;
            }
            const rx = wx + 46, ry = wy + 46;
            return sigilSvg({
                kind: 'resonate',
                braid: { rx, ry, amp: 9, waves: Math.max(6, wheel.length), active: angle },
                rings: [{ rx: rx + 30, ry: ry + 30 }],
                runes: { rx: rx + 44, ry: ry + 44, lit: slot ? allRunes : 0 }
            });
        }
        // Расщепление: паз вокруг ядра, лучи расходятся — кристалл рассеивается в туман
        this.#sigilBelow = 264 / H * 100;
        return sigilSvg({
            kind: 'split',
            rings: [{ rx: 150, ry: 150 }, { rx: 200, ry: 200 }, { rx: 228, ry: 228 }],
            runes: { rx: 214, ry: 214, lit: slot ? allRunes : 0 },
            // Лучи — только в полосе за облаком: внутри ядро и его нити
            rays: { count: 24, r0: 156, r1: 194, lit: slot }
        });
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
