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
        position: { width: 560, height: 760 },
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
            const y = 92 - (r / Math.max(1, rows.length - 1)) * 82;
            row.forEach((node, c) => { coords[node.id] = { x: 12 + ((c + 0.5) / row.length) * 76, y }; });
        });

        const look = node => ({ color: MAP_DATA.COLORS[node.type] ?? node.color, icon: MAP_DATA.ICONS[node.type] ?? node.icon, label: MAP_DATA.LABELS[node.type] ?? node.label });
        context.nodes = nodes.map(node => {
            const state = node.id === currentNodeId ? 'current' : reachable.has(node.id) ? 'reachable' : visited.has(node.id) ? 'visited' : 'locked';
            return { id: node.id, ...coords[node.id], ...look(node), cls: `${state} type-${node.type}`, hint: node.id === currentNodeId ? NODE_HINTS[node.type] : null };
        });

        // Пути: пройденный — светится, доступный — пунктир, остальные — едва видны.
        // Кривая Безье со стороны рядов, чтобы пересечения читались
        context.edges = nodes.flatMap(node => node.next.map(nextId => {
            const a = coords[node.id], b = coords[nextId];
            const mid = (a.y + b.y) / 2;
            const traversed = visited.has(node.id) && visited.has(nextId);
            const open = node.id === currentNodeId || (!current && node.type === MAP_DATA.NODE_START);
            return {
                d: `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} C ${a.x.toFixed(2)} ${mid.toFixed(2)}, ${b.x.toFixed(2)} ${mid.toFixed(2)}, ${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
                cls: traversed ? 'traversed' : open ? 'open' : 'faint',
                from: node.id, to: nextId, a, b, traversed
            };
        }));
        // Порядок пройденных путей — для следов: последний шаг отряда проявляется заново
        const order = visitedNodes;
        context.steps = context.edges.filter(e => e.traversed && order.indexOf(e.to) === order.indexOf(e.from) + 1)
            .map(e => ({ a: e.a, b: e.b, fresh: e.to === currentNodeId }));

        context.current = current ? look(current) : null;
        context.next = current ? current.next.map(id => look(nodes.find(n => n.id === id))) : [];
        const counts = {};
        for (const node of nodes) if (!['start'].includes(node.type)) counts[node.type] = (counts[node.type] ?? 0) + 1;
        context.legend = LEGEND_ORDER.filter(t => counts[t]).map(t => ({ ...look({ type: t }), count: counts[t] }));
        return context;
    }

    // Следы отряда, как на карте Мародёров: отпечатки вдоль пройденных путей.
    // Ставятся после отрисовки — нужен настоящий размер поля, чтобы шаги шли вдоль кривой
    _onRender(context, options) {
        super._onRender(context, options);
        const board = this.element.querySelector('.gd-map-board');
        const layer = board?.querySelector('.gd-map-steps');
        if (!layer || !context.steps?.length) return;
        const width = board.clientWidth, height = board.clientHeight;
        const html = [];
        for (const step of context.steps) {
            const p0 = { x: step.a.x * width / 100, y: step.a.y * height / 100 };
            const p3 = { x: step.b.x * width / 100, y: step.b.y * height / 100 };
            const p1 = { x: p0.x, y: (p0.y + p3.y) / 2 }, p2 = { x: p3.x, y: (p0.y + p3.y) / 2 };
            const at = t => {
                const u = 1 - t;
                return {
                    x: u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x,
                    y: u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y
                };
            };
            // Шаг каждые ~18 пикселей, кроме кругов узлов на концах
            const length = Math.hypot(p3.x - p0.x, p3.y - p0.y) * 1.15;
            const count = Math.max(2, Math.floor((length - 56) / 18));
            for (let i = 0; i < count; i++) {
                const t = (30 / length) + (i / Math.max(1, count - 1)) * (1 - 60 / length);
                const p = at(t), q = at(Math.min(1, t + 0.01));
                const angle = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI + 90;
                const side = i % 2 ? 1 : -1;
                const nx = Math.cos((angle) * Math.PI / 180) * 4 * side, ny = Math.sin((angle) * Math.PI / 180) * 4 * side;
                const delay = step.fresh ? `animation-delay: ${(i * 0.12).toFixed(2)}s;` : '';
                html.push(`<i class="gd-step ${step.fresh ? 'fresh' : ''}" style="left: ${(p.x + nx).toFixed(1)}px; top: ${(p.y + ny).toFixed(1)}px; transform: translate(-50%, -50%) rotate(${angle.toFixed(0)}deg); ${delay}"></i>`);
            }
        }
        layer.innerHTML = html.join('');
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
