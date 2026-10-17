/**
 * Gacha Roguelike dnd5e — Интерактивная Карта Этажа
 */

import { MODULE_ID } from "../core/constants.js";
import { INK_FORMS, DOODLES, seeded as seededRandom, inkValues, inkMotion, resetInkClock, sketchLine, brushRing, jitterPath } from "../core/ink.js";
import { mapScene, sceneForNewMap, rememberFloorScene } from "./scene-travel.js";
import { onNodeEntered } from "./horsemen.js";
import { DoomAltar } from "./doom-altar.js";
import { ShopWindow } from "./shop.js";
import { RiskWindow } from "./risk.js";
import { PortalWindow } from "./portal.js";
import { DealWindow } from "./moon-deal.js";
import { EventWindow } from "./events.js";
import { pulseView, resetPulse } from "./pulse.js";
import { getFloor } from "./economy.js";
import { leaveAnchor, announceScent, partyScent } from "./anchor.js";
import { leaveBodies } from "./graveyard.js";
import { OMEN_STAGES, getOmen, setOmen } from "./omen.js";
import { startBreach } from "./breach.js";

export const MAP_DATA = {
    NODE_START: 'start',
    NODE_BOSS: 'boss',
    NODE_MOB: 'mob',
    NODE_ELITE: 'elite',
    NODE_EVENT: 'event',
    NODE_RISK: 'risk',
    NODE_SHOP: 'shop',
    NODE_REST: 'rest',
    NODE_DOOM: 'doom',
    // Застава — средний ряд из одного узла: все пути сходятся на элитном бою, после него отряд получает уровень
    NODE_OUTPOST: 'outpost',
    OUTPOST_MIN_ROWS: 5,
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
        'doom': 'Погибель', 'outpost': 'Застава'
    },
    
    ICONS: {
        'start': 'fa-dungeon', 'boss': 'fa-skull', 'mob': 'fa-ghost', 'elite': 'fa-dragon',
        'event': 'fa-question', 'risk': 'fa-exclamation-triangle', 'shop': 'fa-coins', 'rest': 'fa-campground',
        'doom': 'fa-horse-head', 'outpost': 'fa-shield-halved'
    },
    
    COLORS: {
        'start': '#7a7062', 'boss': '#ff003c', 'mob': '#8c8275', 'elite': '#ff8000',
        'event': '#0070dd', 'risk': '#a335ee', 'shop': '#ffaa00', 'rest': '#1eff00',
        'doom': '#e6dcc3', 'outpost': '#d4a64a'
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

export function generateMapGraph(length) {
    const contentRows = Math.max(1, length - 1);
    // Застава — посередине этажа, если рядов хватает (номер ряда от Входа)
    const outpostRow = contentRows >= MAP_DATA.OUTPOST_MIN_ROWS ? Math.ceil(contentRows / 2) : 0;
    const widths = Array.from({ length: contentRows }, (_, i) => i + 1 === outpostRow ? 1 :
        Math.floor(Math.random() * (MAP_DATA.MAX_WIDTH - MAP_DATA.MIN_WIDTH + 1)) + MAP_DATA.MIN_WIDTH
    );
    
    const totalContentNodes = widths.reduce((a, b) => a + b, 0) - (outpostRow ? 1 : 0);
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
            let node = makeNode(r, c, r === outpostRow ? MAP_DATA.NODE_OUTPOST : types[typeIndex++]);
            rowNodes.push(node);
            nodes.push(node);
        }
        rows.push(rowNodes);
    }

    let boss = makeNode(rows.length, 0, MAP_DATA.NODE_BOSS);
    rows.push([boss]);
    nodes.push(boss);

    // Пути без пересечений: узлы ряда идут слева направо, у каждого — отрезок соседних целей в следующем ряду,
    // и отрезки не заходят друг за друга (общий край можно). Узел следующего ряда без входа отдаётся соседу
    for (let r = 0; r < rows.length - 1; r++) {
        const cur = rows[r], nxt = rows[r + 1];
        const w = cur.length, w2 = nxt.length;
        const ranges = [];
        let from = 0;
        cur.forEach((node, i) => {
            const k = Math.min(w2, Math.floor(Math.random() * (MAP_DATA.MAX_EDGES - MAP_DATA.MIN_EDGES + 1)) + MAP_DATA.MIN_EDGES);
            const centre = w === 1 ? (w2 - 1) / 2 : i * (w2 - 1) / (w - 1);
            // Только соседи: не дальше одного узла от места напротив
            const c = Math.round(centre);
            const lo = Math.max(from, Math.min(w2 - 1, c - 1, Math.round(centre - (k - 1) / 2)));
            const hi = Math.max(lo, Math.min(w2 - 1, c + 1, lo + k - 1));
            ranges.push([lo, hi]);
            from = hi;
        });
        ranges[0][0] = 0;
        ranges[w - 1][1] = w2 - 1;
        for (let i = 0; i < w - 1; i++) {
            const gapLo = ranges[i][1] + 1, gapHi = ranges[i + 1][0] - 1;
            if (gapLo > gapHi) continue;
            const mid = Math.floor((gapLo + gapHi) / 2);
            ranges[i][1] = mid;
            ranges[i + 1][0] = mid + 1;
        }
        cur.forEach((node, i) => {
            for (let j = ranges[i][0]; j <= ranges[i][1]; j++) node.next.push(nxt[j].id);
        });
    }

    // Сохраняем начальное состояние
    return { rows, nodes, currentNodeId: null, visitedNodes: [] };
}

// Отряд стоит на узле «Привал» текущей карты этажа
export function isPartyAtRest(scene = mapScene()) {
    const map = scene?.getFlag(MODULE_ID, 'floorMap');
    const node = map?.nodes?.find(n => n.id === map.currentNodeId);
    return node?.type === 'rest';
}


// ==========================================
// ОКНО КАРТЫ
// ==========================================

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TEMPLATES = 'modules/gachadnd/templates/map';
const MAP_ID = 'gachadnd-map-terminal';
const NODE_HINTS = {
    shop: 'щёлкните ещё раз, чтобы открыть Магазин',
    risk: 'щёлкните ещё раз, чтобы открыть Риск',
    event: 'щёлкните ещё раз, чтобы открыть дневник события',
    doom: 'щёлкните ещё раз, чтобы открыть Алтарь Погибели',
    rest: 'щёлкните ещё раз, чтобы открыть портал в Якорь',
    boss: 'после боя щёлкните ещё раз — Сделка луны'
};
// Порядок типов в легенде
const LEGEND_ORDER = ['mob', 'elite', 'event', 'risk', 'shop', 'rest', 'doom', 'outpost', 'boss'];

/* ---------- Набросок от руки ----------
 * Живые чернила — общие (core/ink.js); зерно — сама карта: у всех клиентов и при каждой перерисовке
 * линии дрожат одинаково, а новая карта рисуется иначе. */

// Поле в процентах; размер в пикселях нужен, чтобы отступы и рисунки не зависели от пропорций поля.
// Ширина — как у окна карты, высота — по числу рядов: поле выше окна и прокручивается (boardContext)
const BOARD_W = 680;
export const ROW_PX = 122, EDGE_PX = { top: 70, bottom: 80 };
let BOARD_PX = { x: BOARD_W / 100, y: 7.4 };
/** Рисунки в пустых местах поля: подальше от узлов, путей и друг от друга */
function placeDoodles(rand, nodeCoords, edgePoints) {
    const far = (p, list, px) => list.every(q => Math.hypot((p.x - q.x) * BOARD_PX.x, (p.y - q.y) * BOARD_PX.y) > px);
    const pool = [...DOODLES.keys()].sort(() => rand() - 0.5);
    const placed = [];
    // На длинном поле рисунков больше — по одному на полтора экрана
    const limit = Math.min(DOODLES.length, Math.round(7 * BOARD_PX.y / 7.4));
    for (let attempt = 0; attempt < 600 && placed.length < limit && pool.length; attempt++) {
        const p = { x: 9 + rand() * 82, y: 6 + rand() * 88 };
        if (!far(p, nodeCoords, 95) || !far(p, edgePoints, 42) || !far(p, placed, 140)) continue;
        const d = DOODLES[pool.pop()];
        placed.push({
            ...p, d, values: inkValues(Array.from({ length: INK_FORMS }, () => jitterPath(d, rand, 0.9))), ...inkMotion(rand),
            size: Math.round(40 + rand() * 20), turn: Math.round(rand() * 40 - 20)
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
            generate: GachaMapTerminal.#onGenerate,
            // «Здесь» — прорыв: Мастер выбирает точку, у всех катсцена, затем токен
            omen: (event, target) => target.dataset.stage === 'here' ? startBreach() : setOmen(target.dataset.stage)
        }
    };

    static PARTS = Object.fromEntries(['header', 'board', 'footer'].map(id => [id, { template: `${TEMPLATES}/${id}.hbs` }]));

    static open() {
        const existing = foundry.applications.instances?.get(MAP_ID);
        if (existing) return existing.render({ force: true }).then(() => existing.bringToFront?.());
        return new GachaMapTerminal().render({ force: true });
    }

    get map() {
        return mapScene()?.getFlag(MODULE_ID, 'floorMap') ?? null;
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
            hasMap: !!map?.nodes?.length,
            scent: game.user.isGM ? partyScent(undefined, floor) : null,
            pulse: game.user.isGM ? pulseView() : null,
            omen: game.user.isGM ? Object.entries(OMEN_STAGES).map(([stage, { label }]) => ({ stage, label, active: stage === getOmen() })) : null
        };
        if (!context.hasMap) return context;

        return Object.assign(context, boardContext(map, floor));
    }

    // Поле выше окна: после перерисовки окно встаёт на отряд (до выхода на карту — на Вход). Первый раз — сразу,
    // потом плавно от того места, где поле было
    #scrollTop = null;
    #scrollToParty() {
        const board = this.element?.querySelector('.gd-map-board');
        const node = board?.querySelector('.gd-map-node.current') ?? board?.querySelector('.gd-map-node.type-start');
        if (!board || !node) return;
        board.addEventListener('scroll', () => { this.#scrollTop = board.scrollTop; }, { passive: true });
        const target = Math.max(0, node.offsetTop - board.clientHeight * 0.62);
        if (this.#scrollTop === null) board.scrollTop = target;
        else {
            board.scrollTop = this.#scrollTop;
            board.scrollTo({ top: target, behavior: 'smooth' });
        }
        this.#scrollTop = board.scrollTop;
    }

    // Перерисовка поля не должна перезапускать движение: покачивание значков ставится на время страницы,
    // как и начало течения чернил (resetInkClock в core/ink.js)
    _onRender(context, options) {
        super._onRender(context, options);
        this.#scrollToParty();
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
        const length = parseInt(this.element.querySelector('[name="length"]')?.value) || 11;
        // Номер нового этажа забега — из поля; по умолчанию следующий, если по прошлой карте уже ходили
        const floor = Math.max(1, parseInt(this.element.querySelector('[name="floor"]')?.value) || getFloor());
        // Прошлый этаж — для Летописи (chronicle.js): она идёт у всех, если по старой карте ходили
        const oldMap = mapScene()?.getFlag(MODULE_ID, 'floorMap') ?? null;
        const oldFloor = getFloor();
        await game.settings.set(MODULE_ID, 'runFloor', floor);
        // Карта чертится на текущей сцене (на сцене Якоря — на сцене этажа), сцена запоминается
        const scene = sceneForNewMap();
        if (scene) {
            const newMap = generateMapGraph(length);
            // Старая Летопись уходит вместе со старой картой: unsetFlag, иначе setFlag сольёт записи
            await scene.unsetFlag(MODULE_ID, 'floorMap');
            await scene.setFlag(MODULE_ID, 'floorMap', newMap);
            await rememberFloorScene(scene);
            Hooks.callAll('gachadnd.floorDrawn', { oldMap, oldFloor, newMap, newFloor: floor });
        }
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
            // Босс: Сделка луны — только повторным щелчком, после боя (при входе окно не открывается)
            if (mapData.currentNodeId === nodeId) {
                if (nodeData.type === MAP_DATA.NODE_REST) return PortalWindow.open();
                if (nodeData.type === MAP_DATA.NODE_BOSS) return DealWindow.open();
                return openNodeWindow(nodeData.type);
            }
            const currentNode = mapData.nodes.find(n => n.id === mapData.currentNodeId);
            if (!currentNode.next.includes(nodeId) && !mapData.visitedNodes.includes(nodeId)) {
                return ui.notifications.warn('Отряд может двигаться только по связанным линиям вперёд!');
            }
        }

        // Отряд уходит с узла: тела погибших забирают или оставляют Пределу
        await leaveBodies();

        mapData.currentNodeId = nodeId;
        if (!mapData.visitedNodes.includes(nodeId)) mapData.visitedNodes.push(nodeId);
        // Флаг сцены расходится всем клиентам; их карты перерисуются хуком updateScene
        const scene = mapScene();
        if (scene) {
            await scene.setFlag(MODULE_ID, 'floorMap', mapData);
            await rememberFloorScene(scene);
        }

        // Шаг по карте уводит из Якоря; серия Войны и штраф проклятой Войны; окна узлов
        await leaveAnchor();
        await onNodeEntered(nodeData.type);
        if (nodeData.type === MAP_DATA.NODE_REST) await resetPulse();
        openNodeWindow(nodeData.type);

        const label = MAP_DATA.LABELS[nodeData.type] ?? nodeData.label;
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: 'Путеводитель Тумана' }),
            content: `<div class="gachadnd-map-chat" style="--node: ${MAP_DATA.COLORS[nodeData.type]}"><i class="fas ${MAP_DATA.ICONS[nodeData.type]}"></i> Отряд входит в зону: <strong>${label}</strong></div>`
        });
        // Нюх Пожирателя: Мастеру — Запах и узел прорыва, игрокам — атмосфера
        await announceScent(nodeData.type);
    }
}

/**
 * Поле карты для шаблона board.hbs: узлы, пути, рисунки на полях, легенда. Окно карты и Летопись этажа
 * рисуют один и тот же набросок (зерно — сама карта).
 */
export function boardContext(map, floor) {
    const board = {};
    const { rows, nodes, currentNodeId, visitedNodes = [] } = map;
    const current = nodes.find(n => n.id === currentNodeId) ?? null;
    const reachable = new Set(current ? current.next : nodes.filter(n => n.type === MAP_DATA.NODE_START).map(n => n.id));
    const visited = new Set(visitedNodes);
    // Куда ещё можно дойти: потомки текущего узла (до выхода на карту — весь этаж)
    const ahead = new Set();
    const queue = current ? [...current.next] : nodes.map(n => n.id);
    while (queue.length) {
        const id = queue.pop();
        if (ahead.has(id)) continue;
        ahead.add(id);
        queue.push(...(nodes.find(n => n.id === id)?.next ?? []));
    }

    // Поле: ряды через ROW_PX снизу вверх (Вход внизу, Босс вверху); координаты — проценты поля
    const height = EDGE_PX.top + EDGE_PX.bottom + (rows.length - 1) * ROW_PX;
    BOARD_PX = { x: BOARD_W / 100, y: height / 100 };
    board.height = height;
    const coords = {};
    rows.forEach((row, r) => {
        const y = (height - EDGE_PX.bottom - r * ROW_PX) / height * 100;
        row.forEach((node, c) => { coords[node.id] = { x: 8 + ((c + 0.5) / row.length) * 84, y, k: 1 }; });
    });

    resetInkClock();
    // Зерно — сама карта: перерисовка и другие клиенты видят тот же набросок
    const seed = `${floor}|${nodes.map(n => `${n.id}${n.type}${n.next.join(',')}`).join(';')}`;
    const look = node => ({ color: MAP_DATA.COLORS[node.type] ?? node.color, icon: MAP_DATA.ICONS[node.type] ?? node.icon, label: MAP_DATA.LABELS[node.type] ?? node.label });

    // Отряд обведён толстым мазком, пройденные узлы — тонким, доступные — небрежной незамкнутой петлёй
    const RINGS = {
        current: { radius: 34, width: 9, turns: 1.18 },
        visited: { radius: 33, width: 4.5, turns: 1.05 },
        reachable: { radius: 34, width: 3.6, turns: 0.82 }
    };
    // Подписи — только там, где они нужны: отряд, следующий шаг, Вход и Босс; у остальных — при наведении
    const labeled = node => node.id === currentNodeId || reachable.has(node.id) || ['start', 'boss'].includes(node.type);
    board.nodes = nodes.map(node => {
        const state = node.id === currentNodeId ? 'current' : reachable.has(node.id) ? 'reachable' : visited.has(node.id) ? 'visited' : 'locked';
        const reach = state === 'locked' ? (ahead.has(node.id) ? ' ahead' : ' gone') : '';
        const rand = seededRandom(`${seed}|ring|${node.id}|${state}`);
        const forms = RINGS[state] ? brushRing(rand, RINGS[state]) : null;
        const ring = forms ? { d: forms[0], values: inkValues(forms), ...inkMotion(rand) } : null;
        return { id: node.id, ...coords[node.id], k: coords[node.id].k.toFixed(3), ...look(node), cls: `${state}${reach}${labeled(node) ? ' labeled' : ''} type-${node.type}`, ring, hint: node.id === currentNodeId ? NODE_HINTS[node.type] : null };
    });

    // Пути: пройденный — двойная линия, будто обведён дважды; следующий шаг — крупный пунктир; дальше, куда ещё
    // можно дойти, — тонкая линия; недостижимые — едва заметны
    const edgePoints = [];
    board.edges = nodes.flatMap(node => node.next.map(nextId => {
        const rand = seededRandom(`${seed}|edge|${node.id}|${nextId}`);
        const traversed = visited.has(node.id) && visited.has(nextId);
        const open = node.id === currentNodeId || (!current && node.type === MAP_DATA.NODE_START);
        const k = (coords[node.id].k + coords[nextId].k) / 2;
        const lines = [sketchLine(coords[node.id], coords[nextId], rand, { trim: 32 * k, wobble: 3.5 * k, flow: 3.5 * k, px: BOARD_PX })];
        if (traversed) lines.push(sketchLine(coords[node.id], coords[nextId], rand, { trim: 32 * k, wobble: 3 * k, flow: 3.5 * k, px: BOARD_PX }));
        edgePoints.push(...lines[0].points);
        const strokes = lines.map(line => ({ d: line.forms[0], values: inkValues(line.forms), ...inkMotion(rand) }));
        const further = ahead.has(nextId) && (ahead.has(node.id) || node.id === currentNodeId || !current);
        return { strokes, from: node.id, to: nextId, k: k.toFixed(3), cls: traversed ? 'traversed' : open ? 'open' : further ? 'ahead' : 'faint' };
    }));
    board.doodles = placeDoodles(seededRandom(`${seed}|doodles`), Object.values(coords), edgePoints);

    board.current = current ? look(current) : null;
    board.next = current ? current.next.map(id => look(nodes.find(n => n.id === id))) : [];
    const counts = {};
    for (const node of nodes) if (!['start'].includes(node.type)) counts[node.type] = (counts[node.type] ?? 0) + 1;
    board.legend = LEGEND_ORDER.filter(t => counts[t]).map(t => ({ ...look({ type: t }), count: counts[t] }));
    // Положение узлов в процентах поля — Летопись ведёт по ним нить пути
    board.coords = coords;
    return board;
}

function openNodeWindow(type) {
    if (type === MAP_DATA.NODE_DOOM) DoomAltar.open();
    if (type === MAP_DATA.NODE_SHOP) ShopWindow.open();
    if (type === MAP_DATA.NODE_RISK) RiskWindow.open();
    if (type === MAP_DATA.NODE_EVENT && game.user.isGM) EventWindow.open();
}

// Запах в подвале карты у Мастера: кристаллы и навыки отряда изменились — подвал перерисовывается
let scentTimer = null;
const refreshScent = item => {
    if (!game.user.isGM || !item?.parent?.hasPlayerOwner) return;
    clearTimeout(scentTimer);
    scentTimer = setTimeout(() => {
        const app = foundry.applications.instances?.get(MAP_ID);
        if (app?.rendered) app.render({ parts: ['footer'] });
    }, 150);
};
for (const hook of ['createItem', 'updateItem', 'deleteItem']) Hooks.on(hook, refreshScent);

// Стадия предвестий сменилась — подсветка кнопок в подвале у Мастера
Hooks.on('gachadnd.omenChanged', () => {
    const app = foundry.applications.instances?.get(MAP_ID);
    if (game.user.isGM && app?.rendered) app.render({ parts: ['footer'] });
});

// Карта изменилась (перемещение, новый этаж) — поле и строка состояния перерисовываются у всех
Hooks.on('updateScene', (scene, changes) => {
    if (scene.id !== mapScene()?.id || !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) return;
    const app = foundry.applications.instances?.get(MAP_ID);
    if (app?.rendered) app.render({ parts: ['header', 'board', 'footer'] });
});
