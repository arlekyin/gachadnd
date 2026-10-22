/**
 * Gacha Roguelike dnd5e — Окно «Жильцы Якоря»
 *
 * Сцена под куполом: над ней медленно вращается кольцо рун, внизу светится якорь. По дуге — пять ниш:
 * в нише жильца горит его лампа, пустая ниша — тёмный камень. Те, кто ждёт у границы купола после Босса,
 * стоят в пустых нишах полупрозрачными силуэтами в тумане — отряд впускает одного. Щелчок по жильцу
 * открывает внизу его прилавок. Слева — портреты отряда: чьими руками и чьим золотом платить.
 * Вне Якоря под куполом пусто, но ячейки Ростовщика открываются отовсюду.
 * Каркас рисуется один раз (вращение рун не сбрасывается); содержимое раскладывается в #sync.
 */

import { MODULE_ID } from "../core/constants.js";
import {
    RESIDENTS, LIMITS, residents, residentsState, price, cleansePrice, allTags, pool,
    forgeable, smithUsed, cleansable, heated, baitable, chartMap, chartable, chartTypes, request, settleResident
} from "./residents.js";
import { partyActors } from "./horsemen.js";
import { wealth } from "./economy.js";
import { isCrystalItem } from "../memory/inventory.js";
import { echoInfo } from "../memory/echo/echo.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const ID = 'gachadnd-residents';
const esc = s => foundry.utils.escapeHTML(String(s ?? ''));
const flagsOf = item => item?.flags?.[MODULE_ID] ?? {};
const RARITY_COLOR = { gray: '#9ea3ad', green: '#5fbf6a', blue: '#4f8fe0', purple: '#a46ae8', red: '#e0485c', orange: '#ff8a2a' };
const ORDER = ['smith', 'cartographer', 'broker', 'healer', 'lurer'];
// Ниши по дуге купола: середина выше краёв
const NICHES = [[70, 250], [255, 180], [455, 150], [655, 180], [840, 250]];
const RUNES = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';
const NODE_LABEL = { mob: 'Монстры', elite: 'Элита', event: 'Событие', risk: 'Риск', shop: 'Магазин', rest: 'Привал', doom: 'Погибель', outpost: 'Застава', start: 'Вход', boss: 'Босс' };
const NODE_ICON = { mob: 'fa-ghost', elite: 'fa-dragon', event: 'fa-question', risk: 'fa-exclamation-triangle', shop: 'fa-coins', rest: 'fa-campground', doom: 'fa-horse-head', outpost: 'fa-shield-halved', start: 'fa-dungeon', boss: 'fa-skull' };
const NODE_COLOR = { mob: '#8c8275', elite: '#ff8000', event: '#0070dd', risk: '#a335ee', shop: '#ffaa00', rest: '#1eff00', doom: '#e6dcc3', outpost: '#d4a64a', start: '#7a7062', boss: '#ff003c' };

const inAnchor = () => !!game.settings.get(MODULE_ID, 'anchorOpen');

export class ResidentsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: ID,
        classes: ['gachadnd-residents'],
        tag: 'div',
        window: { title: 'Жильцы Якоря', icon: 'fas fa-people-roof', resizable: false },
        position: { width: 1040, height: 720 },
        actions: {
            focus: ResidentsWindow.#onFocus,
            hand: ResidentsWindow.#onHand,
            admit: ResidentsWindow.#onAdmit,
            settle: ResidentsWindow.#onSettle,
            evict: ResidentsWindow.#onEvict,
            pickSkill: ResidentsWindow.#onPickSkill,
            pickTag: ResidentsWindow.#onPickTag,
            forge: ResidentsWindow.#onForge,
            move: ResidentsWindow.#onMove,
            pickNode: ResidentsWindow.#onPickNode,
            chart: ResidentsWindow.#onChart,
            cellOpen: ResidentsWindow.#onCellOpen,
            cellPut: ResidentsWindow.#onCellPut,
            cellTake: ResidentsWindow.#onCellTake,
            cleanse: ResidentsWindow.#onCleanse,
            cool: ResidentsWindow.#onCool,
            hush: ResidentsWindow.#onHush,
            scar: ResidentsWindow.#onScar,
            bait: ResidentsWindow.#onBait
        }
    };

    static PARTS = { stage: { template: `modules/${MODULE_ID}/templates/residents/stage.hbs` } };

    /** Открыть; focus — чей прилавок показать сразу */
    static open(focus = null) {
        const existing = foundry.applications.instances?.get(ID);
        if (existing) {
            if (focus) existing.focusId = focus;
            existing.sync();
            return existing.render({ force: true }).then(() => existing.bringToFront?.());
        }
        const app = new ResidentsWindow();
        if (focus) app.focusId = focus;
        return app.render({ force: true });
    }

    focusId = null;
    handId = null;
    pick = {};

    async _prepareContext() {
        const runes = [...RUNES, ...RUNES].map((r, i, all) => ({ r, a: (360 / all.length) * i }));
        return { isGM: game.user.isGM, runes, niches: NICHES.map(([x, y], i) => ({ x, y, i })) };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this.#sync();
    }

    sync() { if (this.rendered) this.#sync(); }

    #hand(party) {
        const own = party.filter(a => game.user.isGM || a.isOwner);
        return own.find(a => a.id === this.handId) ?? own.find(a => a.id === game.user.character?.id) ?? own[0] ?? null;
    }

    #sync() {
        const root = this.element?.querySelector('.gd-res-stage');
        if (!root) return;
        const living = new Set(residents().map(r => r.id));
        const state = residentsState();
        const anchor = inAnchor();
        const waiting = anchor && state.offer ? state.offer.ids.filter(id => !living.has(id)) : [];
        const party = partyActors();
        const hand = this.#hand(party);
        this.handId = hand?.id ?? null;
        if (!this.focusId || !living.has(this.focusId)) this.focusId = !anchor && living.has('broker') ? 'broker' : ORDER.find(id => living.has(id)) ?? null;
        root.classList.toggle('away', !anchor);

        // Ниши: жильцы — на своих местах, ждущие у купола — силуэтами в пустых
        root.querySelectorAll('.gd-res-niche').forEach((el, i) => {
            const id = ORDER[i];
            const r = RESIDENTS[id];
            const lives = living.has(id), waits = waiting.includes(id);
            el.className = `gd-res-niche${lives ? ' lit' : ''}${waits ? ' waits' : ''}${id === this.focusId ? ' on' : ''}${lives && !anchor && id !== 'broker' ? ' dim' : ''}`;
            el.style.setProperty('--c', r.color);
            if (lives) Object.assign(el.dataset, { action: 'focus', id });
            else delete el.dataset.action;
            el.dataset.tooltip = lives ? r.line : waits ? `${r.name} ждёт у границы купола` : 'Пустая ниша';
            el.innerHTML = `<div class="gd-res-arch"><div class="gd-res-lamp"></div><i class="fas ${lives || waits ? r.icon : 'fa-circle-notch'}"></i></div>
                <div class="gd-res-plate">${lives || waits ? esc(r.name) : '—'}</div>
                ${waits ? `<button type="button" class="gd-res-admit" data-action="admit" data-id="${id}"><i class="fas fa-door-open"></i> Впустить</button>` : ''}`;
        });
        root.querySelector('.gd-res-gate').innerHTML = waiting.length
            ? `<i class="fas fa-door-open"></i> У границы купола ждут. Отряд впускает одного.`
            : anchor ? '' : '<i class="fas fa-wind"></i> Отряд в Лабиринте: жильцы ждут под куполом. Ячейки Ростовщика — открываются отовсюду.';

        // Отряд
        root.querySelector('.gd-res-party').innerHTML = party.map(actor => {
            const pickable = game.user.isGM || actor.isOwner;
            return `<div class="gd-res-member${actor.id === hand?.id ? ' on' : ''}" ${pickable ? `data-action="hand" data-actor="${actor.id}"` : ''} data-tooltip="${esc(actor.name)}">
                <div class="gd-res-face" style="background-image:url('${esc(actor.img)}')"></div><span>${Math.floor(wealth(actor))} зм</span></div>`;
        }).join('');

        // Мастер: поселить из пула
        const gm = root.querySelector('.gd-res-gm');
        if (gm) {
            const free = pool();
            gm.innerHTML = free.length
                ? `<select name="settle">${free.map(id => `<option value="${id}">${RESIDENTS[id].name}</option>`).join('')}</select><button type="button" data-action="settle"><i class="fas fa-house-user"></i> Поселить</button>`
                : '<span>Все пятеро живут в Якоре</span>';
        }

        root.querySelector('.gd-res-counter').innerHTML = this.#counter(hand, state, anchor);
    }

    // ---------- Прилавок выбранного жильца

    #counter(actor, state, anchor) {
        const id = this.focusId;
        if (!id) return `<div class="gd-res-empty">Под куполом пока никто не живёт.${game.user.isGM ? ' Поселите жильца справа сверху — или отряд впустит его после Босса.' : ' После Босса у купола могут появиться те, кто захочет остаться.'}</div>`;
        const r = RESIDENTS[id];
        const head = `<div class="gd-res-host" style="--c:${r.color}"><div class="gd-res-medal"><i class="fas ${r.icon}"></i></div>
            <div><h3>${r.name}</h3><p>«${esc(r.line)}»</p>${game.user.isGM ? `<a data-action="evict" data-id="${id}">выселить</a>` : ''}</div></div>`;
        if (!actor) return `${head}<div class="gd-res-wares"><div class="gd-res-note">У вас нет персонажа в отряде.</div></div>`;
        if (!anchor && id !== 'broker') return `${head}<div class="gd-res-wares"><div class="gd-res-note">Его услуги — только под куполом Якоря.</div></div>`;
        const body = { smith: () => this.#smith(actor), cartographer: () => this.#chart(actor), broker: () => this.#broker(actor, state, anchor), healer: () => this.#healer(actor), lurer: () => this.#lurer(actor, state) }[id]();
        return `${head}<div class="gd-res-wares">${body}</div>`;
    }

    #smith(actor) {
        const cost = price('smith', actor);
        if (smithUsed(actor)) return `<div class="gd-res-note">${esc(actor.name)}: Кузнец уже перековал навык в этот визит. Вернитесь в следующий раз.</div>`;
        const skills = actor.items.filter(forgeable);
        if (!skills.length) return '<div class="gd-res-note">Перековать нечего: нужен обычный навык Памяти (серый, зелёный, синий), не всадник.</div>';
        const skill = skills.find(i => i.id === this.pick.skill) ?? null;
        const cards = skills.map(i => `<div class="gd-res-card${i.id === skill?.id ? ' on' : ''}" style="--r:${RARITY_COLOR[flagsOf(i).rarity]}" data-action="pickSkill" data-id="${i.id}">
            <b>${esc(i.name)}</b><small>${(flagsOf(i).tags ?? []).map(esc).join(' · ') || 'без тегов'}</small></div>`).join('');
        let work = '<div class="gd-res-note">Выберите навык — и тег, который перековать.</div>';
        if (skill) {
            const tags = flagsOf(skill).tags ?? [];
            const tag = tags.includes(this.pick.tag) ? this.pick.tag : null;
            const chips = tags.map(t => `<span class="gd-res-chip${t === tag ? ' on' : ''}" data-action="pickTag" data-tag="${esc(t)}">${esc(t)}</span>`).join('');
            work = `<div class="gd-res-row">Тег: ${chips}</div>`;
            if (tag) {
                const others = allTags().filter(t => !tags.includes(t));
                const targets = skills.filter(i => i.id !== skill.id && !(flagsOf(i).tags ?? []).includes(tag));
                work += `<div class="gd-res-row"><select name="newTag">${others.map(t => `<option>${esc(t)}</option>`).join('')}</select>
                    <button type="button" data-action="forge"><i class="fas fa-hammer"></i> Сменить — ${cost} зм</button></div>
                    <div class="gd-res-row">${tags.length > 1 && targets.length
                        ? `<select name="target">${targets.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select><button type="button" data-action="move"><i class="fas fa-right-left"></i> Перенести — ${cost} зм</button>`
                        : `<small>${tags.length < 2 ? 'Последний тег не переносится: навык останется без тега.' : 'Перенести некуда: у других навыков этот тег уже есть.'}</small>`}</div>`;
            }
        }
        return `<div class="gd-res-cards">${cards}</div><div class="gd-res-work">${work}</div>`;
    }

    #chart(actor) {
        const map = chartMap();
        if (!map) return '<div class="gd-res-note">Картограф ждёт новую карту: он правит этаж, который Мастер уже начертил, пока отряд на него не вышел.</div>';
        const left = LIMITS.chart - (map.charted ?? 0);
        const cost = price('chart', actor);
        const rows = map.rows.map(row => `<div class="gd-res-maprow">${row.map(ref => {
            const node = map.nodes.find(n => n.id === (ref.id ?? ref)) ?? ref;
            const can = chartable(node) && left > 0;
            return `<span class="gd-res-node${node.id === this.pick.node ? ' on' : ''}${can ? '' : ' fixed'}" style="--n:${NODE_COLOR[node.type]}" ${can ? `data-action="pickNode" data-id="${node.id}"` : ''} data-tooltip="${NODE_LABEL[node.type]}"><i class="fas ${NODE_ICON[node.type]}"></i></span>`;
        }).join('')}</div>`).join('');
        const node = map.nodes.find(n => n.id === this.pick.node);
        const types = node ? chartTypes().filter(t => t !== node.type).map(t => `<button type="button" class="gd-res-type" style="--n:${NODE_COLOR[t]}" data-action="chart" data-type="${t}"><i class="fas ${NODE_ICON[t]}"></i> ${NODE_LABEL[t]}</button>`).join('') : '';
        return `<div class="gd-res-map">${rows}</div><div class="gd-res-work">
            <div class="gd-res-note">${left > 0 ? `Переписать можно ещё ${left} из ${LIMITS.chart} — по ${cost} зм за узел. Вход, Застава и Босс — не трогаются.` : 'На этой карте Картограф уже переписал всё, что мог.'}</div>
            ${node ? `<div class="gd-res-row">«${NODE_LABEL[node.type]}» станет:</div><div class="gd-res-types">${types}</div>` : left > 0 ? '<div class="gd-res-row"><small>Выберите узел на карте.</small></div>' : ''}</div>`;
    }

    #broker(actor, state, anchor) {
        const crystals = actor.items.filter(isCrystalItem);
        const boxes = [];
        for (let i = 0; i < LIMITS.cells; i++) {
            const cell = state.cells[i];
            if (!cell) {
                const next = i === state.cells.length;
                boxes.push(`<div class="gd-res-cell locked"><i class="fas fa-lock"></i>${next && anchor
                    ? `<button type="button" data-action="cellOpen">Открыть — ${price('cell', actor, i + 1)} зм</button>` : '<small>закрыта</small>'}</div>`);
                continue;
            }
            if (cell.data) {
                const rarity = cell.data.flags?.[MODULE_ID]?.rarity;
                boxes.push(`<div class="gd-res-cell full" style="--r:${RARITY_COLOR[rarity] ?? '#ccc'}"><i class="fas fa-gem"></i><b>${esc(cell.data.name)}</b>
                    <small>${esc(game.actors.get(cell.by)?.name ?? '')}</small><button type="button" data-action="cellTake" data-cell="${cell.id}">Забрать</button></div>`);
            } else {
                boxes.push(`<div class="gd-res-cell open"><i class="fas fa-box-open"></i>${anchor && crystals.length
                    ? `<select name="put-${cell.id}">${crystals.map(c => `<option value="${c.id}">${esc(c.name)}${(c.system.quantity ?? 1) > 1 ? ` ×${c.system.quantity}` : ''}</option>`).join('')}</select><button type="button" data-action="cellPut" data-cell="${cell.id}">Положить</button>`
                    : `<small>${anchor ? 'у вас нет кристаллов' : 'пуста'}</small>`}</div>`);
            }
        }
        return `<div class="gd-res-cells">${boxes.join('')}</div><div class="gd-res-note">Кристалл в ячейке не пахнет. Достать — в любой момент этажа, вне боя. Вернувшись в Якорь, Ростовщик кладёт невзятое в Хранилище и закрывает ячейки.</div>`;
    }

    #healer(actor) {
        const scars = actor.items.filter(i => flagsOf(i).scar && cleansable(i));
        const skills = actor.items.filter(i => cleansable(i) && !flagsOf(i).scar);
        const cost = cleansePrice(actor);
        const hot = heated(actor);
        const echo = echoInfo(actor) ?? { value: 0 };
        return `<div class="gd-res-split">
            <div><h4><i class="fas fa-scissors"></i> Очистка — ${cost} зм</h4><small>Половина цены магазина; следующие Очистки не дорожают.</small>
                <div class="gd-res-list">${skills.map(i => `<button type="button" data-action="cleanse" data-id="${i.id}" style="--r:${RARITY_COLOR[flagsOf(i).rarity] ?? '#ccc'}">${esc(i.name)}</button>`).join('') || '<small>очищать нечего</small>'}</div></div>
            <div><h4><i class="fas fa-snowflake"></i> Остудить — ${price('cool', actor)} зм</h4><small>Снимает перегрев и блок со всех навыков персонажа.</small>
                <div class="gd-res-list">${hot.length ? `${hot.map(i => `<span class="gd-res-chip hot">${esc(i.name)}</span>`).join('')}<button type="button" data-action="cool">Остудить</button>` : '<small>перегрева нет</small>'}</div>
                <h4><i class="fas fa-wave-square"></i> Унять эхо — ${price('hush', actor)} зм</h4><small>Эхо в ноль: шёпоты, Видение и наплыв стихают. Голос и прочитанные воспоминания остаются.</small>
                <div class="gd-res-list">${echo.value || echo.full ? `<span class="gd-res-chip echo" style="--echo:${echo.color}"><i class="fas ${echo.icon}"></i> эхо ${echo.value}/${echo.max}${echo.title ? ` · ${esc(echo.title)}` : ''}</span><button type="button" data-action="hush">Унять</button>` : '<small>эхо молчит</small>'}</div>
                ${scars.length ? `<h4><i class="fas fa-heart-crack"></i> Залечить шрам — ${price('scar', actor)} зм</h4><small>Шрам уходит из Памяти, слот свободен.</small>
                <div class="gd-res-list">${scars.map(i => `<button type="button" data-action="scar" data-id="${i.id}">${esc(i.name)}</button>`).join('')}</div>` : ''}</div></div>`;
    }

    #lurer(actor, state) {
        if (state.bait) return `<div class="gd-res-bait" style="--r:${RARITY_COLOR[state.bait.rarity]}"><i class="fas fa-bone"></i><div><b>Приманка спрятана: «${esc(state.bait.name)}»</b><small>Первый прорыв Охоты Пожиратель потратит на неё: съест и уйдёт, Насыщение +1.</small></div></div>`;
        const crystals = actor.items.filter(baitable);
        return `<div class="gd-res-note">Приманка — ваш кристалл весом от 2 и ${price('bait', actor)} зм. Один прорыв Охоты Пожиратель потратит на неё, а не на отряд; сытым он вернётся сильнее.</div>
            <div class="gd-res-list">${crystals.map(c => `<button type="button" data-action="bait" data-id="${c.id}" style="--r:${RARITY_COLOR[flagsOf(c).rarity]}">${esc(c.name)}</button>`).join('') || '<small>подходящих кристаллов нет</small>'}</div>`;
    }

    // ---------- Действия

    static #onFocus(event, target) { this.focusId = target.dataset.id; this.pick = {}; this.#sync(); }
    static #onHand(event, target) { this.handId = target.dataset.actor; this.pick = {}; this.#sync(); }
    static #onAdmit(event, target) { event.stopPropagation(); request({ op: 'choose', id: target.dataset.id }); }
    static #onSettle() { settleResident(this.element.querySelector('[name="settle"]')?.value); }
    static async #onEvict(event, target) {
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: 'Выселить жильца' }, content: `<p>${RESIDENTS[target.dataset.id].name} уйдёт из Якоря.</p>`, rejectClose: false });
        if (ok) request({ op: 'evict', id: target.dataset.id });
    }
    static #onPickSkill(event, target) { this.pick = { skill: target.dataset.id }; this.#sync(); }
    static #onPickTag(event, target) { this.pick.tag = target.dataset.tag; this.#sync(); }
    static #onForge() {
        request({ op: 'forge', mode: 'change', actorId: this.handId, itemId: this.pick.skill, tag: this.pick.tag, newTag: this.element.querySelector('[name="newTag"]')?.value });
        this.pick = {};
    }
    static #onMove() {
        request({ op: 'forge', mode: 'move', actorId: this.handId, itemId: this.pick.skill, tag: this.pick.tag, targetId: this.element.querySelector('[name="target"]')?.value });
        this.pick = {};
    }
    static #onPickNode(event, target) { this.pick = { node: target.dataset.id }; this.#sync(); }
    static #onChart(event, target) { request({ op: 'chart', actorId: this.handId, nodeId: this.pick.node, type: target.dataset.type }); this.pick = {}; }
    static #onCellOpen() { request({ op: 'cellOpen', actorId: this.handId }); }
    static #onCellPut(event, target) {
        const itemId = this.element.querySelector(`[name="put-${target.dataset.cell}"]`)?.value;
        request({ op: 'cellPut', actorId: this.handId, cellId: target.dataset.cell, itemId });
    }
    static #onCellTake(event, target) { request({ op: 'cellTake', actorId: this.handId, cellId: target.dataset.cell }); }
    static async #onCleanse(event, target) {
        const item = game.actors.get(this.handId)?.items.get(target.dataset.id);
        const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: 'Очистка у Знахаря' }, content: `<p>«${esc(item?.name)}» уйдёт из Памяти навсегда.</p>`, rejectClose: false });
        if (ok) request({ op: 'cleanse', actorId: this.handId, itemId: target.dataset.id });
    }
    static #onCool() { request({ op: 'cool', actorId: this.handId }); }
    static #onHush() { request({ op: 'hush', actorId: this.handId }); }
    static #onScar(event, target) { request({ op: 'scar', actorId: this.handId, itemId: target.dataset.id }); }
    static #onBait(event, target) { request({ op: 'bait', actorId: this.handId, itemId: target.dataset.id }); }
}

// Состояние, золото, предметы — окно раскладывает заново
const resync = () => foundry.applications.instances?.get(ID)?.sync?.();
let timer = null;
const later = () => { clearTimeout(timer); timer = setTimeout(resync, 60); };
Hooks.on('gachadnd.residentsChanged', later);
for (const hook of ['updateActor', 'createItem', 'updateItem', 'deleteItem']) Hooks.on(hook, later);
Hooks.on('updateScene', (scene, changes) => { if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) later(); });
Hooks.on('updateSetting', setting => { if (setting.key === `${MODULE_ID}.anchorOpen`) later(); });
