/**
 * Gacha Roguelike dnd5e — Интерактивная Карта Этажа
 */

import { MODULE_ID } from "./main.js";

const MAP_DATA = {
    NODE_START: 'start',
    NODE_BOSS: 'boss',
    NODE_MOB: 'mob',
    NODE_ELITE: 'elite',
    NODE_EVENT: 'event',
    NODE_RISK: 'risk',
    NODE_SHOP: 'shop',
    NODE_REST: 'rest',
    
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
        'event': 'Событие', 'risk': 'Риск', 'shop': 'Магазин', 'rest': 'Привал'
    },
    
    ICONS: {
        'start': 'fa-dungeon', 'boss': 'fa-skull', 'mob': 'fa-ghost', 'elite': 'fa-dragon',
        'event': 'fa-question', 'risk': 'fa-exclamation-triangle', 'shop': 'fa-coins', 'rest': 'fa-campground'
    },
    
    COLORS: {
        'start': '#7a7062', 'boss': '#ff003c', 'mob': '#8c8275', 'elite': '#ff8000',
        'event': '#0070dd', 'risk': '#a335ee', 'shop': '#ffaa00', 'rest': '#1eff00'
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

export class GachaMapTerminal extends Application {
    constructor(options = {}) {
        super(options);
        this.currentMap = canvas.scene?.getFlag(MODULE_ID, 'floorMap') || null;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "gachadnd-map-terminal",
            template: null,
            width: 540,
            height: 750,
            resizable: true,
            classes: ["dnd5e2", "gacha-dark-theme"]
        });
    }

    get title() {
        return `Карта Разлома`;
    }

    async _renderInner(data) {
        // Подгружаем актуальную карту из сцены
        this.currentMap = canvas.scene?.getFlag(MODULE_ID, 'floorMap') || this.currentMap;

        const div = document.createElement("div");
        div.style.cssText = "display: flex; flex-direction: column; height: 100%; background: #0b0a0a; color: #d0c9c0; font-family: 'Modesto Condensed', serif; position: relative;";

        // CSS для анимации пульсации текущего узла
        const styleHtml = `
            <style>
                @keyframes gacha-pulse {
                    0% { box-shadow: 0 0 10px #00ffff, inset 0 0 8px rgba(0,255,255,0.4); }
                    50% { box-shadow: 0 0 25px #00ffff, inset 0 0 15px rgba(0,255,255,0.8); }
                    100% { box-shadow: 0 0 10px #00ffff, inset 0 0 8px rgba(0,255,255,0.4); }
                }
                .gacha-node-current { animation: gacha-pulse 2s infinite; border-color: #00ffff !important; z-index: 10 !important; }
                .gacha-node-visited { filter: saturate(0.5); opacity: 0.85; }
            </style>
        `;

        let controlPanel = '';
        if (game.user.isGM) {
            controlPanel = `
                <div style="padding: 10px; border-bottom: 1px solid #3d3834; display: flex; justify-content: space-between; align-items: center; background: #161414; z-index: 10;">
                    <div style="color: #7a7062; font-size: 1.1em;">Узлов: <input type="number" id="gacha-map-length" value="6" min="3" max="15" style="width: 40px; background: #000; color: #ffaa00; border: 1px solid #444; text-align: center;"></div>
                    <button id="gacha-generate-map-btn" style="width: 150px; padding: 4px; background: linear-gradient(180deg, #38250d 0%, #1a1105 100%); border: 1px solid #ffaa00; color: #ffaa00; font-weight: bold; cursor: pointer;">Создать Этаж</button>
                </div>
            `;
        }

        let mapHtml = `<div style="flex-grow: 1; display: flex; align-items: center; justify-content: center; color: #555; font-size: 1.2em; font-style: italic;">Карта скрыта в тумане...</div>`;

        if (this.currentMap) {
            const { rows, nodes, currentNodeId, visitedNodes = [] } = this.currentMap;
            const rowCount = rows.length;
            
            let svgLines = '';
            let htmlNodes = '';
            const nodeCoords = {};
            
            // Расчет координат
            rows.forEach((row, r) => {
                const w = row.length;
                const rowY = 90 - (r / (rowCount - 1)) * 80; 
                row.forEach((node, c) => {
                    const nodeX = 10 + ((c + 0.5) / w) * 80;
                    nodeCoords[node.id] = { x: nodeX, y: rowY };
                });
            });

            // Отрисовка линий
            nodes.forEach(node => {
                const start = nodeCoords[node.id];
                node.next.forEach(nextId => {
                    const end = nodeCoords[nextId];
                    
                    // Если оба узла посещены, значит отряд прошел по этому пути
                    const isTraversed = visitedNodes.includes(node.id) && visitedNodes.includes(nextId);
                    
                    const lineColor = isTraversed ? '#00ccff' : '#3d3834';
                    const lineWidth = isTraversed ? '4' : '3';
                    const lineDash = isTraversed ? 'none' : '5,5';
                    const lineGlow = isTraversed ? 'filter="url(#glow)"' : '';

                    svgLines += `<line x1="${start.x}%" y1="${start.y}%" x2="${end.x}%" y2="${end.y}%" stroke="${lineColor}" stroke-width="${lineWidth}" stroke-dasharray="${lineDash}" style="transition: all 0.3s;" />`;
                });
            });

            // Отрисовка узлов
            nodes.forEach(node => {
                const pos = nodeCoords[node.id];
                const isCurrent = node.id === currentNodeId;
                const isVisited = visitedNodes.includes(node.id);

                let nodeClass = "gacha-map-node";
                if (isCurrent) nodeClass += " gacha-node-current";
                else if (isVisited) nodeClass += " gacha-node-visited";

                // Перекрашиваем посещенные узлы в голубой
                const borderColor = isVisited ? '#0070dd' : node.color;
                const iconColor = isVisited ? '#00ccff' : node.color;
                const bg = isCurrent ? '#002233' : '#111';

                htmlNodes += `
                    <div class="${nodeClass}" data-node-id="${node.id}" style="position: absolute; left: ${pos.x}%; top: ${pos.y}%; transform: translate(-50%, -50%); width: 44px; height: 44px; background: ${bg}; border: 2px solid ${borderColor}; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 10px ${borderColor}44, inset 0 0 8px rgba(0,0,0,0.8); cursor: pointer; z-index: 5; transition: all 0.3s;" title="${node.label}">
                        <i class="fas ${node.icon}" style="color: ${iconColor}; font-size: 1.2em; text-shadow: 0 0 5px ${iconColor}; transition: all 0.3s;"></i>
                    </div>
                `;
            });

            mapHtml = `
                <div style="flex-grow: 1; position: relative; overflow: hidden; background: radial-gradient(circle at center, #1a1816 0%, #050404 100%);">
                    <svg style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1;">
                        ${svgLines}
                    </svg>
                    ${htmlNodes}
                </div>
            `;
        }

        div.innerHTML = styleHtml + controlPanel + mapHtml;
        return $(div);
    }

    activateListeners(html) {
        super.activateListeners(html);
        const element = html instanceof jQuery ? html[0] : html;

        // Генерация новой карты
        const genBtn = element.querySelector('#gacha-generate-map-btn');
        if (genBtn && game.user.isGM) {
            genBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                const length = parseInt(element.querySelector('#gacha-map-length').value) || 6;
                this.currentMap = generateMapGraph(length);
                
                if (canvas.scene) {
                    await canvas.scene.setFlag(MODULE_ID, 'floorMap', this.currentMap);
                }
                this.render(false);
            });
        }

        // Клик по узлам (Перемещение отряда)
        element.querySelectorAll('.gacha-map-node').forEach(nodeEl => {
            nodeEl.addEventListener('click', async (e) => {
                if (!game.user.isGM) {
                    ui.notifications.warn("Перемещать отряд может только Мастер.");
                    return;
                }

                const nodeId = e.currentTarget.dataset.nodeId;
                let mapData = foundry.utils.deepClone(this.currentMap);
                if (!mapData.visitedNodes) mapData.visitedNodes = [];

                const nodeData = mapData.nodes.find(n => n.id === nodeId);
                if (!nodeData) return;

                // Валидация перемещения
                if (!mapData.currentNodeId) {
                    // Если путешествие еще не начато, можно кликнуть только на Старт
                    if (nodeData.type !== 'start') {
                        ui.notifications.warn("Путешествие должно начинаться с начальной точки (Вход).");
                        return;
                    }
                } else {
                    // Если отряд уже где-то стоит
                    if (mapData.currentNodeId === nodeId) return; // Клик по текущей комнате
                    
                    const currentNode = mapData.nodes.find(n => n.id === mapData.currentNodeId);
                    if (!currentNode.next.includes(nodeId) && !mapData.visitedNodes.includes(nodeId)) {
                        ui.notifications.warn("Отряд может двигаться только по связанным линиям вперед!");
                        return;
                    }
                }

                // Обновляем состояние карты
                mapData.currentNodeId = nodeId;
                if (!mapData.visitedNodes.includes(nodeId)) {
                    mapData.visitedNodes.push(nodeId);
                }

                // Сохраняем в Сцену (это автоматически разошлет обновленную карту всем игрокам)
                this.currentMap = mapData;
                if (canvas.scene) {
                    await canvas.scene.setFlag(MODULE_ID, 'floorMap', mapData);
                }
                
                // Перерисовываем интерфейс
                this.render(false);

                // Сообщение в чат
                ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ alias: "Путеводитель Тумана" }),
                    content: `<div style="padding: 10px; background: #0b0a0a; border: 1px solid #00ccff; border-radius: 4px; color: #ede6dc; font-family: 'Modesto Condensed', serif; text-align: center; box-shadow: inset 0 0 15px rgba(0, 204, 255, 0.2);">
                        <h3 style="margin: 0; color: #00ccff; text-shadow: 0 0 5px #00ccff;"><i class="fas ${nodeData.icon}"></i> Отряд входит в зону: ${nodeData.label.toUpperCase()}</h3>
                    </div>`
                });
            });
        });
    }
}