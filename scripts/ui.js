/**
 * Gacha Roguelike dnd5e — Терминал Тумана
 *
 * Вкладка «Память» — сетка кристаллов и панель выбранного навыка (по образцу Арканы Hades II).
 * Вкладка «Слоты» — компактный список экипированного для быстрого доступа в бою.
 */

import { MODULE_ID } from "./constants.js";
import { updateActorSynergies, isMemorySkill, getSlotBonus, setSkillEquipped, isInCombat, occupiesSlot } from "./synergy.js";
import { HOOKS, isAtRest, allowSkillChange } from "./memory-api.js";
import { MemoryAltar } from "./memory-altar.js";
import { canRankUp, forgeSkill, findDuplicateCrystal, FORGE_COST, getMemoryCapacity, romanRank, setPersonalEffect } from "./inventory.js";
import { collectGlossary } from "./glossary.js";
import { playTerminalSound } from "./sounds.js";
import { NeuralBackground } from "./neural.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TEMPLATES = 'modules/gachadnd/templates/terminal';
// Фон-сеть рисуется один раз и переживает перерисовки остальных частей
const CONTENT_PARTS = ['banner', 'deck', 'feature', 'side'];

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
    return rows.map(([label, value, raw]) => ({ label, html: raw ? value : esc(value) }));
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

/**
 * Окно из частей: backdrop (canvas нейросети), banner (Привал), deck (колода Памяти),
 * feature (выбранный навык), side (Предел разума, синергии, справочник).
 * Выбор карты перерисовывает только feature и side; в колоде меняется класс на месте.
 */
export class MemoryTerminal extends HandlebarsApplicationMixin(ApplicationV2) {
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
            openSheet: MemoryTerminal.#onOpenSheet,
            openAltar: MemoryTerminal.#onOpenAltar,
            editPersonal: MemoryTerminal.#onEditPersonal,
            extension: MemoryTerminal.#onExtension
        }
    };

    static PARTS = Object.fromEntries(['backdrop', ...CONTENT_PARTS].map(id => [id, { template: `${TEMPLATES}/${id}.hbs`, scrollable: { deck: ['.gd-deck'], side: ['.gd-glossary'] }[id] }]));

    get title() {
        return `Терминал Тумана: ${this.actor.name}`;
    }

    // Изменения документов приходят пачками (экипировка, пересчёт синергий) — перерисовка одна
    #debouncedRender = foundry.utils.debounce(() => this.#renderContent(), 50);

    // Всё, кроме фона-сети
    #renderContent(parts = CONTENT_PARTS) {
        return this.render(this.rendered ? { parts } : { force: true });
    }

    /**
     * Анимации Терминала (неон, туман, нейросеть) работают, только пока Терминал в фокусе.
     * Клик в другое окно — лист персонажа, чат, сцену — ставит их на паузу: рядом с тяжёлым листом
     * постоянная анимация заставляет браузер перерисовывать страницу каждый кадр.
     */
    #idle = false;
    #extensions = [];
    #onPointerDown = event => this.#setIdle(!this.element?.contains(event.target));
    #onVisibility = () => this.#setIdle(document.hidden || this.#idle);

    #setIdle(idle) {
        if (!this.element) return;
        this.#idle = idle;
        this.element.classList.toggle('gd-idle', idle);
        if (idle) this.neural?.pause();
        else this.neural?.start();
    }

    _onFirstRender(context, options) {
        super._onFirstRender?.(context, options);
        document.addEventListener('pointerdown', this.#onPointerDown, true);
        document.addEventListener('visibilitychange', this.#onVisibility);
    }

    _onClose(options) {
        document.removeEventListener('pointerdown', this.#onPointerDown, true);
        document.removeEventListener('visibilitychange', this.#onVisibility);
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

        const atRest = isAtRest();
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

        const slotted = equipped.filter(occupiesSlot);
        return {
            atRest, hitDice, glossary,
            equippedCount: equipped.length,
            capacity: getMemoryCapacity(actor),
            cards: this.#cards(memory, selected, atRest),
            emptySlots: Array.from({ length: Math.max(0, getMemoryCapacity(actor) - memory.length) }),
            cardsPresent: memory.length > 0,
            feature: selected ? this.#feature(selected, emittedTags, descriptions) : null,
            ring: this.#ring(naturalCap, absoluteCap, slotted),
            build: this.#build(tagCounts),
            synergies: this.#synergies(synergyItems, synergyEffects, descriptions)
        };
    }

    // ==========================================
    // ВИД: данные для шаблонов частей
    // ==========================================

    #cards(memory, selected, atRest) {
        return memory.map(item => {
            const flags = item.flags[MODULE_ID];
            const ranked = (flags.max_rank ?? 1) > 1 || !!flags.stacking;
            return {
                id: item.id, name: item.name, img: item.img,
                color: (RARITY[flags.rarity] ?? RARITY.gray).color,
                cls: [flags.is_active && 'equipped', item.id === selected?.id && 'selected'].filter(Boolean).join(' '),
                equipped: !!flags.is_active, ranked, rank: flags.rank ?? 1,
                mergeable: !!(atRest && canRankUp(item) && findDuplicateCrystal(this.actor, item))
            };
        });
    }

    #feature(selected, emittedTags, descriptions) {
        const flags = selected.flags[MODULE_ID];
        const rarity = RARITY[flags.rarity] ?? RARITY.gray;
        const ranked = (flags.max_rank ?? 1) > 1 || !!flags.stacking;
        const rank = flags.rank ?? 1;
        const tags = [...(flags.tags ?? [])];
        if (flags.is_active && !flags.tagEmitter) emittedTags.forEach(t => { if (!tags.includes(t)) tags.push(t); });
        const isGM = !!game.user?.isGM;
        // Плашки и кнопки от подключённых систем (например, Всадников Лабиринта)
        const view = { notes: [], actions: [] };
        Hooks.callAll(HOOKS.terminalSkillView, selected, view);
        this.#extensions = view.actions.map(a => a.run);
        return {
            id: selected.id, name: selected.name, img: selected.img, color: rarity.color,
            equipped: !!flags.is_active, ranked, rank: romanRank(rank),
            chips: [
                { text: rarity.label, color: rarity.color },
                { text: flags.category ?? '' },
                ...tags.map(t => ({ text: t, cls: 'tag' })),
                ...(ranked ? [{ text: `Ранг ${romanRank(rank)}${canRankUp(selected) ? ' · можно улучшить' : ''}` }] : []),
                ...(['purple', 'red'].includes(flags.rarity) ? [{ text: 'Уникальный', cls: 'unique' }] : [])
            ],
            drawback: flags.drawback && !flags.cleansed ? flags.drawback : null,
            notes: view.notes,
            extensions: view.actions.map(({ label, icon, title }, index) => ({ index, label, icon, title })),
            body: descriptionBody(descriptions.get(selected.id)) || '<p>Описание отсутствует.</p>',
            hiddenRanks: isGM && ranked && rank < flags.max_rank
                ? (flags.rank_texts ?? []).slice(rank - 1).map((text, i) => ({ label: RANK_LABELS[rank + i], text }))
                : null,
            stats: statsRows(selected),
            canUse: !!flags.is_active && hasActivities(selected),
            gm: { personal: !!flags.personal && isGM }
        };
    }

    // Активные синергии: способности (с кнопкой броска) и эффекты; клик раскрывает описание
    #synergies(synergyItems, synergyEffects, descriptions) {
        return [
            ...synergyItems.map(doc => ({ doc, kind: 'способность', rollable: hasActivities(doc) })),
            ...synergyEffects.map(doc => ({ doc, kind: doc.flags[MODULE_ID]?.is_system_effect ? 'дебафф системы' : 'эффект', system: !!doc.flags[MODULE_ID]?.is_system_effect }))
        ].map(({ doc, kind, rollable, system }) => ({
            id: doc.id, img: doc.img, name: doc.name, kind, rollable: !!rollable, system: !!system,
            open: this.expanded.has(doc.id),
            usesHtml: rollable ? usesHtml(doc) : '',
            desc: descriptionBody(descriptions.get(doc.id)) || '<p>Описание отсутствует.</p>'
        }));
    }

    // Прогресс синергий по всем тегам экипированных навыков: ступени 2/4/6
    #build(tagCounts) {
        return Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({
            tag, count,
            pips: Array.from({ length: 6 }, (_, i) => [i < count && 'on', i % 2 && 'step'].filter(Boolean).join(' '))
        }));
    }

    // Кольцо «Предела разума» из сегментов, как счётчик Хватки в Hades II
    #ring(naturalCap, absoluteCap, slotted) {
        const r = 52;
        const c = 2 * Math.PI * r;
        const step = c / absoluteCap;
        const gap = Math.min(6, step * 0.3);
        const seg = step - gap;
        const segment = (from, to, cls) => {
            if (to <= from) return null;
            const dash = [`0 ${(step * from).toFixed(2)}`];
            for (let i = from; i < to; i++) dash.push(`${seg.toFixed(2)} ${gap.toFixed(2)}`);
            dash.push(`0 ${c.toFixed(2)}`);
            return { cls, dash: dash.join(' ') };
        };
        const filled = slotted.length;
        return {
            filled, naturalCap, absoluteCap,
            extra: absoluteCap > naturalCap,
            overloaded: filled > naturalCap,
            segments: [
                segment(0, naturalCap, 'gd-ring-base'),
                segment(naturalCap, absoluteCap, 'gd-ring-extra'),
                segment(0, Math.min(filled, naturalCap), 'gd-ring-fill'),
                segment(naturalCap, Math.min(filled, absoluteCap), 'gd-ring-over')
            ].filter(Boolean)
        };
    }

    // ==========================================
    // ОТРИСОВКА ЧАСТЕЙ
    // ==========================================

    _onRender(context, options) {
        super._onRender(context, options);
        // Фон-сеть создаётся вместе со своей частью; дальше ей только сообщают число экипированных
        if (options.parts?.includes('backdrop')) {
            this.neural?.stop();
            const canvas = this.element.querySelector('canvas.gd-neural');
            this.neural = canvas ? new NeuralBackground(canvas, this.actor.id, context.equippedCount) : null;
            if (this.#idle) this.neural?.pause();
            else this.neural?.start();
        } else {
            this.neural?.setActiveCount(context.equippedCount);
        }

        // Отрицательная задержка = текущая позиция в цикле от часов. Задаётся только новым
        // элементам: части, нарисованной сейчас, — для неона; окну — один раз, для тумана.
        // Смена задержки у уже идущей анимации сдвигает её фазу — туман и неон дёргались
        const now = Date.now();
        if (options.isFirstRender) {
            this.element.style.setProperty('--gd-phase-fog', `-${now % 90000}ms`);
            this.element.style.setProperty('--gd-phase-fog2', `-${now % 55000}ms`);
        }
        for (const id of ['deck', 'feature']) {
            const part = options.parts?.includes(id) && this.element.querySelector(`[data-application-part="${id}"]`);
            if (!part) continue;
            part.style.setProperty('--gd-phase-small', `-${now % 4500}ms`);
            part.style.setProperty('--gd-phase-big', `-${now % 6000}ms`);
        }

        // Анимация последнего действия (экипировка, снятие, слияние) — на картах этого навыка
        // Действие вызывает несколько перерисовок подряд (предмет, синергии); новая карта
        // продолжает анимацию с прошедшего момента, а не запускает её заново
        const elapsed = this.fx ? now - this.fx.time : Infinity;
        if (elapsed < 1500) {
            this.element.querySelectorAll(`[data-item-id="${this.fx.id}"].gd-tcard, [data-item-id="${this.fx.id}"].gd-bigcard`)
                .forEach(el => {
                    if (el.classList.contains(`fx-${this.fx.type}`)) return;
                    el.style.setProperty('animation-delay', `-${elapsed}ms`, 'important');
                    el.classList.add(`fx-${this.fx.type}`);
                });
        }

        this.element.querySelectorAll('.gd-uses-input:not([data-bound])').forEach(input => {
            input.dataset.bound = '1';
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

    // Колода не перерисовывается: выделение переносится на месте, неон карт не сбивается
    static #onSelect(event, target) {
        this.selectedId = target.dataset.itemId;
        this.element.querySelectorAll('.gd-tcard.selected').forEach(el => el.classList.remove('selected'));
        target.classList.add('selected');
        this.#renderContent(['feature', 'side']);
    }

    static #onExpand(event, target) {
        const id = target.dataset.docId;
        if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
        this.#renderContent(['side']);
    }

    // Кнопка от подключённой системы: её действие и перерисовка
    static async #onExtension(event, target) {
        await this.#extensions[Number(target.dataset.index)]?.();
        this.#renderContent();
    }

    // Мастер вписывает личный эффект в копию навыка этого персонажа
    static async #onEditPersonal(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (!item || !game.user.isGM) return;
        const current = item.flags[MODULE_ID]?.personal_effect ?? '';
        const text = await foundry.applications.api.DialogV2.prompt({
            window: { title: `Личный эффект: ${item.name} — ${this.actor.name}` },
            content: `<p>Эффект, отражающий характер персонажа. Пустая строка между абзацами — новый абзац.</p>
                <textarea name="personal" rows="8" style="width: 100%">${esc(current)}</textarea>`,
            ok: { label: 'Сохранить', callback: (ev, button) => button.form.elements.personal.value },
            rejectClose: false
        });
        if (text === null || text === undefined) return;
        await setPersonalEffect(item, text);
        this.#renderContent();
    }

    static #onOpenAltar() {
        MemoryAltar.open(this.actor);
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
        this.#renderContent();
    }

    static async #onToggleEquip(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (!item) return;
        target.disabled = true;

        const equipping = !item.flags[MODULE_ID]?.is_active;
        // Запреты извне (Риск, проклятый всадник) — через точку расширения Памяти
        if (!allowSkillChange(this.actor, item, equipping)) return this.#renderContent();
        // В бою навыки не меняются; Горячая замена разрешает одну пару «снять → экипировать»
        let usesSwap = false;
        if (isInCombat(this.actor) && !game.user.isGM) {
            if (equipping) {
                if (!this.actor.getFlag(MODULE_ID, 'swapPending')) {
                    ui.notifications.warn('В бою навыки менять нельзя.');
                    return this.#renderContent();
                }
                usesSwap = true;
            } else {
                const swap = this.actor.items.find(i => isMemorySkill(i) && i.flags[MODULE_ID].is_active
                    && i.flags[MODULE_ID].combat_swap && (Number(i.system.uses?.max) || 0) > (i.system.uses?.spent || 0));
                if (!swap) {
                    ui.notifications.warn('В бою навыки менять нельзя.');
                    return this.#renderContent();
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
            // Сращённый всадник экипируется сверх лимита
            if (occupiesSlot(item) && equipped.filter(occupiesSlot).length >= cap) {
                ui.notifications.error(`Достигнут абсолютный предел (${cap}).`);
                return this.#renderContent();
            }
        }

        await setSkillEquipped(item, equipping);
        if (usesSwap) await this.actor.unsetFlag(MODULE_ID, 'swapPending');
        this.fx = { id: item.id, type: equipping ? 'equip' : 'unequip', time: Date.now() };
        playTerminalSound(equipping ? 'equip' : 'unequip');
        await updateActorSynergies(this.actor);
        this.#renderContent();
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

// Привал открылся или закрылся: баннер и значки слияния
Hooks.on(HOOKS.restChanged, () => rerender(null));
