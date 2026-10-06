/**
 * Gacha Roguelike dnd5e — Терминал Тумана
 *
 * Вкладка «Память» — сетка кристаллов и панель выбранного навыка (по образцу Арканы Hades II).
 * Вкладка «Слоты» — компактный список экипированного для быстрого доступа в бою.
 */

import { MODULE_ID } from "./main.js";
import { updateActorSynergies, isMemorySkill, getSlotBonus, setSkillEquipped } from "./synergy.js";
import { canRankUp, forgeSkill, findDuplicateCrystal, FORGE_COST, MEMORY_CAPACITY } from "./inventory.js";
import { isPartyAtRest } from "./map.js";

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

function hasActivities(item) {
    return (item.system?.activities?.size ?? 0) > 0;
}

function rankPips(flags) {
    const max = flags.max_rank ?? 1;
    if (max <= 1) return '';
    const rank = flags.rank ?? 1;
    return `<span class="gd-pips" title="Ранг ${RANK_LABELS[rank - 1]} из ${RANK_LABELS[max - 1]}">${'●'.repeat(rank)}${'○'.repeat(max - rank)}</span>`;
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
        this.tab = 'memory';
        this.selectedId = null;
        this.expanded = new Set();
    }

    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-terminal'],
        tag: 'div',
        window: { icon: 'fas fa-brain', resizable: true },
        position: { width: 640, height: 780 },
        actions: {
            tab: MemoryTerminal.#onTab,
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
        const synergyEffects = actor.effects.filter(e => e.flags?.[MODULE_ID]?.is_synergy || e.flags?.[MODULE_ID]?.is_system_effect);

        const descriptions = new Map();
        for (const doc of [selected, ...equipped, ...synergyItems].filter(Boolean)) {
            if (!descriptions.has(doc.id)) descriptions.set(doc.id, await enrichDescription(doc.system?.description?.value, doc));
        }
        for (const effect of synergyEffects) descriptions.set(effect.id, await enrichDescription(effect.description, actor));

        return {
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
            ${this.#headerHtml(context)}
            <nav class="gd-tabs">
                <a class="${this.tab === 'memory' ? 'active' : ''}" data-action="tab" data-tab="memory">Память <span>${context.memory.length}/${MEMORY_CAPACITY}</span></a>
                <a class="${this.tab === 'slots' ? 'active' : ''}" data-action="tab" data-tab="slots">Слоты <span>${context.equipped.length}</span></a>
            </nav>
            <section class="gd-body">
                ${this.tab === 'memory' ? this.#memoryHtml(context) : this.#slotsHtml(context)}
            </section>`;
    }

    _replaceHTML(result, content) {
        content.innerHTML = result;
    }

    _onRender() {
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

    #headerHtml({ naturalCap, absoluteCap, equipped, overloaded, atRest, hitDice }) {
        const pips = Array.from({ length: absoluteCap }, (_, i) => {
            const classes = ['gd-slot'];
            if (i >= naturalCap) classes.push('extra');
            if (i < equipped.length) classes.push(i >= naturalCap ? 'filled overload' : 'filled');
            return `<span class="${classes.join(' ')}"></span>`;
        }).join('');

        return `
            <header class="gd-header ${overloaded ? 'overloaded' : ''}">
                <div class="gd-cap">
                    <span class="gd-cap-label">Предел разума</span>
                    <span class="gd-slots">${pips}</span>
                    <span class="gd-cap-count">${equipped.length} / ${naturalCap}</span>
                </div>
                ${absoluteCap > naturalCap ? `<div class="gd-cap-note extra">Киберпсихоз: абсолютный предел ${absoluteCap}</div>` : ''}
                ${overloaded ? `<div class="gd-cap-note overload">Перегруз разума: −2 к Инт, Мдр и Хар за каждый слот сверх ${naturalCap}</div>` : ''}
            </header>
            ${atRest ? `<div class="gd-rest-banner"><i class="fas fa-campground"></i> Привал · Кости Хитов: <strong>${hitDice}</strong> · слияние повторных кристаллов доступно</div>` : ''}`;
    }

    #memoryHtml(context) {
        if (!context.memory.length) {
            return `<div class="gd-empty">Память пуста.<br>Кристаллы выпадают после боёв и продаются в Магазине — поглотите кристалл из инвентаря, чтобы навык появился здесь.</div>`;
        }

        const cards = context.memory.map(item => {
            const flags = item.flags[MODULE_ID];
            const rarity = RARITY[flags.rarity] ?? RARITY.gray;
            const mergeable = context.atRest && canRankUp(item) && findDuplicateCrystal(this.actor, item);
            const classes = ['gd-card'];
            if (flags.is_active) classes.push('equipped');
            if (item.id === context.selected?.id) classes.push('selected');
            return `
                <div class="${classes.join(' ')}" style="--rarity: ${rarity.color}" data-action="select" data-item-id="${item.id}" title="${esc(item.name)}">
                    <img src="${item.img}">
                    <div class="gd-card-name">${esc(item.name)}</div>
                    <div class="gd-card-meta">${rankPips(flags)}${mergeable ? '<i class="fas fa-hammer gd-merge-mark" title="Можно слить"></i>' : ''}</div>
                    ${flags.is_active ? '<span class="gd-card-badge" title="Экипирован"><i class="fas fa-bolt"></i></span>' : ''}
                </div>`;
        }).join('');

        return `<div class="gd-grid">${cards}</div>${this.#detailsHtml(context)}`;
    }

    #detailsHtml({ selected, emittedTags, atRest, hitDice, descriptions }) {
        if (!selected) return '';
        const flags = selected.flags[MODULE_ID];
        const rarity = RARITY[flags.rarity] ?? RARITY.gray;
        const tags = [...(flags.tags ?? [])];
        if (flags.is_active && !flags.tagEmitter) emittedTags.forEach(t => { if (!tags.includes(t)) tags.push(t); });

        let forgeButton = '';
        if (atRest && canRankUp(selected)) {
            const cost = FORGE_COST[(flags.rank ?? 1) + 1];
            const crystal = findDuplicateCrystal(this.actor, selected);
            const reason = !crystal ? 'Нужен повторный кристалл в инвентаре' : hitDice < cost ? `Не хватает Костей Хитов (${hitDice})` : '';
            forgeButton = `<button type="button" class="gd-btn forge" data-action="forge" data-item-id="${selected.id}" ${reason ? 'disabled' : ''} title="${reason || 'Слить повторный кристалл: ранг +1'}"><i class="fas fa-hammer"></i> Слить · −${cost} КХ</button>`;
        }
        const useButton = flags.is_active && hasActivities(selected)
            ? `<button type="button" class="gd-btn" data-action="use" data-item-id="${selected.id}"><i class="fas fa-dice-d20"></i> Использовать</button>` : '';

        return `
            <div class="gd-details" style="--rarity: ${rarity.color}">
                <div class="gd-details-head">
                    <img src="${selected.img}" data-action="openSheet" data-item-id="${selected.id}" title="Открыть лист навыка">
                    <div class="gd-details-title">
                        <div class="gd-details-name">${esc(selected.name)} ${rankPips(flags)}</div>
                        <div class="gd-details-sub">
                            <span style="color: ${rarity.color}">${rarity.label}</span>
                            · ${esc(flags.category ?? '')}
                            ${tags.length ? `· ${tags.map(t => `<span class="gd-tag">${esc(t)}</span>`).join(' ')}` : ''}
                        </div>
                    </div>
                    ${usesHtml(selected)}
                </div>
                <div class="gd-details-desc">${descriptions.get(selected.id) || '<p>Описание отсутствует.</p>'}</div>
                <div class="gd-details-actions">
                    <button type="button" class="gd-btn ${flags.is_active ? 'unequip' : 'equip'}" data-action="toggleEquip" data-item-id="${selected.id}">
                        ${flags.is_active ? '<i class="fas fa-power-off"></i> Снять' : '<i class="fas fa-bolt"></i> Экипировать'}
                    </button>
                    ${useButton}
                    ${forgeButton}
                </div>
            </div>`;
    }

    #slotsHtml({ equipped, synergyItems, synergyEffects, descriptions }) {
        const row = (doc, { color, subtitle, pips = '', uses = '', rollable = false }) => {
            const open = this.expanded.has(doc.id);
            return `
                <div class="gd-row ${open ? 'open' : ''}" style="--rarity: ${color}">
                    <div class="gd-row-main" data-action="expand" data-doc-id="${doc.id}">
                        <img src="${doc.img}">
                        <div class="gd-row-name">
                            <span>${esc(doc.name)} ${pips}</span>
                            <small>${subtitle}</small>
                        </div>
                        ${uses}
                        ${rollable ? `<button type="button" class="gd-roll" data-action="use" data-item-id="${doc.id}" title="Использовать"><i class="fas fa-dice-d20"></i></button>` : ''}
                    </div>
                    ${open ? `<div class="gd-row-desc">${descriptions.get(doc.id) || '<p>Описание отсутствует.</p>'}</div>` : ''}
                </div>`;
        };

        const skills = equipped.map(item => {
            const flags = item.flags[MODULE_ID];
            return row(item, {
                color: (RARITY[flags.rarity] ?? RARITY.gray).color,
                subtitle: hasActivities(item) ? esc(flags.category ?? '') : `${esc(flags.category ?? '')} · пассивный`,
                pips: rankPips(flags),
                uses: usesHtml(item),
                rollable: hasActivities(item)
            });
        }).join('');

        const synergies = [
            ...synergyItems.map(item => row(item, { color: '#c9a75d', subtitle: 'способность синергии', uses: usesHtml(item), rollable: hasActivities(item) })),
            ...synergyEffects.map(effect => row(effect, {
                color: effect.flags[MODULE_ID]?.is_system_effect ? '#ff3b3b' : '#c9a75d',
                subtitle: effect.flags[MODULE_ID]?.is_system_effect ? 'дебафф системы' : 'пассивная синергия'
            }))
        ].join('');

        if (!skills && !synergies) return `<div class="gd-empty">Слоты пусты.<br>Экипируйте навыки во вкладке «Память».</div>`;
        return `
            ${skills ? `<h3 class="gd-section">Навыки</h3>${skills}` : ''}
            ${synergies ? `<h3 class="gd-section">Синергии</h3>${synergies}` : ''}`;
    }

    // ==========================================
    // ДЕЙСТВИЯ
    // ==========================================

    static #onTab(event, target) {
        this.tab = target.dataset.tab;
        this.render();
    }

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
        await forgeSkill(this.actor, item);
        this.render();
    }

    static async #onToggleEquip(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (!item) return;
        target.disabled = true;

        const equipping = !item.flags[MODULE_ID]?.is_active;
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
