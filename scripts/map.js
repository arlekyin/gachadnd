/**
 * Gacha Roguelike dnd5e — Интерактивная Карта Этажа
 */

import { MODULE_ID } from "./constants.js";
import { onNodeEntered } from "./horsemen.js";
import { DoomAltar } from "./altar.js";
import { ShopWindow } from "./shop.js";
import { RiskWindow } from "./risk.js";
import { announceRest } from "./memory-altar.js";
import { HOOKS, notifyRestChanged } from "./memory-api.js";
import { getFloor } from "./economy.js";

const MAP_DATA = {
    NODE_START: 'start',
    NODE_BOSS: 'boss',
    NODE_MOB: 'mob',
    NODE_ELITE: 'elite',
    NODE_EVENT: 'event',
    NODE_RISK: 'risk',
    NODE_SHOP: 'shop',
    NODE_REST: 'rest',
    NODE_DOOM: 'doom',
    // Узел Погибели появляется не на каждом этаже и не чаще одного раза
    DOOM_CHANCE: 0.5,
    
    MIN_WIDTH: 2,
    MAX_WIDTH: 4,
    MIN_EDGES: 1,
    MAX_EDGES: 3,
    
    PROPORTIONS: {
        'mob': 0.35, 'elite': 0.15, 'event': 0.20,
        'risk': 0.05, 'shop': 0.10, 'rest': 0.15
    },
    
    LABELS: {
        'start': 'Вход', 'boss': 'Босс', 'mob': 'Монстры', 'elite': 'Элита',
        'event': 'Событие', 'risk': 'Риск', 'shop': 'Магазин', 'rest': 'Привал',
        'doom': 'Погибель'
    },
    
    ICONS: {
        'start': 'fa-dungeon', 'boss': 'fa-skull', 'mob': 'fa-ghost', 'elite': 'fa-dragon',
        'event': 'fa-question', 'risk': 'fa-exclamation-triangle', 'shop': 'fa-coins', 'rest': 'fa-campground',
        'doom': 'fa-horse-head'
    },
    
    COLORS: {
        'start': '#7a7062', 'boss': '#ff003c', 'mob': '#8c8275', 'elite': '#ff8000',
        'event': '#0070dd', 'risk': '#a335ee', 'shop': '#ffaa00', 'rest': '#1eff00',
        'doom': '#e6dcc3'
    }
};

function buildContentTypes(count) {
    if (count <= 0) return [];
    let counts = {};
    Object.keys(MAP_DATA.PROPORTIONS).forEach(k => counts[k] = 0);

    let riskShare = MAP_DATA.PROPORTIONS['risk'];
    counts['risk'] = (count * riskShare >= 0.5) ? 1 : 0;
    let remaining = count - counts['risk'];

    let restProps = { ...MAP_DATA.PROPORTIONS };
    delete restProps['risk'];
    let totalP = Object.values(restProps).reduce((a, b) => a + b, 0);

    for (let [t, p] of Object.entries(restProps)) {
        counts[t] += Math.floor(remaining * (p / totalP));
    }

    let leftover = count - Object.values(counts).reduce((a, b) => a + b, 0);
    let order = ['mob', 'elite', 'event', 'rest', 'shop'];
    let i = 0;
    while (leftover > 0) {
        counts[order[i % order.length]]++;
        leftover--;
        i++;
    }

    let types = [];
    for (let [t, n] of Object.entries(counts)) {
        for (let j = 0; j < n; j++) types.push(t);
    }
    // Погибель заменяет один узел Монстров или Событие
    if (Math.random() < MAP_DATA.DOOM_CHANCE) {
        const candidates = types.map((t, i) => ['mob', 'event'].includes(t) ? i : -1).filter(i => i >= 0);
        if (candidates.length) types[candidates[Math.floor(Math.random() * candidates.length)]] = MAP_DATA.NODE_DOOM;
    }
    return types.sort(() => Math.random() - 0.5);
}

function generateMapGraph(length) {
    const contentRows = Math.max(1, length - 1);
    const widths = Array.from({ length: contentRows }, () => 
        Math.floor(Math.random() * (MAP_DATA.MAX_WIDTH - MAP_DATA.MIN_WIDTH + 1)) + MAP_DATA.MIN_WIDTH
    );
    
    const totalContentNodes = widths.reduce((a, b) => a + b, 0);
    const types = buildContentTypes(totalContentNodes);
    
    let rows = [];
    let nodes = [];
    let typeIndex = 0;

    const makeNode = (r, c, type) => ({
        id: `${r}-${c}`, row: r, col: c, type: type, 
        label: MAP_DATA.LABELS[type], icon: MAP_DATA.ICONS[type], color: MAP_DATA.COLORS[type], next: []
    });

    let start = makeNode(0, 0, MAP_DATA.NODE_START);
    rows.push([start]);
    nodes.push(start);

    for (let r = 1; r <= contentRows; r++) {
        let w = widths[r - 1];
        let rowNodes = [];
        for (let c = 0; c < w; c++) {
            let node = makeNode(r, c, types[typeIndex++]);
            rowNodes.push(node);
            nodes.push(node);
        }
        rows.push(rowNodes);
    }

    let boss = makeNode(rows.length, 0, MAP_DATA.NODE_BOSS);
    rows.push([boss]);
    nodes.push(boss);

    for (let r = 0; r < rows.length - 1; r++) {
        let cur = rows[r], nxt = rows[r + 1];
        let incoming = {};
        nxt.forEach(n => incoming[n.id] = 0);

        cur.forEach(node => {
            let k = Math.min(nxt.length, Math.floor(Math.random() * (MAP_DATA.MAX_EDGES - MAP_DATA.MIN_EDGES + 1)) + MAP_DATA.MIN_EDGES);
            let order = nxt.map((n, idx) => ({ idx, dist: Math.abs(idx - node.col) })).sort((a, b) => a.dist - b.dist);
            
            let targets = order.slice(0, k).map(o => o.idx).sort();
            targets.forEach(i => {
                node.next.push(nxt[i].id);
                incoming[nxt[i].id]++;
            });
        });

        nxt.forEach(n => {
            if (incoming[n.id] === 0) {
                let closest = cur.map(c => ({ node: c, dist: Math.abs(c.col - n.col) })).sort((a, b) => a.dist - b.dist)[0].node;
                closest.next.push(n.id);
                incoming[n.id]++;
            }
        });
    }

    // Сохраняем начальное состояние
    return { rows, nodes, currentNodeId: null, visitedNodes: [] };
}

// Отряд стоит на узле «Привал» текущей карты этажа
export function isPartyAtRest(scene = canvas.scene) {
    const map = scene?.getFlag(MODULE_ID, 'floorMap');
    const node = map?.nodes?.find(n => n.id === map.currentNodeId);
    return node?.type === 'rest';
}

// Подключение к Памяти: отряд на узле Привала — Привал открыт
Hooks.on(HOOKS.queryRest, state => {
    if (isPartyAtRest()) state.atRest = true;
});
Hooks.on('updateScene', (scene, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) notifyRestChanged();
});

// ==========================================
// ОКНО КАРТЫ
// ==========================================

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TEMPLATES = 'modules/gachadnd/templates/map';
const MAP_ID = 'gachadnd-map-terminal';
const NODE_HINTS = {
    shop: 'щёлкните ещё раз, чтобы открыть Магазин',
    risk: 'щёлкните ещё раз, чтобы открыть Риск',
    doom: 'щёлкните ещё раз, чтобы открыть Алтарь Погибели'
};
// Порядок типов в легенде
const LEGEND_ORDER = ['mob', 'elite', 'event', 'risk', 'shop', 'rest', 'doom', 'boss'];

/* ---------- Набросок от руки ----------
 * Всё «нарисованное» строится из случайных чисел с зерном от самой карты: у всех клиентов и при каждой
 * перерисовке линии дрожат одинаково, а новая карта рисуется иначе.
 * «Живые чернила»: у каждой линии, кольца и рисунка три формы с одним набором команд пути, и SVG плавно
 * перетекает между ними (animate по атрибуту d) — штрих медленно изгибается, как чернила на мокрой бумаге. */

// Поле в процентах; примерный размер в пикселях нужен, чтобы отступы и рисунки не зависели от пропорций окна
const BOARD_PX = { x: 6.8, y: 7.4 };
const INK_FORMS = 3;

// Длительность цикла и сдвиг фазы у каждого рисунка свои — карта колышется не в такт.
// Часы SVG стартуют при вставке в страницу, поэтому начало сдвинуто назад на время страницы: перерисованная
// линия продолжает движение с того же места. (setCurrentTime сразу после вставки в Chrome замораживает анимацию.)
let inkClock = 0;
const inkMotion = rand => ({ dur: (4.5 + rand() * 3).toFixed(2), begin: (-rand() * 8 - inkClock).toFixed(2) });

/** Формы для animate: первая повторяется в конце, чтобы цикл замкнулся */
const inkValues = forms => [...forms, forms[0]].join(';');

/* Карта лежит перед зрителем трапецией: ближний край (Вход) широкий и крупный, дальний (Босс) узкий и мелкий.
 * depth — 0 у нижнего края, 1 у верхнего; scale — во сколько раз уменьшены значки, подписи и штрихи */
const FAR_SCALE = 0.62;
const depthScale = y => 1 - (1 - FAR_SCALE) * Math.min(1, Math.max(0, (94 - y) / 86));
function toTrapezoid(x, depth) {
    const y = 94 - 86 * depth * (1.35 - 0.35 * depth); // ряды сближаются к дальнему краю
    return { x: 50 + (x - 50) * depthScale(y), y, k: depthScale(y) };
}

function seededRandom(text) {
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
    let a = h >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const fmt = n => n.toFixed(2);

// Кривая между узлами: выходит из узла вверх и входит сверху, как раньше
function edgePoint(a, b, t) {
    const mid = (a.y + b.y) / 2, u = 1 - t;
    return {
        x: u ** 3 * a.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t ** 3 * b.x,
        y: u ** 3 * a.y + 3 * u * u * t * mid + 3 * u * t * t * mid + t ** 3 * b.y
    };
}

/** Дрожащая линия от руки: точки кривой со смещением поперёк, сглаженные через середины. Концы не доходят до узлов.
 *  Возвращает несколько форм одной линии: основа общая, у каждой формы своё отклонение — между ними линия «течёт» */
function sketchLine(a, b, rand, { trim = 38, wobble = 3.5, flow = 3.5 } = {}) {
    // Длина в пикселях — чтобы найти, где начать и закончить линию
    const samples = Array.from({ length: 41 }, (_, i) => edgePoint(a, b, i / 40));
    const lengths = [0];
    for (let i = 1; i < samples.length; i++) {
        lengths.push(lengths[i - 1] + Math.hypot((samples[i].x - samples[i - 1].x) * BOARD_PX.x, (samples[i].y - samples[i - 1].y) * BOARD_PX.y));
    }
    const total = lengths.at(-1);
    const tAt = len => { const i = lengths.findIndex(l => l >= len); return (i < 0 ? 40 : i) / 40; };
    const t0 = tAt(Math.min(trim, total * 0.4)), t1 = tAt(Math.max(total - trim, total * 0.6));

    const count = Math.max(4, Math.round((total - 2 * trim) / 26));
    const base = [];
    for (let i = 0; i <= count; i++) {
        const t = t0 + (t1 - t0) * i / count;
        const p = edgePoint(a, b, t), q = edgePoint(a, b, Math.min(1, t + 0.01));
        const dx = (q.x - p.x) * BOARD_PX.x, dy = (q.y - p.y) * BOARD_PX.y, len = Math.hypot(dx, dy) || 1;
        const end = i === 0 || i === count ? 0.3 : 1;
        base.push({ p, nx: -dy / len, ny: dx / len, end, shift: end * (rand() - 0.5) * 2 * wobble });
    }
    const shape = extra => {
        const points = base.map((pt, i) => {
            const shift = pt.shift + pt.end * extra[i];
            return { x: pt.p.x + pt.nx * shift / BOARD_PX.x, y: pt.p.y + pt.ny * shift / BOARD_PX.y };
        });
        let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
        for (let i = 1; i < points.length - 1; i++) {
            const m = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
            d += ` Q ${fmt(points[i].x)} ${fmt(points[i].y)} ${fmt(m.x)} ${fmt(m.y)}`;
        }
        const last = points.at(-1);
        return { d: `${d} L ${fmt(last.x)} ${fmt(last.y)}`, points };
    };
    const forms = Array.from({ length: INK_FORMS }, () => shape(base.map(() => (rand() - 0.5) * 2 * flow)));
    return { forms: forms.map(f => f.d), points: forms[0].points };
}

/** Мазок кистью вокруг узла: незамкнутое кольцо, толстое в середине и сходящее на нет к концам (viewBox 0 0 100 100).
 *  Формы отличаются фазой неровностей и нажимом — кольцо медленно «дышит» */
function brushRing(rand, { radius = 36, width = 6, turns = 1.12 } = {}) {
    const start = rand() * Math.PI * 2, wobbleA = rand() * 6, wobbleB = rand() * 6;
    const form = shift => {
        const outer = [], inner = [], steps = 56;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps, angle = start + shift * 0.12 + t * turns * Math.PI * 2;
            const r = radius + 2.2 * Math.sin(angle * 2 + wobbleA + shift) + 1.2 * Math.sin(angle * 3 + wobbleB - shift * 1.4) + t * 3;
            // Нажим: резкое начало, долгий хвост. Концы не сходят в ноль — иначе тонкий хвост то появляется, то пропадает
            const w = width * (1 + 0.08 * Math.sin(shift * 2 + t * 5)) * (0.35 + 0.65 * Math.min(1, t * 6)) * (0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.1)));
            outer.push(`${fmt(50 + Math.cos(angle) * (r + w / 2))} ${fmt(50 + Math.sin(angle) * (r + w / 2))}`);
            inner.push(`${fmt(50 + Math.cos(angle) * (r - w / 2))} ${fmt(50 + Math.sin(angle) * (r - w / 2))}`);
        }
        return `M ${outer.join(' L ')} L ${inner.reverse().join(' L ')} Z`;
    };
    return Array.from({ length: INK_FORMS }, (_, i) => form(i * 1.1));
}

/** Те же рисунки, но каждое число чуть сдвинуто. Дуги не трогаются: почти замкнутая дуга от малейшего сдвига
 *  конца перескакивает на другую сторону, и круг рвётся */
function jitterPath(d, rand, amount) {
    let command = '';
    return d.replace(/[a-zA-Z]|-?\d*\.?\d+/g, token => {
        if (/[a-zA-Z]/.test(token)) { command = token; return token; }
        if (/a/i.test(command)) return token;
        return fmt(parseFloat(token) + (rand() - 0.5) * 2 * amount);
    });
}

// Рисунки на полях (viewBox 0 0 40 40): то, что кто-то набросал о Разломе
const DOODLES = [
    // роза ветров
    'M20 3 L23 17 L37 20 L23 23 L20 37 L17 23 L3 20 L17 17 Z M20 9 L20 31 M9 20 L31 20 M11 11 l3 3 M29 11 l-3 3 M11 29 l3 -3 M29 29 l-3 -3',
    // спираль
    'M20 20 c2 -1 3 2 1 4 c-3 3 -8 0 -7 -4 c1 -6 9 -8 13 -3 c5 6 0 14 -7 14 c-9 0 -14 -9 -10 -16 c4 -8 16 -9 21 -2',
    // глаз
    'M3 20 Q20 5 37 20 Q20 35 3 20 Z M20 14 a6 6 0 1 0 0.1 0 M20 18 a2 2 0 1 0 0.1 0 M8 12 l-3 -4 M14 9 l-1 -5 M26 9 l1 -5 M32 12 l3 -4',
    // череп
    'M10 19 a10 10 0 1 1 20 0 v6 h-3 v5 h-14 v-5 h-3 Z M14 18 a3 3 0 1 0 0.1 0 M26 18 a3 3 0 1 0 0.1 0 M18 30 v-4 M22 30 v-4 M20 22 l-1 3 h2 z',
    // щупальце
    'M6 37 C9 25 19 27 17 17 C15 8 23 3 29 7 C34 11 31 17 27 16 C24 15 25 11 28 12 M12 29 a1 1 0 1 0 .1 0 M16 22 a1 1 0 1 0 .1 0 M19 14 a1 1 0 1 0 .1 0',
    // трещины
    'M3 5 L12 14 L9 21 L18 26 L15 36 M12 14 L21 11 L27 16 L35 13 M18 26 L27 29 L31 37 M21 11 L22 4',
    // стрелка и вопрос
    'M5 35 C13 27 17 19 29 9 M29 9 l-8 1 M29 9 l-2 8 M27 25 c0 -5 8 -5 8 0 c0 3 -4 3 -4 7 M31 37 l0 0.5',
    // мотылёк
    'M20 11 v19 M20 14 C10 3 1 14 10 20 C3 27 12 33 20 25 M20 14 C30 3 39 14 30 20 C37 27 28 33 20 25 M19 11 l-4 -6 M21 11 l4 -6',
    // арка двери
    'M9 37 V18 a11 11 0 0 1 22 0 V37 M20 7 V37 M24 24 a1 1 0 1 0 .1 0 M5 37 h30 M12 15 l3 2 M28 15 l-3 2',
    // туман
    'M2 13 q5 -5 10 0 t10 0 t10 0 t7 0 M6 22 q5 -5 10 0 t10 0 t10 0 M2 31 q5 -5 10 0 t10 0 t8 0',
    // руна в круге
    'M20 3 a17 17 0 1 1 -0.1 0 M20 8 L20 32 M20 14 L28 9 M20 20 L12 15 M20 26 L28 21',
    // искры
    'M7 7 l5 5 M12 7 l-5 5 M27 13 l4 4 M31 13 l-4 4 M15 29 l6 6 M21 29 l-6 6 M33 31 l2 2 M35 31 l-2 2'
];

/** Рисунки в пустых местах поля: подальше от узлов, путей и друг от друга */
function placeDoodles(rand, nodeCoords, edgePoints) {
    const far = (p, list, px) => list.every(q => Math.hypot((p.x - q.x) * BOARD_PX.x, (p.y - q.y) * BOARD_PX.y) > px);
    const pool = [...DOODLES.keys()].sort(() => rand() - 0.5);
    const placed = [];
    for (let attempt = 0; attempt < 400 && placed.length < 7 && pool.length; attempt++) {
        const p = { x: 9 + rand() * 82, y: 6 + rand() * 88 };
        if (!far(p, nodeCoords, 70) || !far(p, edgePoints, 36) || !far(p, placed, 95)) continue;
        const d = DOODLES[pool.pop()];
        placed.push({
            ...p, d, values: inkValues(Array.from({ length: INK_FORMS }, () => jitterPath(d, rand, 0.9))), ...inkMotion(rand),
            size: Math.round((48 + rand() * 26) * depthScale(p.y)), turn: Math.round(rand() * 40 - 20)
        });
    }
    return placed;
}

/**
 * Карта этажа: части header (этаж, создание этажа у Мастера), board (узлы и пути), footer (где отряд,
 * куда дальше, состав этажа). Перемещение отряда перерисовывает только board и footer — у всех
 * клиентов, через изменение флага сцены.
 */
export class GachaMapTerminal extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: MAP_ID,
        classes: ['gachadnd-map'],
        tag: 'div',
        window: { title: 'Карта Разлома', icon: 'fas fa-scroll', resizable: true },
        position: { width: 700, height: 920 },
        actions: {
            node: GachaMapTerminal.#onNode,
            generate: GachaMapTerminal.#onGenerate
        }
    };

    static PARTS = Object.fromEntries(['header', 'board', 'footer'].map(id => [id, { template: `${TEMPLATES}/${id}.hbs` }]));

    static open() {
        const existing = foundry.applications.instances?.get(MAP_ID);
        if (existing) return existing.render({ force: true }).then(() => existing.bringToFront?.());
        return new GachaMapTerminal().render({ force: true });
    }

    get map() {
        return canvas.scene?.getFlag(MODULE_ID, 'floorMap') ?? null;
    }

    async _prepareContext() {
        const map = this.map;
        const floor = getFloor();
        const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
        const context = {
            floor,
            floorRoman: ROMAN[floor - 1] ?? floor,
            nextFloor: map?.visitedNodes?.length ? floor + 1 : floor,
            isGM: game.user.isGM,
            hasMap: !!map?.nodes?.length
        };
        if (!context.hasMap) return context;

        const { rows, nodes, currentNodeId, visitedNodes = [] } = map;
        const current = nodes.find(n => n.id === currentNodeId) ?? null;
        const reachable = new Set(current ? current.next : nodes.filter(n => n.type === MAP_DATA.NODE_START).map(n => n.id));
        const visited = new Set(visitedNodes);

        // Координаты в процентах поля: Вход внизу, Босс вверху
        const coords = {};
        rows.forEach((row, r) => {
            const depth = r / Math.max(1, rows.length - 1);
            row.forEach((node, c) => { coords[node.id] = toTrapezoid(6 + ((c + 0.5) / row.length) * 88, depth); });
        });

        inkClock = performance.now() / 1000;
        // Зерно — сама карта: перерисовка и другие клиенты видят тот же набросок
        const seed = `${floor}|${nodes.map(n => `${n.id}${n.type}${n.next.join(',')}`).join(';')}`;
        const look = node => ({ color: MAP_DATA.COLORS[node.type] ?? node.color, icon: MAP_DATA.ICONS[node.type] ?? node.icon, label: MAP_DATA.LABELS[node.type] ?? node.label });

        // Отряд обведён толстым мазком, пройденные узлы — тонким, доступные — небрежной незамкнутой петлёй
        const RINGS = {
            current: { radius: 34, width: 9, turns: 1.18 },
            visited: { radius: 33, width: 4.5, turns: 1.05 },
            reachable: { radius: 34, width: 3.6, turns: 0.82 }
        };
        context.nodes = nodes.map(node => {
            const state = node.id === currentNodeId ? 'current' : reachable.has(node.id) ? 'reachable' : visited.has(node.id) ? 'visited' : 'locked';
            const rand = seededRandom(`${seed}|ring|${node.id}|${state}`);
            const forms = RINGS[state] ? brushRing(rand, RINGS[state]) : null;
            const ring = forms ? { d: forms[0], values: inkValues(forms), ...inkMotion(rand) } : null;
            return { id: node.id, ...coords[node.id], k: coords[node.id].k.toFixed(3), ...look(node), cls: `${state} type-${node.type}`, ring, hint: node.id === currentNodeId ? NODE_HINTS[node.type] : null };
        });

        // Пути: пройденный — двойная линия, будто обведён дважды; доступный — крупный пунктир; остальные — бледные точки
        const edgePoints = [];
        context.edges = nodes.flatMap(node => node.next.map(nextId => {
            const rand = seededRandom(`${seed}|edge|${node.id}|${nextId}`);
            const traversed = visited.has(node.id) && visited.has(nextId);
            const open = node.id === currentNodeId || (!current && node.type === MAP_DATA.NODE_START);
            const k = (coords[node.id].k + coords[nextId].k) / 2;
            const lines = [sketchLine(coords[node.id], coords[nextId], rand, { trim: 38 * k, wobble: 3.5 * k, flow: 3.5 * k })];
            if (traversed) lines.push(sketchLine(coords[node.id], coords[nextId], rand, { trim: 38 * k, wobble: 3 * k, flow: 3.5 * k }));
            edgePoints.push(...lines[0].points);
            const strokes = lines.map(line => ({ d: line.forms[0], values: inkValues(line.forms), ...inkMotion(rand) }));
            return { strokes, k: k.toFixed(3), cls: traversed ? 'traversed' : open ? 'open' : 'faint' };
        }));
        context.doodles = placeDoodles(seededRandom(`${seed}|doodles`), Object.values(coords), edgePoints);

        context.current = current ? look(current) : null;
        context.next = current ? current.next.map(id => look(nodes.find(n => n.id === id))) : [];
        const counts = {};
        for (const node of nodes) if (!['start'].includes(node.type)) counts[node.type] = (counts[node.type] ?? 0) + 1;
        context.legend = LEGEND_ORDER.filter(t => counts[t]).map(t => ({ ...look({ type: t }), count: counts[t] }));
        return context;
    }

    // Перерисовка поля не должна перезапускать движение: покачивание значков ставится на время страницы,
    // как и начало течения чернил (inkClock)
    _onRender(context, options) {
        super._onRender(context, options);
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const now = performance.now();
        if (still) {
            this.element.querySelectorAll('.gd-map-board svg.gd-ink').forEach(svg => svg.pauseAnimations?.());
            return;
        }
        this.element.querySelectorAll('.gd-map-mark i').forEach((icon, index) => {
            const sway = icon.animate(
                [{ transform: 'rotate(-3deg) translateY(1px)' }, { transform: 'rotate(3deg) translateY(-1px)' }],
                { duration: 4800 + (index % 3) * 850, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }
            );
            sway.currentTime = now + index * 1700;
        });
    }

    static async #onGenerate() {
        if (!game.user.isGM) return;
        const length = parseInt(this.element.querySelector('[name="length"]')?.value) || 6;
        // Номер нового этажа забега — из поля; по умолчанию следующий, если по прошлой карте уже ходили
        const floor = Math.max(1, parseInt(this.element.querySelector('[name="floor"]')?.value) || getFloor());
        await game.settings.set(MODULE_ID, 'runFloor', floor);
        if (canvas.scene) await canvas.scene.setFlag(MODULE_ID, 'floorMap', generateMapGraph(length));
    }

    // Перемещение отряда: только Мастер, только по путям вперёд или на пройденный узел
    static async #onNode(event, target) {
        if (!game.user.isGM) return ui.notifications.warn('Перемещать отряд может только Мастер.');
        const mapData = foundry.utils.deepClone(this.map);
        if (!mapData) return;
        mapData.visitedNodes ??= [];
        const nodeId = target.dataset.nodeId;
        const nodeData = mapData.nodes.find(n => n.id === nodeId);
        if (!nodeData) return;

        if (!mapData.currentNodeId) {
            if (nodeData.type !== MAP_DATA.NODE_START) return ui.notifications.warn('Путешествие должно начинаться с начальной точки (Вход).');
        } else {
            // Щелчок по текущему узлу снова открывает его окно
            if (mapData.currentNodeId === nodeId) return openNodeWindow(nodeData.type);
            const currentNode = mapData.nodes.find(n => n.id === mapData.currentNodeId);
            if (!currentNode.next.includes(nodeId) && !mapData.visitedNodes.includes(nodeId)) {
                return ui.notifications.warn('Отряд может двигаться только по связанным линиям вперёд!');
            }
        }

        mapData.currentNodeId = nodeId;
        if (!mapData.visitedNodes.includes(nodeId)) mapData.visitedNodes.push(nodeId);
        // Флаг сцены расходится всем клиентам; их карты перерисуются хуком updateScene
        if (canvas.scene) await canvas.scene.setFlag(MODULE_ID, 'floorMap', mapData);

        // Серия Войны и штраф проклятой Войны; окна узлов
        await onNodeEntered(nodeData.type);
        openNodeWindow(nodeData.type);
        if (nodeData.type === MAP_DATA.NODE_REST) announceRest();

        const label = MAP_DATA.LABELS[nodeData.type] ?? nodeData.label;
        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: 'Путеводитель Тумана' }),
            content: `<div class="gachadnd-map-chat" style="--node: ${MAP_DATA.COLORS[nodeData.type]}"><i class="fas ${MAP_DATA.ICONS[nodeData.type]}"></i> Отряд входит в зону: <strong>${label}</strong></div>`
        });
    }
}

function openNodeWindow(type) {
    if (type === MAP_DATA.NODE_DOOM) DoomAltar.open();
    if (type === MAP_DATA.NODE_SHOP) ShopWindow.open();
    if (type === MAP_DATA.NODE_RISK) RiskWindow.open();
}

// Карта изменилась (перемещение, новый этаж) — поле и строка состояния перерисовываются у всех
Hooks.on('updateScene', (scene, changes) => {
    if (scene.id !== canvas.scene?.id || !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) return;
    const app = foundry.applications.instances?.get(MAP_ID);
    if (app?.rendered) app.render({ parts: ['header', 'board', 'footer'] });
});
