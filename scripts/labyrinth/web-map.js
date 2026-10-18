/**
 * Gacha Roguelike dnd5e — Паутина: второй режим карты этажа (docs/web-map.md)
 *
 * Сеть и правила хода — в web-graph.js (без Foundry: их же гоняет симулятор tools/sim/web.mjs). Здесь —
 * то, что знает о Foundry: настройка режима, содержимое узлов, Запах отряда и порог Охоты этажа.
 *
 * Карта — тот же флаг сцены floorMap, что у рядов: { mode: 'web', rows, nodes, currentNodeId, visitedNodes,
 * web: { ticks, devourer, pausedUntil, eaten, touched } }. rows — зоны (их видят Картограф и Летопись).
 */

import { MODULE_ID } from "../core/constants.js";
import { scentThresholds, partyScent } from "./anchor.js";
import { getFloor } from "./economy.js";
import { buildConnectedWeb, speedFor, advanceWeb as advance } from "./web-graph.js";

export { WEB, BOSS_STAGES, webStage, ticksToNextStage, webMoves, distance, devourerLeaves, omenFor, nodeOf, isEaten, touchedSet } from "./web-graph.js";

export function registerWebSettings() {
    // Режим, которым Мастер чертил последний этаж: окно карты предлагает его снова
    game.settings.register(MODULE_ID, 'mapMode', { scope: 'world', config: false, type: String, default: 'rows' });
}

export const isWeb = map => map?.mode === 'web';

/**
 * Паутина этажа. look(type) — подпись, значок и цвет узла; types(n) — состав n узлов (как у рядов).
 * Внутренняя зона тяжелее: Погибели там нет, одна-две лишние Элиты вместо Монстров.
 */
export function generateWebGraph({ look, types }) {
    const contents = (zone, n) => {
        const list = types(n);
        if (zone !== 'inner') return list;
        const heavy = list.map(t => (t === 'doom' ? 'mob' : t));
        for (let k = 0; k < 2; k++) { const i = heavy.indexOf('mob'); if (i >= 0) heavy[i] = 'elite'; }
        return heavy;
    };
    const { nodes, rows } = buildConnectedWeb(Math.random, contents);
    for (const node of nodes) Object.assign(node, look(node.type));
    return {
        mode: 'web', rows, nodes, currentNodeId: null, visitedNodes: [],
        web: { ticks: 0, devourer: null, pausedUntil: -1, eaten: [], touched: [] }
    };
}

/** Скорость Пожирателя по Запаху отряда на этом этаже */
export const devourerSpeed = (scent = partyScent(), floor = getFloor()) => speedFor(scent.value, scentThresholds(floor).hunt);

/** Тик часов этажа после шага отряда (Мастер): Запах и Охота — по отряду и этажу */
export const advanceWeb = (map, { scent = partyScent(), floor = getFloor() } = {}) => advance(map, { scent, hunt: scentThresholds(floor).hunt });
