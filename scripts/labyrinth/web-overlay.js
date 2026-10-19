/**
 * Gacha Roguelike dnd5e — Слой паутины (вид карты в режиме паутины)
 *
 * Паутина на весь экран, как кровавая паутина: дым, тёмные узлы с плиткой цвета типа, тонкие пути; куда отряд
 * может шагнуть — красное свечение; шаг — удержанием узла; съеденное Пожирателем обвивают пряди. Рисует WebGL
 * (web-stage.js, PIXI — движок сцены Foundry); заголовок, часы, подсказка и инструменты Мастера — элементы
 * страницы поверх. Esc или крестик — закрыть.
 *
 * Данные — флаг карты сцены (web-map.js); ход — общий с окном карты (map.js → stepTo).
 */

import { MODULE_ID } from "../core/constants.js";
import { MAP_DATA, stepTo, drawFloorFrom, devourerGone, gmDevourer, setWebNodeType, GachaMapTerminal } from "./map.js";
import { mapScene } from "./scene-travel.js";
import { getFloor } from "./economy.js";
import { partyScent } from "./anchor.js";
import { pulseView } from "./pulse.js";
import { OMEN_STAGES, getOmen, setOmen } from "./omen.js";
import { addSatiety, getSatiety, satietyCap } from "./devourer-state.js";
import { startBreach } from "./breach.js";
import { getSatiety as satietyNow } from "./devourer-state.js";
import { isWeb, webMoves, isEaten, touchedSet, nextStepToward, webStage, ticksToNextStage, activeStages, BOSS_STAGES, WEB } from "./web-map.js";
import { WebStage } from "./web-stage.js";
import { editHistory, undoEdit, linkNodes, unlinkNodes, moveParty, eatNode, cleanNode, shiftClock } from "./web-edit.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const ID = 'gachadnd-web-overlay';
const TEMPLATES = 'modules/gachadnd/templates/map';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
// Важность узла: обычные — чуть мельче, Заставы и Босс — крупнее
// Режимы правки: значок и текст полосы сверху
const EDIT_MODES = {
    devourer: { icon: 'fa-location-crosshairs', text: 'дважды щёлкните узел — Пожиратель встанет туда' },
    paint: { icon: 'fa-palette', text: 'дважды щёлкните узел — он сменит тип' },
    link: { icon: 'fa-link', text: 'щёлкните два узла — между ними протянется нить' },
    unlink: { icon: 'fa-link-slash', text: 'щёлкните два узла — нить между ними порвётся' },
    move: { icon: 'fa-person-walking-arrow-right', text: 'дважды щёлкните узел — отряд окажется там без шага' },
    eat: { icon: 'fa-droplet', text: 'дважды щёлкните узел — Пожиратель съест его' },
    clean: { icon: 'fa-sun', text: 'дважды щёлкните узел — порча сойдёт' }
};
/** «12 шагов», «2 шага», «1 шаг» */
const steps = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'шаг' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'шага' : 'шагов'}`;
const TIER = { mob: 'minor', event: 'minor', elite: 'major', shop: 'major', rest: 'major', risk: 'major', doom: 'major', outpost: 'seal', boss: 'boss' };

/** Модель паутины для рисовальщика: узлы с состоянием, пути, след Пожирателя */
export function webModel(map) {
    const moves = currentMoves(map);
    const visited = new Set(map.visitedNodes ?? []);
    const touched = touchedSet(map);
    const web = map.web ?? {};
    const openEdges = new Set();
    if (map.currentNodeId) for (const path of Object.values(moves)) {
        [map.currentNodeId, ...path].forEach((id, i, list) => { if (i) openEdges.add([list[i - 1], id].sort().join('|')); });
    }
    const nodes = map.nodes.map(n => {
        const state = n.id === map.currentNodeId ? 'current' : moves[n.id] ? 'reachable' : visited.has(n.id) ? 'visited' : 'locked';
        return {
            id: n.id, x: n.x, y: n.y, type: n.type, tier: TIER[n.type] ?? 'minor', state,
            color: MAP_DATA.COLORS[n.type] ?? n.color, icon: MAP_DATA.ICONS[n.type] ?? n.icon, label: MAP_DATA.LABELS[n.type] ?? n.label,
            visited: visited.has(n.id) && n.id !== map.currentNodeId,
            eaten: isEaten(map, n.id), touched: touched.has(n.id) && !isEaten(map, n.id) ? ((web.touched ?? []).find(([id]) => id === n.id)?.[1] ?? 2) : 0,
            path: moves[n.id] ?? null,
            labeled: state === 'current' || n.type === 'boss' || (!!map.currentNodeId && moves[n.id]?.length === 1)
        };
    });
    const seen = new Set();
    const edges = [];
    for (const n of map.nodes) for (const id of n.next) {
        const key = [n.id, id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        // Ход этого шага: к новому узлу — красным, по знакомым тропам — тускло-красным
        const cls = openEdges.has(key) ? (visited.has(n.id) && visited.has(id) ? 'familiar' : 'open') : visited.has(n.id) && visited.has(id) ? 'traversed' : isEaten(map, n.id) || isEaten(map, id) ? 'eaten' : 'ahead';
        edges.push({ a: n.id, b: id, cls });
    }
    const rank = { open: 2, familiar: 1 };
    edges.sort((x, y) => (rank[x.cls] ?? 0) - (rank[y.cls] ?? 0));
    // Босс: часы этажа и ступени — для обода астролябии, сердца и карточки
    const ticks = web.ticks ?? 0, stages = activeStages();
    const boss = {
        ticks, calm: WEB.CALM, every: WEB.EVERY, stage: webStage(ticks), toNext: ticksToNextStage(ticks), gm: game.user.isGM,
        // Шаг, на котором ступень набирается — как в ticksToNextStage (web-graph.js)
        stages: stages.map((st, i) => ({ ...st, at: i ? WEB.CALM + i * WEB.EVERY : WEB.CALM + 1 })),
        reward: webStage(ticks), purple: webStage(ticks) >= stages.length && stages.length > 0
    };
    return { boss, nodes, edges, trail: web.devourer ? (web.trail ?? []) : [], devourer: web.devourer ?? null, satiety: satietyNow(), speed: 1 + Math.floor(Math.min(5, satietyNow()) / 2), next: web.devourer && map.currentNodeId ? nextStepToward(map, web.devourer, map.currentNodeId) : null };
}
const currentMoves = map => webMoves(map);

export class WebOverlay extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: ID,
        classes: ['gachadnd-web-overlay'],
        tag: 'div',
        window: { frame: false, positioned: false },
        actions: {
            close: function () { return this.close(); },
            tools: function () { this.tools = !this.tools; this.collapsed = false; return this.render(); },
            gmTab: function (event, target) { this.tab = target.dataset.tab; this.collapsed = false; return this.render(); },
            gmCollapse: function () { this.collapsed = !this.collapsed; return this.render(); },
            shiftClock: (event, target) => shiftClock(Number(target.dataset.delta)),
            undo: () => undoEdit(),
            // Черновик нового этажа: номер, вид карты, длина рядов
            draft: function (event, target) {
                const { key, delta, value } = target.dataset;
                const d = this.draft;
                if (key === 'mode') d.mode = value;
                else d[key] = Math.max(key === 'length' ? 3 : 1, Math.min(key === 'length' ? 15 : 20, d[key] + Number(delta)));
                return this.render();
            },
            bossReward: () => game.settings.set(MODULE_ID, 'webBossReward', !game.settings.get(MODULE_ID, 'webBossReward')),
            generate: function () { return drawFloorFrom(this.element); },
            omen: (event, target) => (target.dataset.stage === 'here' ? startBreach() : setOmen(target.dataset.stage)),
            satiety: (event, target) => addSatiety(Number(target.dataset.delta), 'Мастер'),
            devourerGone: () => devourerGone('по решению Мастера'),
            // Терминал открывается на том же месте: тот же Туман, другой цвет
            terminal: async function () {
                const actor = canvas.tokens?.controlled[0]?.actor ?? game.user.character ?? game.actors.find(a => a.type === 'character' && a.hasPlayerOwner);
                if (!actor) return ui.notifications.warn('Выберите персонажа или токен на сцене.');
                await this.close({ instant: true });
                return game.gachadnd.openTerminal(actor);
            },
            // Удержание узла: шаг отряда, Пожиратель на узел или новое содержимое узла
            mode: function (event, target) { this.mode = this.mode === target.dataset.mode ? null : target.dataset.mode; this.linkFrom = null; return this.render(); },
            paintType: function (event, target) { this.paintType = target.dataset.type; this.mode = 'paint'; return this.render(); },
            devourerStep: () => gmDevourer(),
            stageToggle: (event, target) => {
                const ids = new Set(String(game.settings.get(MODULE_ID, 'webStages')).split(',').filter(Boolean));
                ids.has(target.dataset.stage) ? ids.delete(target.dataset.stage) : ids.add(target.dataset.stage);
                return game.settings.set(MODULE_ID, 'webStages', BOSS_STAGES.map(s => s.id).filter(id => ids.has(id)).join(','));
            },
            clock: (event, target) => {
                const key = target.dataset.key;
                const value = Math.max(key === 'webEvery' ? 1 : 0, Number(game.settings.get(MODULE_ID, key)) + Number(target.dataset.delta));
                return game.settings.set(MODULE_ID, key, value);
            }
        }
    };

    static PARTS = { overlay: { template: `${TEMPLATES}/web-overlay.hbs` } };

    tools = false;
    mode = null;
    paintType = 'mob';
    tab = 'play';
    collapsed = false;
    linkFrom = null;
    draft = null;

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
        await foundry.applications.handlebars.loadTemplates([`${TEMPLATES}/header.hbs`, `${TEMPLATES}/footer.hbs`, `${TEMPLATES}/web-gm.hbs`]);
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
        const ticks = map.web?.ticks ?? 0;
        const stage = webStage(ticks);
        const counts = {};
        for (const n of map.nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
        this.model = webModel(map);
        this.draft ??= { floor: map.visitedNodes?.length ? floor + 1 : floor, mode: 'web', length: 7 };
        const enabled = new Set(activeStages().map(s => s.id));
        const PAINT = ['mob', 'elite', 'event', 'risk', 'shop', 'rest', 'doom', 'outpost'];
        return Object.assign(context, {
            hasBoard: true,
            web: {
                ticks, stage, toNext: ticksToNextStage(ticks), calm: Math.max(0, WEB.CALM - ticks), eaten: (map.web?.eaten ?? []).length, every: WEB.EVERY,
                mood: ['Босс спит', 'Босс ворочается во сне', 'Босс проснулся', 'Босс в ярости', 'Босс в полной силе'][Math.min(4, Math.round((stage / Math.max(1, activeStages().length)) * 4))],
                stages: activeStages().map((s, i) => ({ ...s, on: i < stage })), devourer: !!map.web?.devourer, max: activeStages().length
            },
            mode: this.mode,
            editing: isGM && EDIT_MODES[this.mode] ? { ...EDIT_MODES[this.mode], mode: this.mode } : null,
            gm: isGM && this.tools ? {
                calm: WEB.CALM, every: WEB.EVERY, tab: this.tab, collapsed: this.collapsed,
                calmText: `Босс спит первые ${steps(WEB.CALM)}`, everyText: `Потом крепнет каждые ${steps(WEB.EVERY)}`,
                scent: this.#scentBar(context.scent),
                huntAlert: context.scent?.state === 'hunt',
                pulse: { ...context.pulse, steps: [-1, 0, 1, 2].map(o => o <= (context.pulse?.offset ?? 0)) },
                satiety: { ...context.satiety, dots: Array.from({ length: context.satiety.cap }, (_, i) => i < context.satiety.value), speed: (n => n === 1 ? '1 узел за шаг' : `${n} узла за шаг`)(1 + Math.floor(Math.min(5, context.satiety.value) / 2)) },
                omenOn: !!getOmen(),
                undo: editHistory()[0] ?? null, history: editHistory().slice(0, 6),
                draft: this.draft, reward: !!game.settings.get(MODULE_ID, 'webBossReward'),
                stages: BOSS_STAGES.map(s => ({ ...s, enabled: enabled.has(s.id) })),
                paint: PAINT.map(t => ({ type: t, label: MAP_DATA.LABELS[t], icon: MAP_DATA.ICONS[t], color: MAP_DATA.COLORS[t], on: this.mode === 'paint' && this.paintType === t }))
            } : null,
            legend: ['mob', 'elite', 'event', 'risk', 'shop', 'rest', 'doom', 'outpost', 'boss'].filter(t => counts[t]).map(t => ({ label: MAP_DATA.LABELS[t], icon: MAP_DATA.ICONS[t], color: MAP_DATA.COLORS[t], count: counts[t] })),
            hint: isGM && EDIT_MODES[this.mode] ? `Режим правки: ${this.mode === 'paint' ? `дважды щёлкните узел — он станет «${MAP_DATA.LABELS[this.paintType]}»` : EDIT_MODES[this.mode].text}. Esc — выход.`
                : isGM
                ? (map.currentNodeId ? 'Щёлкните кристалл, затем ещё раз — отряд пойдёт туда. Янтарные нити — куда можно за этот шаг.' : 'Щёлкните кристалл внешнего кольца, затем ещё раз — отряд войдёт на этаж.')
                : 'Куда идти — решаете вслух, отряд ведёт Мастер. Янтарные нити — куда можно за этот шаг.'
        });
    }

    #scentBar(scent) {
        if (!scent) return null;
        const top = Math.max(scent.thresholds.hunt * 1.25, scent.value, 1);
        const pct = v => Math.round((v / top) * 100);
        return { ...scent, whisper: scent.thresholds.whisper, hunt: scent.thresholds.hunt, fill: pct(scent.value), whisperAt: pct(scent.thresholds.whisper), huntAt: pct(scent.thresholds.hunt) };
    }

    _onFirstRender(context, options) {
        super._onFirstRender(context, options);
        this.element.classList.add('gd-wo-opening');
        setTimeout(() => this.element?.classList.remove('gd-wo-opening'), 1100);
        // Esc: сначала выход из режима правки, затем закрытие
        this.escape = event => {
            if (event.key !== 'Escape' || event.target.closest?.('input, select, textarea')) return;
            if (this.mode) { this.mode = null; this.linkFrom = null; this.render(); return; }
            this.close();
        };
        document.addEventListener('keydown', this.escape);
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const slot = this.element.querySelector('.gd-wo-canvas-slot');
        if (!slot) return;
        // Холст живёт между перерисовками: переносится в новое место, рисунок — по новой модели
        if (!this.stage) {
            const canvas = document.createElement('canvas');
            canvas.className = 'gd-wo-canvas';
            this.stage = new WebStage(canvas, {
                canStep: () => game.user.isGM,
                resizeTo: this.element,
                onStep: (id, held) => {
                    if (!game.user.isGM) return ui.notifications.info('Отряд ведёт Мастер — скажите ему, куда идти.');
                    if (!held) return;
                    if (this.mode === 'devourer') return gmDevourer(id);
                    if (this.mode === 'paint') return setWebNodeType(id, this.paintType);
                    if (this.mode === 'move') return moveParty(id);
                    if (this.mode === 'eat') return eatNode(id);
                    if (this.mode === 'clean') return cleanNode(id);
                    if (this.mode === 'link' || this.mode === 'unlink') return;
                    return stepTo(id);
                },
                onHover: (n, p, r) => this.#tooltip(n, p, r)
            });
            // Выбран кристалл — подсказка, что второй щелчок ведёт отряд
            this.stage.onSelect = n => {
                // Нити: первый узел запоминается, второй — связать или разорвать
                if (this.mode === 'link' || this.mode === 'unlink') {
                    if (n && this.linkFrom && this.linkFrom !== n.id) {
                        const from = this.linkFrom;
                        this.linkFrom = null;
                        return this.mode === 'link' ? linkNodes(from, n.id) : unlinkNodes(from, n.id);
                    }
                    this.linkFrom = n?.id ?? null;
                }
                const hint = this.element?.querySelector('.gd-wo-hint');
                if (!hint) return;
                hint.dataset.base ??= hint.textContent;
                const then = { devourer: 'Пожиратель встанет сюда', paint: 'узел сменится', move: 'отряд окажется здесь', eat: 'узел будет съеден', clean: 'порча сойдёт' }[this.mode];
                hint.textContent = !n ? hint.dataset.base
                    : this.mode === 'link' || this.mode === 'unlink' ? `${n.label}: теперь щёлкните второй узел.`
                    : `${n.label}: щёлкните ещё раз — ${then ?? 'отряд пойдёт сюда'}.`;
                hint.classList.toggle('armed', !!n);
            };
        }
        slot.replaceWith(this.stage.view);
        this.#fit();
        if (!this.model) return;
        // Паутина — левее середины своей части экрана (справа край слоя тает), во всю высоту
        this.stage.app.resize();
        const W = this.element.clientWidth, H = this.element.clientHeight;
        // Обод с медальонами ступеней выходит за поле на ~60 px — паутина ужата так, чтобы они помещались
        const size = Math.round(Math.min((H - 150) / 1.05, W * 0.6));
        this.stage.update({ ...this.model, size, center: { x: Math.max(size * 0.525 + 80, W * 0.36), y: H * 0.52 } });
    }

    /**
     * Слой занимает всю левую часть экрана — до боковой панели справа: поверх левого меню и панели макросов,
     * но под окнами (магазин, событие, листы) — они открываются над картой
     */
    #fit() {
        const right = document.getElementById('ui-right');
        const edge = right?.getBoundingClientRect().left;
        this.element.style.right = edge > window.innerWidth * 0.5 ? `${Math.max(0, window.innerWidth - edge)}px` : '0px';
    }

    #tooltip(n, p, r) {
        const tip = this.element?.querySelector('.gd-wo-tip');
        if (!tip) return;
        if (!n) { tip.hidden = true; tip.classList.remove('boss'); return; }
        const boss = this.model?.boss;
        // Медальон ступени и сам Босс — карточка Босса; игрокам — образ, Мастеру — числа
        if (n.medal || (n.type === 'boss' && boss)) {
            const esc = v => foundry.utils.escapeHTML(String(v ?? ''));
            const mood = ['Босс спит', 'Босс ворочается во сне', 'Босс проснулся', 'Босс в ярости', 'Босс в полной силе'][Math.min(4, boss.stage)];
            const rows = boss.stages.map((st, i) => `<div class="st ${i < boss.stage ? 'on' : ''}"><i class="fas ${st.icon}"></i><b>${esc(st.name)}</b><span>${esc(st.text)}</span></div>`).join('');
            const reward = boss.reward ? `<div class="rw">Добыча с Босса: <b>+${boss.reward} крист.</b>${boss.purple ? ', один фиолетовый' : ''}</div>` : '<div class="rw">Каждая ступень — ещё кристалл в добыче Босса</div>';
            const next = boss.toNext ? (boss.gm ? `Через ${boss.toNext} шаг. — ${esc(boss.stages[boss.stage]?.name)}` : boss.toNext <= 2 ? 'Босс вот-вот наберёт силу' : '') : '';
            tip.innerHTML = `<b>${n.medal ? esc(n.label) : 'Босс этажа'}</b><small>${mood}</small>${rows}${reward}${next ? `<div class="nx"><i class="fas fa-hourglass-half"></i> ${next}</div>` : ''}${boss.gm ? `<div class="gm">Мастеру: шаг ${boss.ticks} · тишина ${boss.calm} · ступень каждые ${boss.every}</div>` : ''}`;
            tip.classList.add('boss');
            tip.style.left = `${p.x}px`;
            tip.style.top = `${p.y - r - 14}px`;
            tip.hidden = false;
            return;
        }
        tip.classList.remove('boss');
        if (this.model?.devourer === n.id) {
            const m = this.model, sat = ['голоден', 'сыт едва', 'сыт', 'насытился', 'обожрался', 'раздут'][Math.min(5, m.satiety)];
            tip.innerHTML = `<b>Пожиратель</b><small>${sat} · ${m.speed === 1 ? 'идёт 1 узел за шаг' : `идёт ${m.speed} узла за шаг`}${game.user.isGM ? ` · Насыщение ${m.satiety}` : ''}</small><small>${n.label}: съеден</small>`;
            tip.style.left = `${p.x}px`; tip.style.top = `${p.y - r - 14}px`; tip.hidden = false;
            return;
        }
        const state = n.eaten ? 'съеден: награды нет, вход — прорыв' : n.touched ? 'тронут Пожирателем' : n.state === 'visited' ? 'пройден' : n.state === 'reachable' ? 'можно за этот шаг' : n.state === 'current' ? 'здесь отряд' : '';
        tip.innerHTML = `<b>${n.label}</b>${state ? `<small>${state}</small>` : ''}`;
        tip.style.left = `${p.x}px`;
        tip.style.top = `${p.y - r - 14}px`;
        tip.hidden = false;
    }

    /** Закрытие — с обратной анимацией: паутина рассасывается, подписи и Туман уезжают влево */
    async close(options = {}) {
        if (this.stage && this.rendered && !this.closing && !options.instant) {
            this.closing = true;
            this.element.classList.add('gd-wo-closing');
            this.element.style.pointerEvents = 'none';
            await this.stage.outro();
        }
        return super.close(options);
    }

    _onClose(options) {
        this.closing = false;
        super._onClose(options);
        document.removeEventListener('keydown', this.escape);
        this.stage?.destroy();
        this.stage = null;
    }

    /** Для проверок: что нарисовано */
    stageInfo() {
        return { medals: this.stage?.medalBox?.length ?? 0, eye: !!this.stage?.bossEye, nodes: this.stage?.nodes.size ?? 0, open: this.model?.edges.filter(e => e.cls === 'open' || e.cls === 'familiar').length ?? 0, edges: this.model?.edges.length ?? 0, tendrils: this.stage?.tendrils.length ?? 0, legs: this.stage?.lastLegs ?? 0, bursts: this.stage?.biteCount ?? 0, familiar: this.stage?.familiar?.length ?? 0, current: this.model?.nodes.filter(n => n.state === 'current').length ?? 0, reachable: this.model?.nodes.filter(n => n.state === 'reachable').length ?? 0 };
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
Hooks.on('updateSetting', setting => { if ([`${MODULE_ID}.devourerSatiety`, `${MODULE_ID}.runFloor`, `${MODULE_ID}.webCalm`, `${MODULE_ID}.webEvery`, `${MODULE_ID}.webStages`, `${MODULE_ID}.webBossReward`].includes(setting.key)) refresh(); });
let timer = null;
for (const hook of ['createItem', 'updateItem', 'deleteItem']) Hooks.on(hook, item => {
    if (!game.user.isGM || !item?.parent?.hasPlayerOwner) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
});
window.addEventListener('resize', foundry.utils.debounce(refresh, 250));
