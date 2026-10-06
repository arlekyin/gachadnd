/**
 * Gacha Roguelike dnd5e — Терминал Тумана
 *
 * Вкладка «Память» — сетка кристаллов и панель выбранного навыка (по образцу Арканы Hades II).
 * Вкладка «Слоты» — компактный список экипированного для быстрого доступа в бою.
 */

import { MODULE_ID } from "./main.js";
import { updateActorSynergies, isMemorySkill, getSlotBonus, setSkillEquipped, isInCombat } from "./synergy.js";
import { canRankUp, forgeSkill, findDuplicateCrystal, FORGE_COST, getMemoryCapacity, romanRank } from "./inventory.js";
import { isPartyAtRest } from "./map.js";
import { collectGlossary } from "./glossary.js";
import { playTerminalSound } from "./sounds.js";
import { NeuralBackground } from "./neural.js";

const { ApplicationV2 } = foundry.applications.api;

const RARITY = {
    gray: { label: 'Серый', color: '#9d9d9d' },
    green: { label: 'Зелёный', color: '#1eff00' },
    blue: { label: 'Синий', color: '#0070dd' },
    purple: { label: 'Фиолетовый', color: '#a335ee' },
    red: { label: 'Красный', color: '#ff003c' },
    orange: { label: 'Оранжевый', color: '#ff8000' }
};

const PERIOD_SHORT = { sr: 'КО', lr: 'ДО', day: 'день', turn: 'ход', turnStart: 'раунд', initiative: 'бой', gachaRun: 'забег', gachaScene: 'сцена', gachaFloor: 'этаж' };
const RANK_LABELS = ['I', 'II', 'III'];

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Описание с обработкой обогатителей dnd5e по данным персонажа
async function enrichDescription(html, document) {
    if (!html) return '';
    const editor = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
    return editor.enrichHTML(html, { relativeTo: document, rollData: document.getRollData?.(), secrets: document.isOwner });
}

// Шапка описания навыка (категория, редкость, перезарядка) выводится плашками — в тексте только суть
function descriptionBody(html = '') {
    return html.includes('<hr>') ? html.slice(html.indexOf('<hr>') + 4) : html;
}

// Характеристики навыка из его активности dnd5e — строки под описанием
function statsRows(item) {
    const rows = [];
    const activity = item.system?.activities?.contents?.[0];
    if (!activity) {
        rows.push(['Тип', 'Пассивный — действует, пока навык экипирован']);
    } else {
        const labels = activity.labels ?? {};
        const activation = labels.activation || CONFIG.DND5E.activityActivationTypes?.[activity.activation?.type]?.label;
        if (activation) rows.push(['Активация', activation]);
        if (labels.range || activity.range?.value) rows.push(['Дальность', labels.range || `${activity.range.value} фт`]);
        const template = activity.target?.template;
        if (template?.type) rows.push(['Область', `${CONFIG.DND5E.areaTargetTypes?.[template.type]?.label ?? template.type}, ${template.size} фт`]);
        const ability = activity.save?.ability?.first?.() ?? [...(activity.save?.ability ?? [])][0];
        if (ability) rows.push(['Спасбросок', labels.save || CONFIG.DND5E.abilities?.[ability]?.label || ability]);
    }
    const uses = usesInfo(item);
    if (uses) {
        // Заряды редактируются прямо в строке характеристик
        const period = item.system.uses.recovery?.[0]?.period;
        const periodLabel = period ? (CONFIG.DND5E.limitedUsePeriods?.[period]?.label ?? uses.period) : '';
        rows.push(['Заряды', `<input type="text" class="gd-uses-input" data-item-id="${item.id}" data-max="${uses.max}" value="${uses.value}"> / ${uses.max}${periodLabel ? ` · ${esc(periodLabel)}` : ''}`, true]);
    }
    return rows;
}

function hasActivities(item) {
    return (item.system?.activities?.size ?? 0) > 0;
}

function usesInfo(item) {
    const max = parseInt(item.system?.uses?.max);
    if (!max) return null;
    const period = item.system.uses.recovery?.[0]?.period;
    return {
        value: Math.max(0, max - (item.system.uses.spent || 0)),
        max,
        period: PERIOD_SHORT[period] ?? CONFIG.DND5E.limitedUsePeriods[period]?.abbreviation ?? ''
    };
}

function usesHtml(item, { editable = true } = {}) {
    const uses = usesInfo(item);
    if (!uses) return '';
    const value = editable
        ? `<input type="text" class="gd-uses-input" data-item-id="${item.id}" data-max="${uses.max}" value="${uses.value}">`
        : `<span class="gd-uses-value">${uses.value}</span>`;
    return `<span class="gd-uses">${value}<span class="gd-uses-max">/ ${uses.max}</span>${uses.period ? `<span class="gd-uses-period">${uses.period}</span>` : ''}</span>`;
}

export class MemoryTerminal extends ApplicationV2 {
    constructor(actor, options = {}) {
        super({ id: `gachadnd-terminal-${actor.id}`, ...options });
        this.actor = actor;
        this.selectedId = null;
        this.expanded = new Set();
    }

    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-terminal'],
        tag: 'div',
        window: { icon: 'fas fa-brain', resizable: true },
        position: { width: 1180, height: 800 },
        actions: {
            select: MemoryTerminal.#onSelect,
            toggleEquip: MemoryTerminal.#onToggleEquip,
            forge: MemoryTerminal.#onForge,
            use: MemoryTerminal.#onUse,
            expand: MemoryTerminal.#onExpand,
            openSheet: MemoryTerminal.#onOpenSheet
        }
    };

    get title() {
        return `Терминал Тумана: ${this.actor.name}`;
    }

    // Изменения документов приходят пачками (экипировка, пересчёт синергий) — перерисовка одна
    #debouncedRender = foundry.utils.debounce(() => this.render(), 50);

    _onClose(options) {
        this.neural?.stop();
        this.neural = null;
        return super._onClose?.(options);
    }
    requestRender() {
        this.#debouncedRender();
    }

    // ==========================================
    // ДАННЫЕ
    // ==========================================

    async _prepareContext() {
        const actor = this.actor;
        const level = actor.system.details?.level || 1;
        const naturalCap = 6 + Math.floor(level / 2);

        const memory = actor.items.filter(isMemorySkill)
            .sort((a, b) => (b.flags[MODULE_ID].is_active ? 1 : 0) - (a.flags[MODULE_ID].is_active ? 1 : 0) || a.name.localeCompare(b.name));
        const equipped = memory.filter(i => i.flags[MODULE_ID].is_active);
        const absoluteCap = naturalCap + getSlotBonus(equipped);

        const emittedTags = equipped
            .filter(i => i.flags[MODULE_ID].tagEmitter && i.flags[MODULE_ID].emitted_tag)
            .map(i => i.flags[MODULE_ID].emitted_tag);

        if (!memory.some(i => i.id === this.selectedId)) this.selectedId = memory[0]?.id ?? null;
        const selected = memory.find(i => i.id === this.selectedId) ?? null;

        const atRest = isPartyAtRest();
        const hitDice = actor.system.attributes?.hd?.value ?? 0;

        const synergyItems = actor.items.filter(i => i.flags?.[MODULE_ID]?.is_synergy_item);
        const synergyEffects = actor.effects.filter(e => e.flags?.[MODULE_ID]?.is_synergy || e.flags?.[MODULE_ID]?.is_system_effect || e.flags?.[MODULE_ID]?.memory_scaling_source);

        const descriptions = new Map();
        for (const doc of [selected, ...equipped, ...synergyItems].filter(Boolean)) {
            if (!descriptions.has(doc.id)) descriptions.set(doc.id, await enrichDescription(doc.system?.description?.value, doc));
        }
        for (const effect of synergyEffects) descriptions.set(effect.id, await enrichDescription(effect.description, actor));

        // Число экипированных навыков с каждым тегом — для пояснений синергий
        const tagCounts = {};
        for (const item of equipped) {
            const tags = new Set(item.flags[MODULE_ID].tags ?? []);
            if (!item.flags[MODULE_ID].tagEmitter) emittedTags.forEach(t => tags.add(t));
            tags.forEach(t => { tagCounts[t] = (tagCounts[t] ?? 0) + 1; });
        }
        const glossary = selected
            ? collectGlossary(selected.system?.description?.value, selected.flags[MODULE_ID].tags ?? [], tagCounts)
            : [];

        return {
            tagCounts, glossary,
            naturalCap, absoluteCap, memory, equipped, emittedTags, selected,
            atRest, hitDice, synergyItems, synergyEffects, descriptions,
            overloaded: equipped.length > naturalCap
        };
    }

    // ==========================================
    // ОТРИСОВКА
    // ==========================================

    async _renderHTML(context) {
        return `
            ${context.atRest ? this.#restBannerHtml(context) : ''}
            ${this.#altarHtml(context)}`;
    }

    #restBannerHtml({ hitDice }) {
        return `<div class="gd-rest-banner"><i class="fas fa-campground"></i> Привал · Кости Хитов: <strong>${hitDice}</strong> · слияние повторных кристаллов доступно</div>`;
    }

    // ==========================================
    // ПАМЯТЬ: СЕТКА · КАРТА · СПРАВОЧНИК
    // ==========================================

    #altarHtml(context) {
        if (!context.memory.length) {
            return `<div class="gd-altar empty"><div class="gd-empty">Память пуста.<br>Кристаллы выпадают после боёв и продаются в Магазине — поглотите кристалл из инвентаря, чтобы навык появился здесь.</div></div>`;
        }
        return `
            <div class="gd-altar">
                <canvas class="gd-neural" data-active="${context.equipped.length}"></canvas>
                <div class="gd-deck-wrap">
                    <div class="gd-deck-title">Память <span>${context.memory.length} / ${getMemoryCapacity(this.actor)}</span></div>
                    <div class="gd-deck">${this.#deckHtml(context)}</div>
                </div>
                <div class="gd-feature"><div class="gd-feature-inner">${this.#featureHtml(context)}</div></div>
                <aside class="gd-side">
                    ${this.#ringHtml(context)}
                    ${this.#buildHtml(context)}
                    ${this.#synergiesHtml(context)}
                    <div class="gd-glossary">${context.glossary.map(g => `
                        <div class="gd-term ${g.accent ? 'accent' : ''}">
                            <div class="gd-term-title">${esc(g.title)}</div>
                            <div class="gd-term-text">${g.text}</div>
                        </div>`).join('')}
                    </div>
                </aside>
            </div>`;
    }

    #deckHtml(context) {
        // Свободные ячейки Памяти — пустыми картами, как закрытые карты Арканы
        const empty = Math.max(0, getMemoryCapacity(this.actor) - context.memory.length);
        const emptyHtml = Array.from({ length: empty }, () =>
            '<div class="gd-tcard empty" title="Свободная ячейка Памяти"><i class="fas fa-plus"></i></div>').join('');
        return context.memory.map(item => {
            const flags = item.flags[MODULE_ID];
            const rarity = RARITY[flags.rarity] ?? RARITY.gray;
            const ranked = (flags.max_rank ?? 1) > 1 || !!flags.stacking;
            const mergeable = context.atRest && canRankUp(item) && findDuplicateCrystal(this.actor, item);
            const classes = ['gd-tcard'];
            if (flags.is_active) classes.push('equipped');
            if (item.id === context.selected?.id) classes.push('selected');
            return `
                <div class="${classes.join(' ')}" style="--rarity: ${rarity.color}" data-action="select" data-item-id="${item.id}" title="${esc(item.name)}">
                    <div class="gd-tcard-art" style="background-image: url('${item.img}')"></div>
                    ${ranked ? `<span class="gd-tcard-badge">${flags.rank ?? 1}</span>` : ''}
                    ${mergeable ? '<span class="gd-tcard-merge" title="Можно слить"><i class="fas fa-hammer"></i></span>' : ''}
                    <div class="gd-tcard-name">${esc(item.name)}</div>
                </div>`;
        }).join('') + emptyHtml;
    }

    #featureHtml({ selected, emittedTags, atRest, hitDice, descriptions }) {
        if (!selected) return '';
        const flags = selected.flags[MODULE_ID];
        const rarity = RARITY[flags.rarity] ?? RARITY.gray;
        const ranked = (flags.max_rank ?? 1) > 1 || !!flags.stacking;
        const tags = [...(flags.tags ?? [])];
        if (flags.is_active && !flags.tagEmitter) emittedTags.forEach(t => { if (!tags.includes(t)) tags.push(t); });

        const body = descriptionBody(descriptions.get(selected.id));

        let forgeButton = '';
        if (atRest && canRankUp(selected)) {
            const cost = FORGE_COST[(flags.rank ?? 1) + 1] ?? 2;
            const crystal = findDuplicateCrystal(this.actor, selected);
            const reason = !crystal ? 'Нужен повторный кристалл в инвентаре' : hitDice < cost ? `Не хватает Костей Хитов (${hitDice})` : '';
            forgeButton = `<button type="button" class="gd-btn forge" data-action="forge" data-item-id="${selected.id}" ${reason ? 'disabled' : ''} title="${reason || 'Слить повторный кристалл: ранг +1'}"><i class="fas fa-hammer"></i> Слить · −${cost} КХ</button>`;
        }
        const useButton = flags.is_active && hasActivities(selected)
            ? `<button type="button" class="gd-btn" data-action="use" data-item-id="${selected.id}"><i class="fas fa-dice-d20"></i> Использовать</button>` : '';

        return `
            <div class="gd-bigcard ${flags.is_active ? 'equipped' : ''}" style="--rarity: ${rarity.color}" data-action="openSheet" data-item-id="${selected.id}" title="Открыть лист навыка">
                <div class="gd-bigcard-art" style="background-image: url('${selected.img}')"></div>
                ${flags.is_active ? '<span class="gd-neon" aria-hidden="true"></span>' : ''}
                ${ranked ? `<div class="gd-bigcard-plate">${romanRank(flags.rank ?? 1)}</div>` : ''}
            </div>
            <h2 class="gd-feature-name">${esc(selected.name)}</h2>
            <div class="gd-chips">
                <span class="gd-chip" style="--chip: ${rarity.color}">${rarity.label}</span>
                <span class="gd-chip">${esc(flags.category ?? '')}</span>
                ${tags.map(t => `<span class="gd-chip tag">${esc(t)}</span>`).join('')}
                ${ranked ? `<span class="gd-chip">Ранг ${romanRank(flags.rank ?? 1)}${canRankUp(selected) ? ' · можно улучшить' : ''}</span>` : ''}
                ${['purple', 'red'].includes(flags.rarity) ? '<span class="gd-chip unique">Уникальный</span>' : ''}
            </div>
            ${flags.drawback ? `<div class="gd-feature-drawback"><strong>Штраф:</strong> ${esc(flags.drawback)}</div>` : ''}
            <div class="gd-feature-text">${body || '<p>Описание отсутствует.</p>'}</div>
            ${game.user?.isGM && ranked && (flags.rank ?? 1) < flags.max_rank ? `
                <div class="gd-gm-ranks"><div class="gd-gm-ranks-title"><i class="fas fa-eye-slash"></i> Скрытые ранги — видит только Мастер</div>
                ${(flags.rank_texts ?? []).slice((flags.rank ?? 1) - 1).map((t, i) => `<div><strong>Ранг ${RANK_LABELS[(flags.rank ?? 1) + i]}:</strong> ${esc(t)}</div>`).join('')}
                </div>` : ''}
            <dl class="gd-stats">${statsRows(selected).map(([k, v, raw]) => `<dt>${k}</dt><dd>${raw ? v : esc(v)}</dd>`).join('')}</dl>
            <div class="gd-details-actions">
                <button type="button" class="gd-btn ${flags.is_active ? 'unequip' : 'equip'}" data-action="toggleEquip" data-item-id="${selected.id}">
                    ${flags.is_active ? '<i class="fas fa-power-off"></i> Снять' : '<i class="fas fa-bolt"></i> Экипировать'}
                </button>
                ${useButton}
                ${forgeButton}
            </div>`;
    }

    // Активные синергии: способности (с кнопкой броска) и эффекты; клик раскрывает описание
    #synergiesHtml({ synergyItems, synergyEffects, descriptions }) {
        const docs = [
            ...synergyItems.map(doc => ({ doc, kind: 'способность', rollable: hasActivities(doc) })),
            ...synergyEffects.map(doc => ({ doc, kind: doc.flags[MODULE_ID]?.is_system_effect ? 'дебафф системы' : 'эффект', system: !!doc.flags[MODULE_ID]?.is_system_effect }))
        ];
        if (!docs.length) return '';
        const rows = docs.map(({ doc, kind, rollable, system }) => {
            const open = this.expanded.has(doc.id);
            return `
                <div class="gd-syn ${open ? 'open' : ''} ${system ? 'system' : ''}">
                    <div class="gd-syn-main" data-action="expand" data-doc-id="${doc.id}">
                        <img src="${doc.img}">
                        <div class="gd-syn-name"><span>${esc(doc.name)}</span><small>${kind}</small></div>
                        ${rollable ? usesHtml(doc) : ''}
                        ${rollable ? `<button type="button" class="gd-roll" data-action="use" data-item-id="${doc.id}" title="Использовать"><i class="fas fa-dice-d20"></i></button>` : ''}
                    </div>
                    ${open ? `<div class="gd-syn-desc">${descriptionBody(descriptions.get(doc.id)) || '<p>Описание отсутствует.</p>'}</div>` : ''}
                </div>`;
        }).join('');
        return `<div class="gd-synergies"><div class="gd-build-title">Активные синергии</div>${rows}</div>`;
    }

    // Прогресс синергий по всем тегам экипированных навыков: ступени 2/4/6
    #buildHtml({ tagCounts }) {
        const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        if (!tags.length) return '';
        const rows = tags.map(([tag, count]) => {
            const pips = Array.from({ length: 6 }, (_, i) =>
                `<span class="${i < count ? 'on' : ''} ${i % 2 ? 'step' : ''}"></span>`).join('');
            return `<div class="gd-build-row"><span class="gd-build-tag">${esc(tag)}</span><span class="gd-build-pips">${pips}</span><span class="gd-build-count">${count}</span></div>`;
        }).join('');
        return `<div class="gd-build"><div class="gd-build-title">Синергии сборки</div>${rows}</div>`;
    }

    // Кольцо «Предела разума» из сегментов, как счётчик Хватки в Hades II
    #ringHtml({ naturalCap, absoluteCap, equipped, overloaded }) {
        const r = 52;
        const c = 2 * Math.PI * r;
        const step = c / absoluteCap;
        const gap = Math.min(6, step * 0.3);
        const seg = step - gap;
        const segments = (from, to, cls) => {
            if (to <= from) return '';
            const dash = [`0 ${(step * from).toFixed(2)}`];
            for (let i = from; i < to; i++) dash.push(`${seg.toFixed(2)} ${gap.toFixed(2)}`);
            dash.push(`0 ${c.toFixed(2)}`);
            return `<circle class="${cls}" cx="64" cy="64" r="${r}" stroke-dasharray="${dash.join(' ')}"/>`;
        };
        const filled = equipped.length;
        return `
            <div class="gd-ring ${overloaded ? 'overloaded' : ''}">
                <svg viewBox="0 0 128 128">
                    ${segments(0, naturalCap, 'gd-ring-base')}
                    ${segments(naturalCap, absoluteCap, 'gd-ring-extra')}
                    ${segments(0, Math.min(filled, naturalCap), 'gd-ring-fill')}
                    ${segments(naturalCap, Math.min(filled, absoluteCap), 'gd-ring-over')}
                </svg>
                <div class="gd-ring-count"><span>${filled}</span>/${naturalCap}</div>
                <div class="gd-ring-label">Предел разума</div>
                ${absoluteCap > naturalCap ? `<div class="gd-ring-note extra">Абсолютный предел ${absoluteCap}</div>` : ''}
                ${overloaded ? `<div class="gd-ring-note overload">Перегруз: −2 к Инт, Мдр и Хар за слот сверх ${naturalCap}</div>` : ''}
            </div>`;
    }

    _replaceHTML(result, content) {
        content.innerHTML = result;
    }

    _onRender() {
        // Фон-сеть: старый цикл отрисовки останавливается, новый запускается на свежем canvas
        this.neural?.stop();
        const canvas = this.element.querySelector('canvas.gd-neural');
        this.neural = canvas ? new NeuralBackground(canvas, this.actor.id, Number(canvas.dataset.active) || 0) : null;
        this.neural?.start();

        // Отрицательная задержка = текущая позиция в цикле: неон продолжает движение после перерисовки
        const now = Date.now();
        this.element.style.setProperty('--gd-phase-small', `-${now % 4500}ms`);
        this.element.style.setProperty('--gd-phase-big', `-${now % 6000}ms`);
        this.element.style.setProperty('--gd-phase-fog', `-${now % 90000}ms`);
        this.element.style.setProperty('--gd-phase-fog2', `-${now % 55000}ms`);

        // Анимация последнего действия (экипировка, снятие, слияние) — на картах этого навыка
        if (this.fx && Date.now() - this.fx.time < 1500) {
            this.element.querySelectorAll(`[data-item-id="${this.fx.id}"].gd-tcard, [data-item-id="${this.fx.id}"].gd-bigcard`)
                .forEach(el => el.classList.add(`fx-${this.fx.type}`));
        }

        this.element.querySelectorAll('.gd-uses-input').forEach(input => {
            input.addEventListener('click', event => event.stopPropagation());
            input.addEventListener('change', async event => {
                const item = this.actor.items.get(event.currentTarget.dataset.itemId);
                if (!item) return;
                const max = parseInt(event.currentTarget.dataset.max) || 0;
                let value = parseInt(event.currentTarget.value);
                if (isNaN(value)) value = max;
                value = Math.max(0, Math.min(max, value));
                await item.update({ 'system.uses.spent': max - value });
            });
        });
    }

    // ==========================================
    // ДЕЙСТВИЯ
    // ==========================================

    static #onSelect(event, target) {
        this.selectedId = target.dataset.itemId;
        this.render();
    }

    static #onExpand(event, target) {
        const id = target.dataset.docId;
        if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
        this.render();
    }

    static #onOpenSheet(event, target) {
        this.actor.items.get(target.dataset.itemId)?.sheet.render(true);
    }

    static async #onUse(event, target) {
        event.stopPropagation();
        await this.actor.items.get(target.dataset.itemId)?.use();
    }

    static async #onForge(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (!item) return;
        target.disabled = true;
        const rank = item.flags[MODULE_ID]?.rank ?? 1;
        await forgeSkill(this.actor, item);
        if ((item.flags[MODULE_ID]?.rank ?? 1) > rank) {
            this.fx = { id: item.id, type: 'merge', time: Date.now() };
            playTerminalSound('merge');
        }
        this.render();
    }

    static async #onToggleEquip(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (!item) return;
        target.disabled = true;

        const equipping = !item.flags[MODULE_ID]?.is_active;

        // В бою навыки не меняются; Горячая замена разрешает одну пару «снять → экипировать»
        let usesSwap = false;
        if (isInCombat(this.actor) && !game.user.isGM) {
            if (equipping) {
                if (!this.actor.getFlag(MODULE_ID, 'swapPending')) {
                    ui.notifications.warn('В бою навыки менять нельзя.');
                    return this.render();
                }
                usesSwap = true;
            } else {
                const swap = this.actor.items.find(i => isMemorySkill(i) && i.flags[MODULE_ID].is_active
                    && i.flags[MODULE_ID].combat_swap && (Number(i.system.uses?.max) || 0) > (i.system.uses?.spent || 0));
                if (!swap) {
                    ui.notifications.warn('В бою навыки менять нельзя.');
                    return this.render();
                }
                await swap.update({ 'system.uses.spent': (swap.system.uses.spent || 0) + 1 });
                await this.actor.setFlag(MODULE_ID, 'swapPending', true);
                ui.notifications.info(`${swap.name}: выберите навык, который займёт освободившийся слот.`);
            }
        }
        if (equipping) {
            const level = this.actor.system.details?.level || 1;
            const equipped = this.actor.items.filter(i => isMemorySkill(i) && i.flags[MODULE_ID].is_active);
            const cap = 6 + Math.floor(level / 2) + getSlotBonus(equipped) + (Number(item.flags[MODULE_ID]?.slot_bonus) || 0);
            if (equipped.length >= cap) {
                ui.notifications.error(`Достигнут абсолютный предел (${cap}).`);
                return this.render();
            }
        }

        await setSkillEquipped(item, equipping);
        if (usesSwap) await this.actor.unsetFlag(MODULE_ID, 'swapPending');
        this.fx = { id: item.id, type: equipping ? 'equip' : 'unequip', time: Date.now() };
        playTerminalSound(equipping ? 'equip' : 'unequip');
        await updateActorSynergies(this.actor);
        this.render();
    }
}

// ==========================================
// ОБНОВЛЕНИЕ ОТКРЫТЫХ ТЕРМИНАЛОВ
// ==========================================

function openTerminals() {
    return [...(foundry.applications.instances?.values() ?? [])].filter(app => app instanceof MemoryTerminal);
}

function rerender(actor) {
    for (const app of openTerminals()) {
        if (!actor || app.actor?.id === actor.id) app.requestRender();
    }
}

for (const hook of ['createItem', 'updateItem', 'deleteItem']) Hooks.on(hook, item => rerender(item.parent));
for (const hook of ['createActiveEffect', 'updateActiveEffect', 'deleteActiveEffect']) {
    Hooks.on(hook, effect => rerender(effect.parent instanceof Actor ? effect.parent : effect.parent?.parent));
}
Hooks.on('updateActor', actor => rerender(actor));

// Перемещение отряда по карте этажа меняет доступность слияния на Привале
Hooks.on('updateScene', (scene, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) rerender(null);
});
