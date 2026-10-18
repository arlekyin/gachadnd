/**
 * Gacha Roguelike dnd5e — Слой паутины (вид карты в режиме паутины)
 *
 * Паутина не в окне, а слоем на большую часть экрана, как кровавая паутина: лист дневника, нарисованный живыми
 * чернилами, края листа незаметно растворяются в сцене. Узлы крупные, пути прямыми штрихами; куда отряд может
 * шагнуть сейчас — красными чернилами.
 * Щелчок по узлу ведёт отряд (Мастер), Esc или крестик — закрыть. У Мастера — панель инструментов: черчение
 * этажа, Запах, предвестия, Насыщение (те же части, что в окне карты).
 *
 * Данные — флаг карты сцены (web-map.js); ход — общий с окном карты (map.js → stepTo).
 */

import { MODULE_ID } from "../core/constants.js";
import { boardContext, webBoardContext, stepTo, drawFloorFrom, devourerGone, GachaMapTerminal } from "./map.js";
import { mapScene } from "./scene-travel.js";
import { getFloor } from "./economy.js";
import { partyScent } from "./anchor.js";
import { pulseView } from "./pulse.js";
import { OMEN_STAGES, getOmen, setOmen } from "./omen.js";
import { addSatiety, getSatiety, satietyCap } from "./devourer-state.js";
import { startBreach } from "./breach.js";
import { isWeb } from "./web-map.js";
import { floorBiome, biomeArt } from "./biomes.js";
import { floorMarks } from "./chronicle.js";
import { DOODLES, INK_FORMS, seeded, inkValues, inkMotion, jitterPath } from "../core/ink.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const ID = 'gachadnd-web-overlay';
const TEMPLATES = 'modules/gachadnd/templates/map';
const MARGIN = 250;

// Записи на полях: что случилось на пройденных узлах (Летопись этажа) — почерком у самого узла
const NOTE = {
    burn: text => `сгорел ${text.replace(/^.*?: /, '')}`,
    breach: () => 'прорыв Пожирателя',
    fallen: text => `здесь пал ${text}`,
    moon: text => text,
    echo: text => text,
    devour: () => 'Пожиратель за нас',
    resident: text => text
};
function marginNotes(map, floor, coords) {
    let marks = [];
    try { marks = floorMarks(map, floor); } catch (error) { marks = map.chronicle ?? []; }
    const seen = new Map();
    return marks.filter(m => coords[m.nodeId] && NOTE[m.kind]).slice(-10).map(m => {
        const n = seen.get(m.nodeId) ?? 0;
        seen.set(m.nodeId, n + 1);
        const text = NOTE[m.kind](String(m.text ?? ''));
        return { x: coords[m.nodeId].x, y: coords[m.nodeId].y, text: text.length > 30 ? `${text.slice(0, 29)}…` : text, kind: m.kind, shift: n * 20 };
    });
}

/**
 * Рисунки на листе вокруг паутины — по углам квадрата, где сеть их не задевает: роза ветров (всегда, крупно),
 * остальные — из набросков на полях Разлома (core/ink.js), живыми чернилами.
 */
function pageDecor(seed, coords) {
    const rand = seeded(`${seed}|decor`);
    const ink = (d, size, x, y, turn, cls = '') => ({
        x, y, size, turn, cls, d, values: inkValues(Array.from({ length: INK_FORMS }, () => jitterPath(d, rand, 0.7))), ...inkMotion(rand)
    });
    // Места по углам поля: свободнее всего от узлов — первым (там роза ветров)
    const spots = [[8, 9], [92, 8], [8, 91], [91, 90]]
        .map(([x, y]) => ({ x, y, room: Math.min(...coords.map(c => Math.hypot(c.x - x, c.y - y))) }))
        .filter(s => s.room > 9).sort((a, b) => b.room - a.room);
    const pool = DOODLES.slice(1).sort(() => rand() - 0.5);
    return spots.slice(0, 4).map((spot, i) => i === 0
        ? ink(DOODLES[0], Math.min(150, spot.room * 9), spot.x, spot.y, Math.round(rand() * 30 - 15), 'compass')
        : ink(pool[i], Math.min(76, spot.room * 7), spot.x, spot.y, Math.round(rand() * 40 - 20)));
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

export class WebOverlay extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: ID,
        classes: ['gachadnd-web-overlay'],
        tag: 'div',
        window: { frame: false, positioned: false },
        actions: {
            node: (event, target) => stepTo(target.dataset.nodeId),
            close: function () { return this.close(); },
            tools: function () { this.tools = !this.tools; return this.render(); },
            generate: function () { return drawFloorFrom(this.element); },
            omen: (event, target) => (target.dataset.stage === 'here' ? startBreach() : setOmen(target.dataset.stage)),
            satiety: (event, target) => addSatiety(Number(target.dataset.delta), 'Мастер'),
            devourerGone: () => devourerGone('по решению Мастера')
        }
    };

    static PARTS = { overlay: { template: `${TEMPLATES}/web-overlay.hbs` } };

    tools = false;

    static open() {
        const existing = foundry.applications.instances?.get(ID);
        if (existing) return existing.render({ force: true });
        return new WebOverlay().render({ force: true });
    }

    static toggle() {
        const existing = foundry.applications.instances?.get(ID);
        return existing?.rendered ? existing.close() : WebOverlay.open();
    }

    async _preFirstRender(context, options) {
        await super._preFirstRender(context, options);
        await foundry.applications.handlebars.loadTemplates([`${TEMPLATES}/header.hbs`, `${TEMPLATES}/footer.hbs`, `${TEMPLATES}/board.hbs`]);
    }

    async _prepareContext() {
        const map = mapScene()?.getFlag(MODULE_ID, 'floorMap') ?? null;
        const floor = getFloor();
        const isGM = game.user.isGM;
        const context = {
            floor, floorRoman: ROMAN[floor - 1] ?? floor, isGM, tools: this.tools,
            nextFloor: map?.visitedNodes?.length ? floor + 1 : floor, mapMode: 'web',
            hasMap: !!map?.nodes?.length,
            scent: isGM ? partyScent(undefined, floor) : null,
            pulse: isGM ? pulseView() : null,
            satiety: isGM ? { value: getSatiety(), cap: satietyCap(floor) } : null,
            omen: isGM ? Object.entries(OMEN_STAGES).map(([stage, { label }]) => ({ stage, label, active: stage === getOmen() })) : null
        };
        if (!isWeb(map)) return context;
        // Лист: квадрат на большую часть высоты экрана; рисунок — тот же набросок живыми чернилами, что у окна
        // Страница на весь экран: поле слева, паутина — квадрат почти во всю высоту страницы
        const size = Math.round(Math.min(window.innerHeight * 0.66, window.innerWidth * 0.62 - MARGIN - 40));
        const board = webBoardContext(map, floor, { size });
        const moves = board.nodes.filter(n => n.cls.includes('reachable')).length;
        return Object.assign(context, board, {
            size, scale: (size / 560 * 0.74).toFixed(3), hasBoard: true,
            art: { outer: biomeArt(floorBiome(floor, false)), inner: floorBiome(floor, true) !== floorBiome(floor, false) ? biomeArt(floorBiome(floor, true)) : null },
            notes: marginNotes(map, floor, board.coords),
            decor: pageDecor(`${floor}|${map.nodes.map(n => n.id).join('')}`, Object.values(board.coords)),
            hint: isGM
                ? (map.currentNodeId ? 'Щёлкните узел — отряд пойдёт туда. Красными чернилами — куда можно за этот шаг.' : 'Щёлкните узел внешней зоны — отряд войдёт на этаж.')
                : 'Куда идти — решаете вслух, отряд ведёт Мастер. Красными чернилами — куда можно за этот шаг.',
            moves
        });
    }

    _onFirstRender(context, options) {
        super._onFirstRender(context, options);
        this.element.classList.add('gd-wo-opening');
        setTimeout(() => this.element?.classList.remove('gd-wo-opening'), 600);
        this.escape = event => { if (event.key === 'Escape' && !event.target.closest?.('input, select, textarea')) this.close(); };
        document.addEventListener('keydown', this.escape);
        // Размер листа — от экрана
        this.resize = foundry.utils.debounce(() => this.render(), 200);
        window.addEventListener('resize', this.resize);
    }

    _onRender(context, options) {
        super._onRender(context, options);
        // Значки узлов чуть покачиваются, как на карте рядов; при «меньше движения» — замирают
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            this.element.querySelectorAll('svg.gd-ink').forEach(svg => svg.pauseAnimations?.());
            return;
        }
        const now = performance.now();
        this.element.querySelectorAll('.gd-map-mark i').forEach((icon, index) => {
            const sway = icon.animate([{ transform: 'rotate(-3deg) translateY(1px)' }, { transform: 'rotate(3deg) translateY(-1px)' }],
                { duration: 4800 + (index % 3) * 850, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
            sway.currentTime = now + index * 1700;
        });
    }

    _onClose(options) {
        super._onClose(options);
        document.removeEventListener('keydown', this.escape);
        window.removeEventListener('resize', this.resize);
    }
}

// Карта изменилась у всех — слой перерисовывается; стала рядами — слой уступает окну карты
Hooks.on('updateScene', (scene, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`) && !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=floorMap`)) return;
    const app = foundry.applications.instances?.get(ID);
    if (!app?.rendered) return;
    const map = mapScene()?.getFlag(MODULE_ID, 'floorMap');
    if (map && !isWeb(map)) { app.close(); GachaMapTerminal.open(); return; }
    app.render();
});
const refresh = () => { const app = foundry.applications.instances?.get(ID); if (app?.rendered) app.render(); };
Hooks.on('gachadnd.omenChanged', refresh);
Hooks.on('updateSetting', setting => { if ([`${MODULE_ID}.devourerSatiety`, `${MODULE_ID}.runFloor`].includes(setting.key)) refresh(); });
let timer = null;
for (const hook of ['createItem', 'updateItem', 'deleteItem']) Hooks.on(hook, item => {
    if (!game.user.isGM || !item?.parent?.hasPlayerOwner) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
});
