/**
 * Gacha Roguelike dnd5e — Панель модуля слева: Терминал Тумана
 *
 * Вне боя — полная панель на левой части экрана (та же область и тот же Туман, что у паутины, но бирюзовая
 * туманность): сверху экипированное, в центре созвездие сборки (теги — звёзды, ступени — кольца, связки 2+2 —
 * нити со способностью на нити), внизу вся Память. Наведение на карту — описание рядом и предпросмотр: какие
 * ступени и связки она включит. Щелчок — подробно справа, двойной щелчок — надеть или снять.
 * В бою панель сама сворачивается в узкую полосу рядом с инструментами Foundry: навыки с зарядами, связки,
 * ступени тегов; щелчок по навыку — использовать.
 *
 * Логика (данные, экипировка, слияние, заряды, расширения) — от Терминала (memory/terminal/terminal.js),
 * здесь — только вид. Вкладка «Карта» открывает паутину (или окно карты рядами) на том же месте.
 */

import { MODULE_ID } from "../core/constants.js";
import { MemoryTerminal } from "../memory/terminal/terminal.js";
import { isMemorySkill, isInCombat } from "../memory/synergy/synergy.js";
import { duoProgress, DUO_THRESHOLD, DUO_SOURCE } from "../memory/synergy/duo-links.js";
import { heatable, heatOf } from "../memory/overheat.js";
import { StashWindow } from "../memory/stash.js";
import { VERT, FOG, FOG_TERMINAL, quad } from "../labyrinth/web-stage.js";
import { playWeb } from "../labyrinth/web-sound.js";

const ID = 'gachadnd-dock';
const TEMPLATES = 'modules/gachadnd/templates/dock';
const PARTS_LIST = ['backdrop', 'banner', 'deck', 'feature', 'side'];

/** Знаки тегов в созвездии */
export const TAG_ICONS = {
    'разум': 'fa-brain', 'проклятье': 'fa-ghost', 'аномалия': 'fa-atom', 'движение': 'fa-person-running',
    'память': 'fa-scroll', 'щит': 'fa-shield-halved', 'кровь': 'fa-droplet', 'взрыв': 'fa-burst',
    'сталь': 'fa-khanda', 'казнь': 'fa-skull', 'огонь': 'fa-fire', 'яд': 'fa-flask', 'свет': 'fa-sun'
};
const ROMAN = ['', 'I', 'II', 'III'];
const RARITY_LABEL = { gray: 'серый', green: 'зелёный', blue: 'синий', purple: 'фиолетовый', red: 'красный', orange: 'оранжевый' };
const tierOf = count => Math.floor(Math.min(count, 6) / 2);

/** Туман-подложка: тот же шейдер, что у паутины, бирюзовая палитра */
class DockFog {
    constructor(canvas, host) {
        this.app = new PIXI.Application({ view: canvas, backgroundAlpha: 0, antialias: false, autoDensity: true, resolution: Math.min(1.5, window.devicePixelRatio || 1), resizeTo: host });
        this.mesh = new PIXI.Mesh(quad(1, 1), PIXI.Shader.from(VERT, FOG, { uTime: 0, uAspect: 1, uCenter: [0.22, 0.45], uRadius: 0.35, uSlide: 1.5, ...FOG_TERMINAL }));
        this.app.stage.addChild(this.mesh);
        this.time = Math.random() * 100;
        this.still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        this.tick = () => {
            if (!this.still) this.time += this.app.ticker.deltaMS / 1000;
            const { width: W, height: H } = this.app.screen;
            this.mesh.scale.set(W, H);
            Object.assign(this.mesh.shader.uniforms, { uTime: this.time, uAspect: W / H });
        };
        this.app.ticker.add(this.tick);
    }
    pause() { this.app.ticker.stop(); }
    start() { this.app.ticker.start(); }
    destroy() { this.app.ticker.remove(this.tick); this.app.destroy(false, { children: true, texture: true }); }
}

export class TerminalDock extends MemoryTerminal {
    constructor(actor, options = {}) {
        super(actor, { id: ID, ...options });
        this.filterTag = null;
        // Режим: полная панель или полоса; auto — свернулась сама из-за боя
        this.mode = isInCombat(actor) ? 'strip' : 'full';
        this.autoStrip = this.mode === 'strip';
    }

    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-dock'],
        window: { frame: false, positioned: false },
        actions: {
            close: function () { return this.close(); },
            tab: TerminalDock.#onTab,
            mode: function () { this.mode = this.mode === 'strip' ? 'full' : 'strip'; this.autoStrip = false; return this.render({ force: true }); },
            nextActor: TerminalDock.#onNextActor,
            unpin: function () { this.pinned = false; return this.render({ parts: ['feature'] }); },
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

    get title() { return `Терминал Тумана: ${this.actor.name}`; }

    /** Открыть панель для персонажа (другой персонаж — панель пересоздаётся) */
    static async open(actor, { mode } = {}) {
        const existing = foundry.applications.instances?.get(ID);
        if (existing && existing.actor?.id !== actor.id) await existing.close({ instant: true });
        const app = existing?.actor?.id === actor.id ? existing : new TerminalDock(actor);
        if (mode) { app.mode = mode; app.autoStrip = false; }
        return app.render({ force: true });
    }

    static toggle(actor) {
        const existing = foundry.applications.instances?.get(ID);
        return existing?.rendered ? existing.close() : TerminalDock.open(actor);
    }

    /**
     * Раскладка от экрана: ширина содержимого — ~60% области панели; карты — по ширине ряда из 10;
     * созвездие — вся высота между экипированным и Памятью
     */
    #layout(capacity, below = 0) {
        const right = document.getElementById('ui-right')?.getBoundingClientRect().left;
        const area = right > window.innerWidth * 0.5 ? right : window.innerWidth;
        const H = window.innerHeight;
        const content = Math.round(Math.min(820, Math.max(560, area * 0.6)));
        const eqW = Math.min(92, Math.floor((content - 9 * 12) / 10)), eqH = Math.round(eqW * 1.43);
        const memW = Math.min(68, Math.floor((content - 9 * 10) / 10)), memH = Math.round(memW * 1.4);
        const memRows = Math.max(1, Math.ceil(capacity / 10));
        const equipTop = 96;
        const skyTop = equipTop + 22 + eqH + 26;
        const memBlock = 26 + memRows * (memH + 12);
        const memTop = H - 24 - memBlock;
        const skyH = Math.max(240, memTop - skyTop - 34 - below);
        return { content, eqW, eqH, memW, memH, equipTop, skyTop, memTop, skyH, scale: Math.max(1, Math.min(1.6, Math.min(skyH / 330, content / 620))) };
    }

    // ==========================================
    // ДАННЫЕ
    // ==========================================

    async _prepareContext(options) {
        const base = await super._prepareContext(options);
        const actor = this.actor;
        const memory = actor.items.filter(isMemorySkill).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        const equipped = memory.filter(i => i.flags[MODULE_ID].is_active);
        const emitted = equipped.filter(i => i.flags[MODULE_ID].tagEmitter && i.flags[MODULE_ID].emitted_tag).map(i => i.flags[MODULE_ID].emitted_tag);
        const tagsOf = item => {
            const tags = new Set(item.flags[MODULE_ID].tags ?? []);
            if (item.flags[MODULE_ID].is_active && !item.flags[MODULE_ID].tagEmitter) emitted.forEach(t => tags.add(t));
            return [...tags];
        };
        const counts = {};
        for (const item of equipped) for (const t of tagsOf(item)) counts[t] = (counts[t] ?? 0) + 1;
        const links = await duoProgress(counts);
        const synergyItems = actor.items.filter(i => i.flags?.[MODULE_ID]?.is_synergy_item);

        // Описания всех карт — для карточки при наведении
        const editor = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
        const describe = async doc => {
            const html = doc.system?.description?.value ?? '';
            const body = html.includes('<hr>') ? html.slice(html.indexOf('<hr>') + 4) : html;
            return editor.enrichHTML(body, { relativeTo: doc, rollData: doc.getRollData?.() });
        };

        // Предпросмотр: что изменит надетая (или снятая) карта
        const preview = async item => {
            const on = !item.flags[MODULE_ID].is_active;
            const next = { ...counts };
            for (const t of item.flags[MODULE_ID].tags ?? []) next[t] = Math.max(0, (next[t] ?? 0) + (on ? 1 : -1));
            const lines = [];
            for (const t of item.flags[MODULE_ID].tags ?? []) {
                const was = tierOf(counts[t] ?? 0), now = tierOf(next[t] ?? 0);
                if (now > was) lines.push(`<b>${t} ${next[t]}</b> — ступень ${ROMAN[now]}`);
                if (now < was) lines.push(`<b>${t} ${next[t]}</b> — теряется ступень ${ROMAN[was]}`);
            }
            const after = await duoProgress(next);
            const gained = after.filter((l, i) => l.ready && !links[i].ready).map(l => l.name);
            const lost = after.filter((l, i) => !l.ready && links[i].ready).map(l => l.name);
            gained.forEach(n => lines.push(`связка <b>«${n}»</b> начнёт действовать`));
            lost.forEach(n => lines.push(`связка <b>«${n}»</b> перестанет действовать`));
            return { on, text: lines.join(', '), gained, lost };
        };

        const cardView = async item => {
            const flags = item.flags[MODULE_ID];
            const uses = parseInt(item.system?.uses?.max) ? { value: Math.max(0, parseInt(item.system.uses.max) - (item.system.uses.spent || 0)), max: parseInt(item.system.uses.max) } : null;
            const pv = await preview(item);
            return {
                id: item.id, name: item.name, img: item.img, equipped: !!flags.is_active,
                selected: item.id === this.selectedId, rarity: flags.rarity ?? 'gray', rarityLabel: RARITY_LABEL[flags.rarity ?? 'gray'] ?? flags.rarity,
                tags: tagsOf(item), tagText: tagsOf(item).join(','),
                dim: !!this.filterTag && !tagsOf(item).includes(this.filterTag),
                uses, usesText: uses ? `${uses.value}/${uses.max}` : (item.system?.activities?.size ? '∞' : ''),
                spent: !!uses && !uses.value, hot: heatable(item) && heatOf(item).borrowed > 0,
                usable: !!flags.is_active && (item.system?.activities?.size ?? 0) > 0,
                category: flags.category ?? '', desc: await describe(item),
                preview: pv.text, previewOn: pv.on, gains: pv.gained.join('|'), losses: pv.lost.join('|')
            };
        };
        const cards = await Promise.all(memory.map(cardView));
        this.layout = this.#layout(base.capacity, synergyItems.some(i => !String(i.flags[MODULE_ID]?.tagSource ?? '').startsWith(DUO_SOURCE)) ? 70 : 0);
        const slots = base.ring.absoluteCap;
        const equippedCards = cards.filter(c => c.equipped);

        return Object.assign(base, {
            dockActor: { name: actor.name, img: actor.img },
            strip: this.mode === 'strip',
            isGM: game.user.isGM,
            filterTag: this.filterTag,
            pinned: !!this.pinned,
            featureMergeable: !!base.cards?.find(c => c.id === base.feature?.id)?.mergeable,
            equippedCards,
            equippedEmpty: Array.from({ length: Math.max(0, Math.min(10, slots) - equippedCards.length) }),
            memoryCards: cards,
            memoryEmpty: Array.from({ length: Math.max(0, base.capacity - cards.length) }),
            sky: this.#sky(counts, links, synergyItems),
            abilities: await Promise.all(synergyItems.filter(i => !String(i.flags[MODULE_ID]?.tagSource ?? '').startsWith(DUO_SOURCE)).map(async i => ({
                id: i.id, name: i.name, img: i.img, usable: (i.system?.activities?.size ?? 0) > 0, desc: await describe(i),
                usesText: parseInt(i.system?.uses?.max) ? `${Math.max(0, parseInt(i.system.uses.max) - (i.system.uses.spent || 0))}/${parseInt(i.system.uses.max)}` : ''
            }))),
            tiers: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag, count]) => ({ tag, short: tag.slice(0, 3), icon: TAG_ICONS[tag] ?? 'fa-circle', count, tier: tierOf(count), pips: [0, 1, 2].map(i => i < tierOf(count)) }))
        });
    }

    /**
     * Созвездие: звёзды тегов по овалу (связанные связкой — рядом), нити связок 2+2 со способностью на нити.
     * Координаты — в поле 600×330.
     */
    #sky(counts, links, synergyItems) {
        const { content: W, skyH: H, scale: k } = this.layout;
        const cx = W / 2, cy = H / 2, rx = W / 2 - 64 * k, ry = H / 2 - 52 * k;
        const shown = links.filter(l => l.have.some(n => n > 0) || l.ready);
        const tags = new Set(Object.keys(counts));
        shown.forEach(l => l.duo.forEach(t => tags.add(t)));
        // Порядок по овалу: цепочкой по связкам, затем остальные по счёту
        const order = [];
        const rest = [...tags].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
        while (rest.length) {
            let t = rest.shift();
            order.push(t);
            for (let partner; (partner = shown.find(l => l.duo.includes(t) && rest.includes(l.duo.find(x => x !== t)))); ) {
                t = partner.duo.find(x => x !== t);
                rest.splice(rest.indexOf(t), 1);
                order.push(t);
            }
        }
        const n = Math.max(1, order.length);
        const pos = {};
        order.forEach((t, i) => {
            const a = -Math.PI * 0.82 + (i / n) * Math.PI * 2;
            pos[t] = { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
        });
        const stars = order.map(tag => {
            const count = counts[tag] ?? 0, tier = tierOf(count), size = Math.round((30 + Math.min(count, 6) * 4) * k);
            return {
                tag, icon: TAG_ICONS[tag] ?? "fa-circle", count, tier, size, x: pos[tag].x, y: pos[tag].y, top: pos[tag].y - size / 2,
                cls: [count ? 'lit' : 'dim', this.filterTag === tag && 'filter'].filter(Boolean).join(' '),
                note: count ? `${count}${tier ? ` · ступень ${ROMAN[tier]}` : ''}${tier < 3 ? ` · до ${ROMAN[tier + 1]} ещё ${(tier + 1) * 2 - count}` : ''}` : '0',
                rings: [1, 2, 3].map(i => ({ r: size / 2 + (4 + i * 6) * k, on: tier >= i, next: tier + 1 === i }))
            };
        });
        const threads = shown.map(l => {
            const [a, b] = l.duo.map(t => pos[t]);
            // Узел нити — к центру созвездия; контрольная точка кривой — так, чтобы нить проходила через узел
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const kx = mx + (cx - mx) * 0.32, ky = my + (cy - my) * 0.32;
            const missing = l.duo.reduce((s, t, i) => s + Math.max(0, DUO_THRESHOLD - l.have[i]), 0);
            const state = l.ready ? 'ready' : missing <= 1 ? 'near' : 'far';
            const item = l.ready ? synergyItems.find(i => i.name === l.name) : null;
            return {
                name: l.name, img: l.img, state, tags: l.duo.join(','), duo: l.duo,
                path: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${(2 * kx - mx).toFixed(1)} ${(2 * ky - my).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
                x: kx, y: ky, itemId: item?.id ?? '', usable: !!item && (item.system?.activities?.size ?? 0) > 0,
                note: l.ready ? 'действует' : `не хватает: ${l.duo.map((t, i) => (l.have[i] < DUO_THRESHOLD ? `${DUO_THRESHOLD - l.have[i]} ${t}` : '')).filter(Boolean).join(', ')}`
            };
        });
        return { width: W, height: H, stars, threads, scale: k };
    }

    // ==========================================
    // ОТРИСОВКА
    // ==========================================

    _onFirstRender(context, options) {
        super._onFirstRender(context, options);
        this.escape = event => { if (event.key === 'Escape' && !event.target.closest?.('input, select, textarea') && this.mode === 'full') this.close(); };
        document.addEventListener('keydown', this.escape);
        // Щелчок по карте закрепляет подробности справа (сам выбор — действие Терминала)
        this.element.addEventListener('click', event => { if (event.target.closest('.gd-dcard[data-item-id]')) this.pinned = true; }, true);
        this.element.classList.add('gd-dock-opening');
        setTimeout(() => this.element?.classList.remove('gd-dock-opening'), 900);
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this.element.classList.toggle('strip', this.mode === 'strip');
        const L = this.layout;
        if (L) for (const [key, value] of Object.entries({ content: L.content, 'eq-w': L.eqW, 'eq-h': L.eqH, 'mem-w': L.memW, 'mem-h': L.memH, 'equip-top': L.equipTop, 'sky-top': L.skyTop, 'mem-top': L.memTop, 'sky-h': L.skyH })) this.element.style.setProperty(`--dock-${key}`, `${value}px`);
        if (L) this.element.style.setProperty('--dock-k', L.scale);
        this.#fit();
        if (this.mode === 'full') {
            const canvas = this.element.querySelector('canvas.gd-dock-fog');
            if (canvas && !this.fog) this.fog = new DockFog(canvas, this.element);
            else if (canvas && this.fog && this.fog.app.view !== canvas) canvas.replaceWith(this.fog.app.view);
        } else if (this.fog) { this.fog.destroy(); this.fog = null; }
        this.#bindHover();
    }

    /** Полная панель — до боковой панели справа; полоса — сразу за инструментами Foundry */
    #fit() {
        const el = this.element;
        if (this.mode === 'strip') {
            const controls = document.getElementById('scene-controls') ?? document.getElementById('controls');
            const left = controls ? Math.round(controls.getBoundingClientRect().right + 6) : 70;
            Object.assign(el.style, { left: `${left}px`, right: 'auto', width: '78px' });
            return;
        }
        const right = document.getElementById('ui-right')?.getBoundingClientRect().left;
        Object.assign(el.style, { left: '0px', width: '', right: right > window.innerWidth * 0.5 ? `${Math.max(0, window.innerWidth - right)}px` : '0px' });
    }

    /** Наведение: карточка рядом с картой; связи подсвечиваются (тег ↔ карты ↔ связки) */
    #bindHover() {
        const el = this.element;
        const pop = el.querySelector('.gd-dock-pop');
        if (!pop) return;
        const show = (target, html) => {
            pop.innerHTML = html;
            pop.hidden = false;
            const r = target.getBoundingClientRect(), host = el.getBoundingClientRect();
            const w = pop.offsetWidth, h = pop.offsetHeight;
            let x = r.right - host.left + 12, y = r.top - host.top - 8;
            if (this.mode === 'full' && x + w > host.width - 8) x = r.left - host.left - w - 12;
            y = Math.max(8, Math.min(y, window.innerHeight - host.top - h - 8));
            Object.assign(pop.style, { left: `${x}px`, top: `${y}px` });
        };
        const hide = () => { pop.hidden = true; el.querySelectorAll('.preview, .soon, .lose, .hl').forEach(n => n.classList.remove('preview', 'soon', 'lose', 'hl')); };
        const fresh = selector => [...el.querySelectorAll(selector)].filter(node => !node.dataset.bound && (node.dataset.bound = '1'));
        fresh('[data-pop]').forEach(node => {
            node.addEventListener('pointerenter', () => {
                const tpl = el.querySelector(`template[data-pop-for="${node.dataset.pop}"]`);
                if (!tpl) return;
                show(node, tpl.innerHTML);
                playWeb('hover', null, { throttle: 70 });
                // Предпросмотр карты: её теги и связки, которые она включит или выключит
                const tags = (node.dataset.tags ?? '').split(',').filter(Boolean);
                tags.forEach(t => el.querySelectorAll(`.gd-star[data-tag="${t}"]`).forEach(s => s.classList.add('preview')));
                (node.dataset.gains ?? '').split('|').filter(Boolean).forEach(n => el.querySelectorAll(`.gd-thread[data-name="${CSS.escape(n)}"], .gd-knot[data-name="${CSS.escape(n)}"]`).forEach(s => s.classList.add('soon')));
                (node.dataset.losses ?? '').split('|').filter(Boolean).forEach(n => el.querySelectorAll(`.gd-thread[data-name="${CSS.escape(n)}"], .gd-knot[data-name="${CSS.escape(n)}"]`).forEach(s => s.classList.add('lose')));
            });
            node.addEventListener('pointerleave', hide);
        });
        // Звезда: подсвечены карты с этим тегом и связки, которым он нужен
        fresh('.gd-star[data-tag]').forEach(star => {
            star.addEventListener('pointerenter', () => {
                const t = star.dataset.tag;
                el.querySelectorAll('.gd-dcard[data-tags]').forEach(c => { if (c.dataset.tags.split(',').includes(t)) c.classList.add('hl'); });
                el.querySelectorAll('.gd-thread, .gd-knot').forEach(k => { if ((k.dataset.tags ?? '').split(',').includes(t)) k.classList.add('hl'); });
            });
            star.addEventListener('pointerleave', hide);
        });
        // Щелчок по навыку в полосе — использовать; по связке — её способность
        [...el.querySelectorAll('[data-use]')].filter(node => !node.dataset.useBound && (node.dataset.useBound = '1')).forEach(node => node.addEventListener('click', event => {
            event.stopPropagation();
            this.actor.items.get(node.dataset.use)?.use();
        }));
    }

    _onClose(options) {
        document.removeEventListener('keydown', this.escape);
        this.fog?.destroy();
        this.fog = null;
        return super._onClose(options);
    }

    // ==========================================
    // ДЕЙСТВИЯ
    // ==========================================

    static async #onTab(event, target) {
        const tab = target.dataset.tab;
        if (tab === 'map') {
            await this.close({ instant: true });
            return game.gachadnd?.openMapTerminal?.();
        }
        if (tab === 'stash') return StashWindow.open(this.actor);
    }

    // Мастер листает персонажей отряда
    static async #onNextActor() {
        const party = game.actors.filter(a => a.type === 'character' && (a.hasPlayerOwner || game.user.isGM) && a.items.some(isMemorySkill));
        if (!party.length) return;
        const i = party.findIndex(a => a.id === this.actor.id);
        const next = party[(i + 1) % party.length];
        if (next.id !== this.actor.id) return TerminalDock.open(next, { mode: this.mode });
    }
}

// Бой начался — панель сворачивается в полосу; кончился — разворачивается обратно, если свернулась сама
const dock = () => foundry.applications.instances?.get(ID);
function syncCombat() {
    const app = dock();
    if (!app?.rendered) return;
    const fighting = isInCombat(app.actor);
    if (fighting && app.mode === 'full') { app.mode = 'strip'; app.autoStrip = true; app.render({ force: true }); }
    else if (!fighting && app.mode === 'strip' && app.autoStrip) { app.mode = 'full'; app.autoStrip = false; app.render({ force: true }); }
}
for (const hook of ['combatStart', 'createCombatant', 'deleteCombatant', 'deleteCombat', 'updateCombat']) Hooks.on(hook, () => setTimeout(syncCombat, 50));
window.addEventListener('resize', foundry.utils.debounce(() => dock()?.rendered && dock().render(), 250));
