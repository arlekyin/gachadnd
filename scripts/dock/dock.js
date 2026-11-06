/**
 * Gacha Roguelike dnd5e — Терминал Тумана: вкладка общего слоя слева (вместе с картой-паутиной)
 *
 * Вне боя — Сборка в общем Тумане (labyrinth/fog-layer.js), языком Паутины: латунь, дым, камни. Навыки — пластины
 * с камнем цвета редкости и знаком главного тега; надетые горят, Память тлеет. Щелчок — надеть или снять;
 * наведение — навык в латунной панели подробностей и предпросмотр: какие ступени синергий сдвинутся.
 * На пластине слева вверху — чем используется (как в Baldur's Gate 3: круг — действие, треугольник — бонусное,
 * кольцо со стрелкой — реакция, звезда — особое), справа — заряды ромбами; перегрев — треснувший камень и «заём».
 * Правила Босса: заглушённый тег перечёркнут, спящий навык подёрнут лунной дымкой.
 * В бою — панель над хотбаром: навыки и способности синергий кнопками (щелчок — использовать), пассивные свёрнуты.
 * Вкладки (Терминал, паутина, Хранилище) — кнопки в углу, как у паутины; при смене вкладки Туман остаётся.
 *
 * Логика (данные, экипировка, слияние, заряды, расширения) — от Терминала (memory/terminal/terminal.js),
 * здесь — только вид.
 */

import { MODULE_ID } from "../core/constants.js";
import { tagsLabel } from "../core/ids.js";
import { MemoryTerminal } from "../memory/terminal/terminal.js";
import { isMemorySkill, isInCombat, isAwake, occupiesSlot } from "../memory/synergy/synergy.js";
import { DUO_SOURCE } from "../memory/synergy/duo-links.js";
import { SYNERGIES } from "../memory/synergy/synergy-tiers.js";
import { heatable, heatOf } from "../memory/overheat.js";
import { StashWindow } from "../memory/stash.js";
import { playWeb } from "../labyrinth/web-sound.js";
import { fogLayer } from "../labyrinth/fog-layer.js";
import { mapScene } from "../labyrinth/scene-travel.js";
import { isWeb } from "../labyrinth/web-map.js";
import { ruleOf, hasRule, BOSS_RULES } from "../labyrinth/boss-rules.js";
import { counterInfo } from "../memory/skills/living/badges.js";
import { echoInfo, gmWhisper, voiceWhisper } from "../memory/echo/echo.js";
import { setPeek, peekActor } from "../memory/echo/vision.js";
import { FACET_TAGS, CATEGORIES, STONES, TAG_STONES, TAG_COLORS, SLOTS, facetState, isFacetable, formsOf, placeStone, removeStone } from "../memory/facet/facet.js";
import { t } from "../core/i18n.js";

const ID = 'gachadnd-dock';
const TEMPLATES = 'modules/gachadnd/templates/dock';
const PARTS_LIST = ['banner', 'deck', 'feature', 'side'];

/** Знаки тегов */
export const TAG_ICONS = {
    'разум': 'fa-brain', 'проклятье': 'fa-ghost', 'аномалия': 'fa-atom', 'движение': 'fa-person-running',
    'память': 'fa-scroll', 'щит': 'fa-shield-halved', 'кровь': 'fa-droplet', 'взрыв': 'fa-burst',
    'сталь': 'fa-khanda', 'казнь': 'fa-skull', 'огонь': 'fa-fire', 'яд': 'fa-flask', 'свет': 'fa-sun'
};
const RARITY = {
    gray: [t('серый'), '#a9b1b0'], green: [t('зелёный'), '#5fd16e'], blue: [t('синий'), '#4aa3ff'],
    purple: [t('фиолетовый'), '#b57bff'], red: [t('красный'), '#ff5a54'], orange: [t('оранжевый'), '#ff9a3c']
};
// Чем используется: значок-форма и слово
const KIND = { a: t('действие'), b: t('бонусное действие'), r: t('реакция'), s: t('особое'), p: t('пассивный') };
const PERIOD = { sr: t('до короткого отдыха'), lr: t('до долгого отдыха'), day: t('до рассвета'), turn: t('на ход'), round: t('на раунд'), combat: t('на бой'), encounter: t('на бой') };

/** Чем используется навык: a — действие, b — бонусное, r — реакция, s — особое (по поводу), p — пассивный */
function kindOf(item) {
    const acts = item.system?.activities;
    if (!acts?.size) return 'p';
    if (item.flags[MODULE_ID]?.trigger) return 's';
    const type = (acts.contents?.[0] ?? [...acts.values()][0])?.activation?.type;
    return { action: 'a', bonus: 'b', reaction: 'r' }[type] ?? 's';
}
const usesOf = item => {
    const max = parseInt(item.system?.uses?.max);
    if (!max) return null;
    const value = Math.max(0, max - (item.system.uses.spent || 0));
    return { value, max, pips: Array.from({ length: max }, (_, i) => i < value), period: PERIOD[item.system.uses.recovery?.[0]?.period] ?? '' };
};
/** Название действующей ступени тега */
function tierName(tag, count) {
    const tiers = SYNERGIES.find(s => s.tag === tag)?.tiers ?? [];
    return tiers.filter(t => t.count <= count).at(-1)?.name ?? '';
}
const tierList = tag => (SYNERGIES.find(s => s.tag === tag)?.tiers ?? []).map(t => ({ count: t.count, name: t.name }));
/**
 * Чьи Терминалы листать: игроку — свои персонажи; Мастеру — персонажи игроков (нет их — все персонажи).
 * Сначала — с навыками Памяти
 */
export function terminalActors() {
    const chars = game.actors.filter(a => a.type === 'character');
    const list = game.user.isGM
        ? (chars.some(a => a.hasPlayerOwner) ? chars.filter(a => a.hasPlayerOwner) : chars)
        : chars.filter(a => a.testUserPermission(game.user, 'OWNER'));
    const skilled = a => a.items.some(isMemorySkill);
    return [...list.filter(skilled), ...list.filter(a => !skilled(a))];
}
/**
 * Чей Терминал открыть без явного выбора: выбранный токен (свой персонаж), назначенный персонаж игрока,
 * иначе первый из листаемых — так игрок попадёт в Терминал и с карты, не выбирая токен
 */
export function defaultTerminalActor() {
    const token = canvas?.tokens?.controlled?.[0]?.actor;
    if (token?.type === 'character' && (game.user.isGM || token.isOwner)) return token;
    if (game.user.character) return game.user.character;
    return terminalActors()[0] ?? null;
}

/** Бой этого персонажа с правилом Босса */
const bossRuleFor = actor => ruleOf(game.combats?.find(c => c.started && ruleOf(c) && c.combatants.some(cb => cb.actor?.id === actor.id)));

export class TerminalDock extends MemoryTerminal {
    constructor(actor, options = {}) {
        super(actor, { id: ID, ...options });
        this.filterTag = null;
        // Режим: Сборка (full) или панель над хотбаром в бою (bar); auto — переключилась сама из-за боя
        this.mode = isInCombat(actor) ? 'bar' : 'full';
        // Страница Сборки: навыки (build) или Огранка (facet)
        this.page = 'build';
        this.facetWhere = null;
        this.autoBar = this.mode === 'bar';
    }

    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-dock'],
        window: { frame: false, positioned: false },
        actions: {
            close: function () { return this.close(); },
            // «tab» в v14 занят встроенным переключателем вкладок ApplicationV2
            goto: TerminalDock.#onGoto,
            mode: function () { this.mode = this.mode === 'bar' ? 'full' : 'bar'; this.autoBar = false; return this.render({ force: true }); },
            prevActor: function () { return TerminalDock.#cycle.call(this, -1); },
            nextActor: function () { return TerminalDock.#cycle.call(this, 1); },
            pickActor: function (event, target) { const a = game.actors.get(target.dataset.actorId); if (a && a.id !== this.actor.id) return TerminalDock.open(a, { mode: this.mode, auto: this.autoBar }); },
            echoWhisper: TerminalDock.#onEchoWhisper,
            echoPeek: function () { setPeek(this.actor); },
            useItem: function (event, target) { return this.actor.items.get(target.dataset.itemId)?.use(); },
            page: function (event, target) { this.page = target.dataset.page; return this.render({ parts: ['banner', 'deck', 'feature', 'side'] }); },
            facetPick: function (event, target) { this.facetWhere = target.dataset.where; return this.render({ parts: ['deck', 'side'] }); },
            facetStone: async function (event, target) {
                if (this.facetWhere && await placeStone(this.actor, this.facetWhere, target.dataset.stone)) playWeb('select');
            },
            facetRemove: async function (event, target) {
                event.stopPropagation();
                if (await removeStone(this.actor, target.dataset.where, target.dataset.stone)) playWeb('select');
            },
            filterTag: function (event, target) { this.filterTag = this.filterTag === target.dataset.tag ? null : target.dataset.tag; return this.render({ parts: ['deck', 'side'] }); }
        }
    };

    static PARTS = Object.fromEntries(PARTS_LIST.map(id => [id, { template: `${TEMPLATES}/${id}.hbs` }]));

    /** Классы старого Терминала его стили не должны цеплять */
    _initializeApplicationOptions(options) {
        const result = super._initializeApplicationOptions(options);
        result.classes = result.classes.filter(c => c !== 'gachadnd-terminal');
        return result;
    }

    get title() { return t('Терминал Тумана: {name}', { name: this.actor.name }); }

    /** Открыть Терминал персонажа (другой персонаж — Терминал пересоздаётся) */
    static async open(actor, { mode, auto = false } = {}) {
        const existing = foundry.applications.instances?.get(ID);
        if (existing && existing.actor?.id !== actor.id) await existing.close({ handoff: true });
        const app = existing?.actor?.id === actor.id ? existing : new TerminalDock(actor);
        if (mode) { app.mode = mode; app.autoBar = auto; }
        return app.render({ force: true });
    }

    static toggle(actor) {
        const existing = foundry.applications.instances?.get(ID);
        return existing?.rendered ? existing.close() : TerminalDock.open(actor);
    }

    // ==========================================
    // ДАННЫЕ
    // ==========================================

    async _prepareContext(options) {
        const base = await super._prepareContext(options);
        const actor = this.actor;
        const memory = actor.items.filter(isMemorySkill).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        const equipped = memory.filter(i => i.flags[MODULE_ID].is_active);
        const emitted = equipped.filter(i => isAwake(i) && i.flags[MODULE_ID].tagEmitter && i.flags[MODULE_ID].emitted_tag).map(i => i.flags[MODULE_ID].emitted_tag);
        const tagsOf = item => {
            const tags = new Set(item.flags[MODULE_ID].tags ?? []);
            if (item.flags[MODULE_ID].is_active && !item.flags[MODULE_ID].tagEmitter) emitted.forEach(t => tags.add(t));
            return [...tags];
        };
        // Счёт тегов — по надетым и не спящим (спящий навык тегов не даёт)
        const counts = {};
        for (const item of equipped.filter(isAwake)) for (const t of tagsOf(item)) counts[t] = (counts[t] ?? 0) + 1;

        const rule = bossRuleFor(actor);
        const muffled = hasRule(rule, 'muffle') ? rule.tag : null;
        const rules = [
            ...(muffled ? [{ icon: BOSS_RULES.muffle.icon, text: `${BOSS_RULES.muffle.name} · ${muffled}` }] : []),
            ...(hasRule(rule, 'sleepy') && !rule.woke ? [{ icon: BOSS_RULES.sleepy.icon, text: t('{name} · до ½ ПЗ Босса', { name: BOSS_RULES.sleepy.name }) }] : [])
        ];

        const editor = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
        const describe = async doc => {
            const html = doc.system?.description?.value ?? '';
            const body = html.includes('<hr>') ? html.slice(html.indexOf('<hr>') + 4) : html;
            return editor.enrichHTML(body, { relativeTo: doc, rollData: doc.getRollData?.() });
        };

        const plate = item => {
            const flags = item.flags[MODULE_ID], tags = tagsOf(item), [rarityLabel, color] = RARITY[flags.rarity] ?? RARITY.gray;
            const heat = heatable(item) ? heatOf(item) : null;
            const kind = kindOf(item);
            return {
                id: item.id, name: item.name, color, rarityLabel, tags, tagText: tags.join(','),
                icon: TAG_ICONS[tags[0]] ?? 'fa-gem', equipped: !!flags.is_active, asleep: !!flags.asleep,
                selected: item.id === this.selectedId, dim: !!this.filterTag && !tags.includes(this.filterTag),
                kind, kindLabel: KIND[kind], passive: kind === 'p', uses: usesOf(item),
                hot: !!heat?.borrowed, locked: !!heat?.locked, counter: counterInfo(item),
                usable: !!flags.is_active && !flags.asleep && (item.system?.activities?.size ?? 0) > 0
            };
        };
        const plates = memory.map(plate);
        const slotted = equipped.filter(occupiesSlot).length;
        const free = Math.max(0, base.ring.absoluteCap - slotted);

        // Синергии: тег, ромбы до 6 (зазоры на порогах 2 и 4), действующая ступень
        const tags = Object.keys(counts);
        if (muffled && !tags.includes(muffled)) tags.push(muffled);
        const synergies = tags.sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b, 'ru')).map(tag => {
            const count = counts[tag] ?? 0;
            return {
                tag, count, icon: TAG_ICONS[tag] ?? 'fa-circle', muffled: tag === muffled,
                pips: Array.from({ length: 6 }, (_, i) => ({ on: i < count, gap: i === 2 || i === 4 })),
                tier: tierName(tag, count), tiers: JSON.stringify(tierList(tag))
            };
        });

        // Что даёт каждая синергия: все достигнутые ступени по порядку тегов — способность (предмет) или постоянный
        // эффект без предмета; связки 2 + 2 — в конце. Откуда: «кровь · ступень II» или «кровь + щит»
        const ROMAN = ['I', 'II', 'III'];
        const items = actor.items.filter(i => i.flags?.[MODULE_ID]?.is_synergy_item);
        const tagOrder = synergies.map(s => s.tag);
        const ability = async i => {
            const source = String(i.flags[MODULE_ID].tagSource ?? ''), duo = source.startsWith(DUO_SOURCE);
            const pair = duo ? source.slice(DUO_SOURCE.length).split('+') : [];
            const step = duo ? -1 : tierList(source).findIndex(t => i.name === t.name || i.name.endsWith(`: ${t.name}`));
            return {
                id: i.id, name: i.name, duo, selected: i.id === this.abilityId, order: duo ? 1e3 : tagOrder.indexOf(source) * 10 + step,
                icon: duo ? 'fa-link' : TAG_ICONS[source] ?? 'fa-star', tagIcons: (duo ? pair : [source]).map(t => TAG_ICONS[t] ?? 'fa-circle'),
                source: duo ? pair.join(' + ') : `${source}${step >= 0 ? t(' · ступень {v}', { v: ROMAN[step] }) : ''}`,
                kind: kindOf(i), kindLabel: KIND[kindOf(i)], passive: kindOf(i) === 'p', uses: usesOf(i),
                usable: (i.system?.activities?.size ?? 0) > 0, muffled: !!muffled && (source === muffled || pair.includes(muffled)), desc: await describe(i), sheet: true,
                tags: (duo ? pair : [source]).join(',')
            };
        };
        // Ступени без способности — постоянный эффект: строка с описанием, листа у неё нет
        const passives = synergies.flatMap((s, si) => (SYNERGIES.find(x => x.tag === s.tag)?.tiers ?? []).map((tier, step) => {
            if (tier.feature || tier.count > s.count) return null;
            const label = s.tag.charAt(0).toUpperCase() + s.tag.slice(1), id = `tier-${s.tag}-${step}`;
            return {
                id, name: `${label} ${ROMAN[step]}: ${tier.name}`, duo: false, selected: id === this.abilityId, order: si * 10 + step,
                icon: s.icon, tagIcons: [s.icon], source: `${s.tag}${t(' · ступень {v}', { v: ROMAN[step] })}`,
                kind: 'p', kindLabel: t('постоянно'), passive: true, uses: null, usable: false, muffled: s.muffled, desc: `<p>${foundry.utils.escapeHTML(tier.description)}</p>`, sheet: false, tags: s.tag
            };
        }).filter(Boolean));
        const abilities = [...await Promise.all(items.map(ability)), ...passives].sort((a, b) => a.order - b.order);
        // Наведена или выбрана способность — в панели подробностей она, а не навык
        const shown = abilities.find(a => a.id === this.abilityId) ?? null;
        if (!shown) this.abilityId = null;

        // Подробности выбранного навыка: знак, состояние, строки «чем, заряды, перегрев»
        const sel = memory.find(i => i.id === this.selectedId);
        const selPlate = sel ? plates.find(p => p.id === sel.id) : null;
        const detail = selPlate ? {
            icon: selPlate.icon, kind: selPlate.kind, state: `${selPlate.rarityLabel} · ${selPlate.asleep ? t('спит') : selPlate.equipped ? t('надет') : t('в Памяти')}`,
            meta: [
                selPlate.tags.length ? `<i class="fas ${selPlate.icon}"></i>${tagsLabel(selPlate.tags)}` : '',
                `<span class="gd-ak ${selPlate.kind}"></span>${selPlate.kindLabel}`,
                selPlate.uses ? `<i class="fas fa-gem"></i>${t('заряды {value} из {max}{v}', { value: selPlate.uses.value, max: selPlate.uses.max, v: selPlate.uses.period ? ` · ${selPlate.uses.period}` : '' })}` : '',
                selPlate.hot ? t('<span class="hot"><i class="fas fa-fire"></i>заём — перегрев</span>') : '',
                selPlate.locked ? t('<span class="hot"><i class="fas fa-lock"></i>заблокирован до долгого отдыха</span>') : '',
                selPlate.counter ? `<span class="cnt"><b>${foundry.utils.escapeHTML(selPlate.counter.state)}</b> ${foundry.utils.escapeHTML(selPlate.counter.rule)}</span>` : ''
            ].filter(Boolean)
        } : null;

        // Предел разума: латунное кольцо с гнёздами — естественные и сверх лимита
        const ring = base.ring, R = 24;
        const sockets = Array.from({ length: ring.absoluteCap }, (_, i) => {
            const a = -Math.PI / 2 + i * 2 * Math.PI / ring.absoluteCap;
            return { x: (32 + R * Math.cos(a)).toFixed(2), y: (32 + R * Math.sin(a)).toFixed(2), on: i < slotted, extra: i >= ring.naturalCap, next: i === slotted };
        });

        // Листалка героев: у игрока — свои персонажи, у Мастера — персонажи игроков
        const roster = terminalActors();
        if (!roster.some(a => a.id === actor.id)) roster.unshift(actor);
        // Огранка: грани по тегам и способности класса с гнёздами
        const facet = this.page === 'facet' && this.mode !== 'bar' ? this.#facetView(actor) : null;
        return Object.assign(base, {
            facetPage: !!facet, facet,
            dockActor: { name: actor.name, img: actor.img },
            roster: roster.length > 1 ? roster.map(a => ({ id: a.id, name: a.name, img: a.img, on: a.id === actor.id })) : null,
            bar: this.mode === 'bar',
            isGM: game.user.isGM,
            echo: echoInfo(actor),
            echoPeek: peekActor()?.id === actor.id,
            rules,
            filterTag: this.filterTag,
            tagFilters: Object.entries(memory.reduce((acc, i) => { for (const t of tagsOf(i)) acc[t] = (acc[t] ?? 0) + 1; return acc; }, {}))
                .sort((a, b) => b[1] - a[1]).map(([tag, n]) => ({ tag, n, icon: TAG_ICONS[tag] ?? 'fa-circle', on: this.filterTag === tag, muffled: tag === muffled })),
            equippedPlates: plates.filter(p => p.equipped),
            memoryPlates: plates.filter(p => !p.equipped),
            sockets: Array.from({ length: free }),
            mind: { sockets, filled: slotted, natural: ring.naturalCap, absolute: ring.absoluteCap, over: slotted > ring.naturalCap, extra: ring.absoluteCap > ring.naturalCap },
            synergies, abilities, ability: shown, detail,
            featureMergeable: !!base.cards?.find(c => c.id === base.feature?.id)?.mergeable,
            barSkills: await Promise.all(plates.filter(p => p.equipped && !p.passive).map(async p => ({ ...p, desc: await describe(actor.items.get(p.id)) }))),
            barPassive: plates.filter(p => p.equipped && p.passive),
            topTags: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([tag, n]) => ({ tag, n, icon: TAG_ICONS[tag] ?? 'fa-circle', muffled: tag === muffled }))
        });
    }

    /**
     * Вкладка «Огранка»: оружие и категории способностей класса строками с тремя гнёздами (категория без
     * способностей не показывается), шкатулка — камни тегов со ступенью. Выбранная строка — куда вставит щелчок
     * по камню; камни, которым она не подходит, гаснут
     */
    #facetView(actor) {
        const state = facetState(actor);
        const locked = isInCombat(actor);
        const all = actor.items.filter(isFacetable);
        const weapons = all.filter(i => i.type === 'weapon').sort((a, b) => (b.system.equipped ? 1 : 0) - (a.system.equipped ? 1 : 0));
        const abilities = all.filter(i => i.type !== 'weapon');
        const rows = [
            ...weapons.map(w => ({ where: w.id, kind: 'weapon', name: w.name, sub: /R$/.test(w.system.type?.value ?? '') ? t('дальнобойное') : t('рукопашное'), imgs: [w.img] })),
            ...Object.entries(CATEGORIES).map(([key, cat]) => {
                const members = abilities.filter(i => formsOf(i).includes(key));
                return members.length ? { where: key, kind: key, name: cat.label, sub: members.map(i => i.name).join(', '), imgs: members.slice(0, 3).map(i => i.img) } : null;
            }).filter(Boolean)
        ];
        if (!rows.some(r => r.where === this.facetWhere)) this.facetWhere = rows[0]?.where ?? null;
        const sel = rows.find(r => r.where === this.facetWhere);
        const label = where => rows.find(r => r.where === where)?.name ?? '';
        const look = id => ({ id, name: STONES[id].name, text: STONES[id].text, color: TAG_COLORS[STONES[id].tag], icon: TAG_ICONS[STONES[id].tag] });
        const view = row => {
            const placed = state.placements.filter(p => p.where === row.where);
            const socks = Array.from({ length: SLOTS }, (_, i) => placed[i] ? { ...look(placed[i].id), dark: !placed[i].active, where: row.where, removable: !locked } : {});
            return { ...row, selected: row.where === this.facetWhere, socks };
        };
        const groups = [
            { label: t('Оружие'), rows: rows.filter(r => r.kind === 'weapon').map(view) },
            { label: t('Способности'), rows: rows.filter(r => r.kind !== 'weapon').map(view) }
        ].filter(g => g.rows.length);
        const box = FACET_TAGS.filter(tag => state.grains[tag] > 0 || state.placed[tag] > 0).map(tag => ({
            tag, icon: TAG_ICONS[tag], color: TAG_COLORS[tag],
            pips: Array.from({ length: state.grains[tag] }, (_, i) => i < state.used[tag]),
            stones: TAG_STONES[tag].map(id => {
                const at = state.where[id];
                return { ...look(id), used: at ? label(at.where) : '', locked: !at && state.placed[tag] >= state.grains[tag], fits: !!sel };
            })
        }));
        return { locked, groups, box, empty: !rows.length };
    }

    // ==========================================
    // ОТРИСОВКА
    // ==========================================

    _onFirstRender(context, options) {
        super._onFirstRender(context, options);
        this.escape = event => { if (event.key === 'Escape' && !event.target.closest?.('input, select, textarea') && this.mode === 'full') this.close(); };
        document.addEventListener('keydown', this.escape);
        // Правый щелчок по пластине — лист навыка
        this.element.addEventListener('contextmenu', event => {
            const node = event.target.closest('[data-item-id].gd-plate, [data-item-id].gd-act');
            if (!node) return;
            event.preventDefault();
            this.actor.items.get(node.dataset.itemId)?.sheet?.render(true);
        });
        // Туман уже есть — пришли с другой вкладки (паутина): без появления, только смена содержимого
        const handoff = fogLayer.visible;
        const cls = handoff ? 'gd-swap-in' : 'gd-t-opening';
        this.element.classList.add(cls);
        setTimeout(() => this.element?.classList.remove(cls), handoff ? 450 : 1100);
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this.element.classList.toggle('bar', this.mode === 'bar');
        this.#fit();
        // Туман — только у Сборки; панель боя живёт без него
        if (this.mode === 'full') fogLayer.show({ center: [0.2, 0.42], radius: 0.36, z: parseInt(getComputedStyle(this.element).zIndex) || 50 });
        else fogLayer.hide();
        this.#bindHover();
    }

    /** Сборка — левая часть экрана до боковой панели; панель боя — над хотбаром, по его середине */
    #fit() {
        const el = this.element;
        if (this.mode === 'bar') {
            const hot = document.getElementById('hotbar')?.getBoundingClientRect();
            const mid = hot?.width ? hot.left + hot.width / 2 : window.innerWidth / 2;
            Object.assign(el.style, { left: `${Math.round(mid)}px`, right: 'auto', top: 'auto', bottom: `${Math.round(hot?.height ? window.innerHeight - hot.top + 10 : 80)}px`, width: '' });
            return;
        }
        const right = document.getElementById('ui-right')?.getBoundingClientRect().left;
        Object.assign(el.style, { left: '0px', top: '0px', bottom: '0px', width: '', right: right > window.innerWidth * 0.5 ? `${Math.max(0, window.innerWidth - right)}px` : '0px' });
    }

    /**
     * Наведение на пластину: подробности — в латунную панель (последний навык под мышью остаётся),
     * предпросмотр — у синергий меняются ромбы и ступень, у Предела разума загорается гнездо
     */
    #bindHover() {
        const el = this.element;
        const rows = () => [...el.querySelectorAll('.gd-syn-row[data-tag]')];
        const reset = () => {
            el.querySelectorAll('.gd-syn-row.preview').forEach(r => r.remove());
            for (const row of rows()) {
                row.classList.remove('up', 'down');
                row.querySelectorAll('.gd-pp u').forEach((u, i) => { u.classList.toggle('on', i < Number(row.dataset.count)); u.classList.remove('add', 'lose'); });
                const nx = row.querySelector('.gd-nx b'); if (nx) nx.textContent = row.dataset.tier ?? '';
            }
            el.querySelector('.gd-mind')?.classList.remove('preview', 'preview-off');
            el.querySelector('.gd-syn-head b')?.replaceChildren();
        };
        const preview = node => {
            reset();
            if (node.dataset.asleep) return;
            const on = !node.dataset.equipped, delta = on ? 1 : -1;
            el.querySelector('.gd-mind')?.classList.add(on ? 'preview' : 'preview-off');
            const head = el.querySelector('.gd-syn-head b');
            if (head) head.textContent = `${on ? t('если надеть') : t('если снять')} «${node.dataset.name}»`;
            for (const tag of (node.dataset.tags ?? '').split(',').filter(Boolean)) {
                let row = rows().find(r => r.dataset.tag === tag);
                if (!row && on) {
                    // Новый тег — временная строка внизу
                    row = el.querySelector('.gd-syn-row[data-template]')?.cloneNode(true);
                    if (!row) continue;
                    row.removeAttribute('data-template');
                    row.hidden = false;
                    row.querySelector('i').className = `fas ${TAG_ICONS[tag] ?? 'fa-circle'}`;
                    row.classList.add('preview');
                    Object.assign(row.dataset, { tag, count: '0', tier: '', tiers: '[]' });
                    row.querySelector('.gd-tn').textContent = tag;
                    el.querySelector('.gd-syn-list')?.append(row);
                }
                if (!row) continue;
                const was = Number(row.dataset.count), now = Math.max(0, was + delta);
                row.classList.add(on ? 'up' : 'down');
                row.querySelectorAll('.gd-pp u').forEach((u, i) => {
                    if (on && i === was) u.classList.add('add');
                    if (!on && i === now) u.classList.add('lose');
                });
                const tiers = JSON.parse(row.dataset.tiers || '[]');
                const name = tiers.filter(t => t.count <= now).at(-1)?.name ?? '';
                const nx = row.querySelector('.gd-nx b');
                if (nx) nx.textContent = name;
            }
        };
        const fresh = selector => [...el.querySelectorAll(selector)].filter(node => !node.dataset.bound && (node.dataset.bound = '1'));
        fresh('.gd-plate[data-item-id]').forEach(node => {
            node.addEventListener('pointerenter', () => {
                playWeb('hover', null, { throttle: 70 });
                preview(node);
                if (this.selectedId === node.dataset.itemId && !this.abilityId) return;
                this.selectedId = node.dataset.itemId;
                this.abilityId = null;
                el.querySelectorAll('.gd-ability.sel').forEach(p => p.classList.remove('sel'));
                el.querySelectorAll('.gd-plate.sel').forEach(p => p.classList.remove('sel'));
                node.classList.add('sel');
                clearTimeout(this.featureTimer);
                this.featureTimer = setTimeout(() => this.render({ parts: ['feature'] }), 60);
            });
            node.addEventListener('pointerleave', reset);
        });
        // Способность синергии: наведение или щелчок — она в панели подробностей (применить — кнопкой там)
        const showAbility = node => {
            if (this.abilityId === node.dataset.abilityId) return;
            this.abilityId = node.dataset.abilityId;
            el.querySelectorAll('.gd-plate.sel, .gd-ability.sel').forEach(p => p.classList.remove('sel'));
            node.classList.add('sel');
            clearTimeout(this.featureTimer);
            this.featureTimer = setTimeout(() => this.render({ parts: ['feature'] }), 60);
        };
        // Строка синергии под мышью — её ступени и связки в «Способностях» подсвечены, остальные гаснут
        fresh('.gd-syn-row[data-tag]').forEach(node => {
            const list = () => el.querySelector('.gd-t-abil');
            node.addEventListener('pointerenter', () => {
                const box = list(); if (!box) return;
                let any = false;
                box.querySelectorAll('.gd-ability').forEach(a => { const on = (a.dataset.tags ?? '').split(',').includes(node.dataset.tag); a.classList.toggle('rel', on); any ||= on; });
                box.classList.toggle('focus', any);
            });
            node.addEventListener('pointerleave', () => { const box = list(); box?.classList.remove('focus'); box?.querySelectorAll('.gd-ability.rel').forEach(a => a.classList.remove('rel')); });
        });
        fresh('.gd-ability[data-ability-id]').forEach(node => {
            node.addEventListener('pointerenter', () => { playWeb('hover', null, { throttle: 70 }); showAbility(node); });
            node.addEventListener('click', () => showAbility(node));
        });
        // Панель боя: карточка навыка над кнопкой
        const pop = el.querySelector('.gd-bar-pop');
        fresh('.gd-act[data-pop]').forEach(node => {
            node.addEventListener('pointerenter', () => {
                const tpl = el.querySelector(`template[data-pop-for="${node.dataset.pop}"]`);
                if (!pop || !tpl) return;
                pop.innerHTML = tpl.innerHTML;
                pop.hidden = false;
                const r = node.getBoundingClientRect(), host = el.getBoundingClientRect();
                pop.style.left = `${Math.max(0, r.left - host.left - 20)}px`;
            });
            node.addEventListener('pointerleave', () => { if (pop) pop.hidden = true; });
        });
    }

    /** Закрытие: содержимое уходит, Туман уползает. handoff — переход на другую вкладку, Туман остаётся ей */
    async close(options = {}) {
        if (this.rendered && !this.closing && this.mode === 'full' && !options.instant) {
            this.closing = true;
            this.element.classList.add(options.handoff ? 'gd-swap-out' : 'gd-t-closing');
            this.element.style.pointerEvents = 'none';
            if (!options.handoff) fogLayer.hide();
            await new Promise(r => setTimeout(r, fogLayer.still ? 0 : options.handoff ? 180 : 400));
        }
        if (options.handoff) fogLayer.handoff();
        else if (this.mode === 'full') fogLayer.hide();
        return super.close({ ...options, animate: false });
    }

    _onClose(options) {
        document.removeEventListener('keydown', this.escape);
        clearTimeout(this.featureTimer);
        this.closing = false;
        return super._onClose(options);
    }

    // ==========================================
    // ДЕЙСТВИЯ
    // ==========================================

    static async #onGoto(event, target) {
        const tab = target.dataset.goto;
        if (tab === 'map') {
            // Паутина — вкладка того же слоя; карта рядами — отдельное окно, Туман уходит
            const web = isWeb(mapScene()?.getFlag(MODULE_ID, 'floorMap'));
            await this.close(web ? { handoff: true } : {});
            return game.gachadnd?.openMapTerminal?.();
        }
        if (tab === 'stash') return StashWindow.open(this.actor);
    }

    // Мастер шепчет игроку голосом его эха: своя строка или строка самого голоса
    static async #onEchoWhisper() {
        const actor = this.actor, title = echoInfo(actor)?.title || t('голос');
        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: t('Шепнуть голосом: {name}', { name: actor.name }) },
            content: `<p>${t('Строка придёт игроку как реплика «{v}» — тем же оформлением; он не отличит её от модуля.', { v: foundry.utils.escapeHTML(title) })}</p>
                <textarea name="line" rows="3" style="width:100%" placeholder="${t('Подсказка, соблазн, ложь…')}"></textarea>`,
            buttons: [
                { action: 'own', label: t('Шепнуть'), icon: 'fas fa-comment-dots', default: true, callback: (event, button) => button.form.elements.line.value.trim() },
                { action: 'random', label: t('Строку голоса'), icon: 'fas fa-dice' }
            ],
            rejectClose: false
        });
        if (result === 'random') return voiceWhisper(actor, 'use', { force: true });
        if (result && result !== 'own') return gmWhisper(actor, result);
    }

    // Листалка героев: соседний по кругу
    static #cycle(step) {
        const list = terminalActors();
        if (list.length < 2) return;
        const i = list.findIndex(a => a.id === this.actor.id);
        const next = list[((i < 0 ? 0 : i + step) % list.length + list.length) % list.length];
        if (next.id !== this.actor.id) return TerminalDock.open(next, { mode: this.mode, auto: this.autoBar });
    }
}

// Бой начался — Сборка становится панелью над хотбаром; кончился — снова Сборка, если переключилась сама
const dock = () => foundry.applications.instances?.get(ID);
function syncCombat() {
    const app = dock();
    if (!app?.rendered) return;
    const fighting = isInCombat(app.actor);
    if (fighting && app.mode === 'full') { app.mode = 'bar'; app.autoBar = true; app.render({ force: true }); }
    else if (!fighting && app.mode === 'bar' && app.autoBar) { app.mode = 'full'; app.autoBar = false; app.render({ force: true }); }
    else app.render({ parts: ['banner', 'deck', 'side'] });
}
// Мастер начал или перестал смотреть экран игрока — подпись кнопки
Hooks.on('gachadnd.echoPeek', () => { const app = dock(); if (app?.rendered) app.render({ parts: ['banner'] }); });
for (const hook of ['combatStart', 'createCombatant', 'deleteCombatant', 'deleteCombat', 'updateCombat']) Hooks.on(hook, () => setTimeout(syncCombat, 50));
window.addEventListener('resize', foundry.utils.debounce(() => dock()?.rendered && dock().render(), 250));
