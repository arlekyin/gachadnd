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
import { getSatiety } from "./devourer-state.js";
import { getFloor } from "./economy.js";
import { buildConnectedWeb, speedFor, advanceWeb as advance, WEB, BOSS_STAGES } from "./web-graph.js";
import { t } from "../core/i18n.js";

export { WEB, BOSS_STAGES, activeStages, moveDevourer, webStage, ticksToNextStage, webMoves, distance, devourerDistance, sealed, devourerLeaves, omenFor, nodeOf, isEaten, touchedSet, nextStepToward } from "./web-graph.js";

export function registerWebSettings() {
    // Режим, которым Мастер чертил последний этаж: окно карты предлагает его снова
    game.settings.register(MODULE_ID, 'mapMode', { scope: 'world', config: false, type: String, default: 'rows' });
    // Часы паутины и ступени Босса — Мастер правит их в инструментах паутины
    const apply = () => applyWebSettings();
    game.settings.register(MODULE_ID, 'webCalm', { scope: 'world', config: false, type: Number, default: WEB_DEFAULTS.CALM, onChange: apply });
    game.settings.register(MODULE_ID, 'webEvery', { scope: 'world', config: false, type: Number, default: WEB_DEFAULTS.EVERY, onChange: apply });
    game.settings.register(MODULE_ID, 'webStages', { scope: 'world', config: false, type: String, default: BOSS_STAGES.map(s => s.id).join(','), onChange: apply });
    // Награда за ступени Босса (boss-rules.js): +1 кристалл за ступень; Мастер может выключить на панели
    game.settings.register(MODULE_ID, 'webBossReward', { scope: 'world', config: false, type: Boolean, default: true });
    Hooks.once('setup', apply);
    // Звуки паутины (web-sound.js) — у каждого свои; в подменю «Звуки и эффекты»
    game.settings.register(MODULE_ID, 'webSounds', {
        name: t('Звуки паутины'), hint: t('Гул астролябии, звон кристаллов, шаги фонаря и укусы Пожирателя на карте-паутине. Громкость — «Звуки интерфейса».'),
        scope: 'client', config: false, type: Boolean, default: true
    });
}

const WEB_DEFAULTS = { CALM: WEB.CALM, EVERY: WEB.EVERY };

/** Числа паутины из настроек мира — в общие правила (web-graph.js) */
export function applyWebSettings() {
    const num = (key, fallback, min) => { const v = Math.round(Number(game.settings.get(MODULE_ID, key))); return Number.isFinite(v) && v >= min ? v : fallback; };
    WEB.CALM = num('webCalm', WEB_DEFAULTS.CALM, 0);
    WEB.EVERY = num('webEvery', WEB_DEFAULTS.EVERY, 1);
    const ids = String(game.settings.get(MODULE_ID, 'webStages') ?? '').split(',').filter(Boolean);
    WEB.STAGES = BOSS_STAGES.filter(s => ids.includes(s.id)).map(s => s.id);
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

/** Скорость Пожирателя на паутине — по его Насыщению (Запах решает только, выйдет ли он) */
export const devourerSpeed = () => speedFor(getSatiety());

/** Тик часов этажа после шага отряда (Мастер): Запах и Охота — по отряду и этажу */
export const advanceWeb = (map, { scent = partyScent() } = {}) => advance(map, { scent, satiety: getSatiety() });
