/**
 * Gacha Roguelike dnd5e — Терминал Тумана (Редизайн UI)
 */

import { MODULE_ID } from "./main.js";
import { updateActorSynergies } from "./synergy.js";

export class MemoryTerminal extends Application {
    constructor(actor, options = {}) {
        super(options);
        this.actor = actor;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "gachadnd-memory-terminal",
            template: null,
            width: 540,
            height: 720,
            resizable: true,
            classes: ["dnd5e2", "gachadnd-terminal", "gacha-dark-theme"],
            tabs: [{ navSelector: ".gachadnd-tabs", contentSelector: ".gachadnd-content", initial: "memory" }]
        });
    }

    get title() {
        return `Терминал Тумана: ${this.actor.name}`;
    }

    getData() {
        const actor = this.actor;
        const level = actor.system.details.level || 1;
        const naturalCap = 6 + Math.floor(level / 2);
        
        const gachaItems = actor.items.filter(i => i.type === 'feat' && i.flags?.[MODULE_ID]?.skill_name);
        const activeItems = gachaItems.filter(i => i.flags[MODULE_ID]?.is_active);
        const hasCyberpsychosis = activeItems.some(i => i.flags[MODULE_ID]?.skill_name === 'Киберпсихоз');
        const absoluteCap = naturalCap + (hasCyberpsychosis ? 4 : 0);
        const activeCount = activeItems.length;
        const isOverloaded = activeCount > naturalCap;

        // Вспомогательная функция для проверки наличия activities в Foundry V11+
        const hasActivities = (item) => {
            const acts = item.system?.activities;
            if (!acts) return false;
            // Если это коллекция (Map)
            if (acts.size !== undefined) return acts.size > 0;
            // Если это обычный объект
            return Object.keys(acts).length > 0;
        };

        // Сбор ВСЕХ активных способностей (Синергии + Экипированные Кристаллы с кнопками)
        const activeAbilities = actor.items.filter(i => {
            const flags = i.flags?.[MODULE_ID] || {};
            const isSynergy = flags.is_synergy_item;
            const isEquippedCrystal = flags.is_active && flags.skill_name;
            return isSynergy || (isEquippedCrystal && hasActivities(i));
        });

        // Сбор пассивных эффектов синергий
        const synergyEffects = actor.effects.filter(e => e.flags?.[MODULE_ID]?.is_synergy || e.flags?.[MODULE_ID]?.is_system_effect);
        
        // Сбор экипированных кристаллов БЕЗ кнопок (чистые пассивки)
        const passiveCrystals = activeItems.filter(i => !hasActivities(i));

        return { 
            actor, level, naturalCap, gachaItems, activeItems, 
            hasCyberpsychosis, absoluteCap, activeCount, isOverloaded,
            activeAbilities, synergyEffects, passiveCrystals
        };
    }

    async _renderInner(data) {
        const ctx = this.getData();
        const div = document.createElement("div");
        div.className = "gachadnd-terminal-wrapper";
        div.style.cssText = "display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: #0b0a0a; color: #d0c9c0; font-family: var(--font-primary), sans-serif;";

        const emittedTags = [];
        ctx.activeItems.forEach(item => {
            const flags = item.flags[MODULE_ID];
            if (flags.tagEmitter && flags.emitted_tag) emittedTags.push(flags.emitted_tag);
        });

        // 1. ВКЛАДКА "ПАМЯТЬ"
        let memoryHtml = ctx.gachaItems.map(item => {
            const flags = item.flags[MODULE_ID] || {};
            const isActive = flags.is_active;
            const category = flags.category || 'НАВЫК';
            
            let currentTags = [...(flags.tags || [])];
            if (isActive && !flags.tagEmitter) {
                emittedTags.forEach(tag => {
                    if (!currentTags.find(t => t.toLowerCase() === tag.toLowerCase())) currentTags.push(tag.toUpperCase()); 
                });
            }
            const tags = currentTags.join(', ');
            const rarity = flags.rarity || 'gray';
            const rarityColors = { gray: '#7f7f7f', green: '#1eff00', blue: '#0070dd', purple: '#a335ee', red: '#ff003c', orange: '#ff8000' };
            const borderColor = rarityColors[rarity] || '#444';

            return `
                <div class="gachadnd-terminal-item" style="display: flex; align-items: center; justify-content: space-between; background: linear-gradient(90deg, rgba(20,18,18,0.9) 0%, rgba(10,9,9,0.95) 100%); padding: 10px 14px; margin-bottom: 8px; border-radius: 4px; border: 1px solid ${isActive ? borderColor : '#2a2626'}; box-shadow: ${isActive ? `inset 0 0 8px rgba(0,0,0,0.8), 0 0 6px ${borderColor}44` : 'none'};">
                    <div style="display: flex; align-items: center; gap: 14px; overflow: hidden;">
                        <img src="${item.img}" style="width: 44px; height: 44px; border-radius: 4px; border: 1px solid ${borderColor}; box-shadow: 0 2px 4px rgba(0,0,0,0.5); flex-shrink: 0;">
                        <div style="overflow: hidden;">
                            <div style="font-family: 'Modesto Condensed', serif; font-weight: bold; font-size: 1.4em; color: ${isActive ? '#f5efe6' : '#8c8275'};">${item.name}</div>
                            <div style="font-size: 0.85em; color: #7a7062; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px;">${category} ${tags ? `• [${tags}]` : ''}</div>
                        </div>
                    </div>
                    <button type="button" class="gachadnd-toggle-btn" data-item-id="${item.id}" style="width: 110px; padding: 6px; background: ${isActive ? 'linear-gradient(180deg, #183318 0%, #0d1a0d 100%)' : 'linear-gradient(180deg, #222 0%, #111 100%)'}; color: ${isActive ? '#4eff5c' : '#776e62'}; border: 1px solid ${isActive ? '#2da83b' : '#333'}; border-radius: 3px; cursor: pointer; font-family: 'Modesto Condensed', serif; font-size: 1.1em; text-transform: uppercase; font-weight: bold;">
                        ${isActive ? 'Экипирован' : 'В Памяти'}
                    </button>
                </div>
            `;
        }).join('');

        if (ctx.gachaItems.length === 0) {
            memoryHtml = `<div style="text-align: center; color: #6b6357; padding: 40px; font-style: italic; font-size: 1.1em;">Разум пуст. Поглотите кристаллы тумана.</div>`;
        }

        // 2. ВКЛАДКА "АКТИВНЫЕ"
        let activeHtml = ctx.activeAbilities.map(item => {
            const isSynergy = item.flags?.[MODULE_ID]?.is_synergy_item;
            const subtitle = isSynergy ? "Активная Синергия" : "Навык Кристалла";
            const borderColor = isSynergy ? "#c9a75d" : "#0070dd";
            const textColor = isSynergy ? "#c9a75d" : "#5a9fe8";

            return `
            <details class="gachadnd-accordion-card">
                <summary class="gachadnd-accordion-header" style="border-left: 4px solid ${borderColor};">
                    <img src="${item.img}" style="width: 38px; height: 38px; border-radius: 4px; border: 1px solid ${borderColor};">
                    <div style="flex-grow: 1; display: flex; flex-direction: column;">
                        <span style="font-family: 'Modesto Condensed', serif; font-weight: bold; font-size: 1.4em; color: #f5efe6; line-height: 1.1;">${item.name}</span>
                        <span style="font-size: 0.8em; color: ${textColor}; text-transform: uppercase; letter-spacing: 0.5px;">${subtitle}</span>
                    </div>
                    <button type="button" class="gachadnd-use-btn" data-item-id="${item.id}" style="padding: 4px 12px; margin-right: 10px; font-family: 'Modesto Condensed', serif; font-size: 1.1em; background: #2a2218; color: ${borderColor}; border: 1px solid ${borderColor}; cursor: pointer; border-radius: 3px; font-weight: bold;">
                        <i class="fas fa-dice-d20"></i> Применить
                    </button>
                    <i class="fas fa-chevron-down gachadnd-collapse-icon"></i>
                </summary>
                <div class="gachadnd-accordion-body">
                    ${item.system?.description?.value || '<p>Описание отсутствует.</p>'}
                </div>
            </details>
        `}).join('');
        if (!activeHtml) activeHtml = `<div style="text-align: center; color: #6b6357; padding: 40px; font-size: 1.1em;">Нет активных способностей.</div>`;

        // 3. ВКЛАДКА "ПАССИВНЫЕ"
        let passiveHtml = "";
        
        // Рендерим пассивные кристаллы
        passiveHtml += ctx.passiveCrystals.map(item => `
            <details class="gachadnd-accordion-card">
                <summary class="gachadnd-accordion-header" style="border-left: 4px solid #4eff5c;">
                    <img src="${item.img}" style="width: 32px; height: 32px; border-radius: 3px;">
                    <div style="flex-grow: 1; display: flex; flex-direction: column;">
                        <span style="font-family: 'Modesto Condensed', serif; font-weight: bold; font-size: 1.3em; color: #4eff5c; line-height: 1.1;">${item.name}</span>
                        <span style="font-size: 0.8em; color: #518c58; text-transform: uppercase; letter-spacing: 0.5px;">Пассивный Кристалл</span>
                    </div>
                    <i class="fas fa-chevron-down gachadnd-collapse-icon"></i>
                </summary>
                <div class="gachadnd-accordion-body">
                    ${item.system?.description?.value || '<p>Пассивный бонус.</p>'}
                </div>
            </details>
        `).join('');

        // Рендерим эффекты синергий
        passiveHtml += ctx.synergyEffects.map(eff => {
            const isCyber = eff.name.includes('Киберпсихоз');
            const color = isCyber ? '#ff3b3b' : '#c9a75d';
            const subtitle = isCyber ? "Дебафф Системы" : "Пассивная Синергия";
            return `
            <details class="gachadnd-accordion-card">
                <summary class="gachadnd-accordion-header" style="border-left: 4px solid ${color};">
                    <img src="${eff.img}" style="width: 32px; height: 32px; border-radius: 3px;">
                    <div style="flex-grow: 1; display: flex; flex-direction: column;">
                        <span style="font-family: 'Modesto Condensed', serif; font-weight: bold; font-size: 1.3em; color: ${color}; line-height: 1.1;">${eff.name}</span>
                        <span style="font-size: 0.8em; color: ${color}88; text-transform: uppercase; letter-spacing: 0.5px;">${subtitle}</span>
                    </div>
                    <i class="fas fa-chevron-down gachadnd-collapse-icon"></i>
                </summary>
                <div class="gachadnd-accordion-body">
                    ${eff.description || '<p>Пассивный бонус активен.</p>'}
                </div>
            </details>
        `}).join('');
        
        if (!passiveHtml) passiveHtml = `<div style="text-align: center; color: #6b6357; padding: 40px; font-size: 1.1em;">Нет пассивных эффектов.</div>`;

        div.innerHTML = `
            <nav class="gachadnd-tabs" style="display: flex; background: #111; border-bottom: 1px solid #333; padding: 0 10px; font-family: 'Modesto Condensed', serif;">
                <a class="item" data-tab="memory" style="padding: 12px 15px; font-size: 1.3em; cursor: pointer; color: #b5a998; font-weight: bold; text-transform: uppercase;">Память</a>
                <a class="item" data-tab="active" style="padding: 12px 15px; font-size: 1.3em; cursor: pointer; color: #b5a998; font-weight: bold; text-transform: uppercase;">Активные</a>
                <a class="item" data-tab="passive" style="padding: 12px 15px; font-size: 1.3em; cursor: pointer; color: #b5a998; font-weight: bold; text-transform: uppercase;">Пассивные</a>
                <button type="button" id="gachadnd-help-btn" style="margin-left: auto; align-self: center; background: transparent; border: 1px solid #7a7062; color: #7a7062; border-radius: 50%; width: 26px; height: 26px; cursor: pointer;" title="Правила">
                    <i class="fas fa-question" style="font-size: 13px;"></i>
                </button>
            </nav>
            <section class="gachadnd-content" style="padding: 16px; flex-grow: 1; overflow-y: hidden; display: flex; flex-direction: column;">
                
                <div class="tab" data-tab="memory" style="height: 100%;">
                    <div style="display: flex; flex-direction: column; height: 100%;">
                        <div class="gachadnd-cap-counter ${ctx.isOverloaded ? 'overloaded' : ''}" style="margin-bottom: 14px; background: ${ctx.isOverloaded ? 'linear-gradient(180deg, #380d12 0%, #1a0507 100%)' : 'linear-gradient(180deg, #1c1a19 0%, #121110 100%)'}; border: 1px solid ${ctx.isOverloaded ? '#990022' : '#3d3834'}; border-radius: 4px; padding: 14px; text-align: center; font-family: 'Modesto Condensed', serif;">
                            <div style="font-size: 1.8em; color: #ede6dc;">
                                <i class="fas fa-brain" style="color: ${ctx.isOverloaded ? '#ff3b3b' : '#c2b59b'};"></i> ПРЕДЕЛ РАЗУМА: 
                                <span style="font-weight: bold; color: ${ctx.isOverloaded ? '#ff3b3b' : '#4eff5c'};">${ctx.activeCount} / ${ctx.naturalCap}</span>
                            </div>
                            ${ctx.hasCyberpsychosis ? `<div style="color: #b057f5; font-size: 1.1em; margin-top: 4px;">КИБЕРПСИХОЗ ПОДАВЛЕН (Абсолютный лимит: ${ctx.absoluteCap})</div>` : ''}
                            ${ctx.isOverloaded ? `<div style="color: #ff3b3b; font-size: 1.1em; margin-top: 6px; font-weight: bold;">⚠️ КРИТИЧЕСКИЙ ПЕРЕГРУЗ РАЗУМА</div>` : ''}
                        </div>
                        <div style="overflow-y: auto; flex-grow: 1; padding-right: 6px;">
                            ${memoryHtml}
                        </div>
                    </div>
                </div>

                <div class="tab" data-tab="active" style="height: 100%;">
                    <div style="overflow-y: auto; height: 100%; padding-right: 6px;">
                        ${activeHtml}
                    </div>
                </div>

                <div class="tab" data-tab="passive" style="height: 100%;">
                    <div style="overflow-y: auto; height: 100%; padding-right: 6px;">
                        ${passiveHtml}
                    </div>
                </div>

            </section>
        `;
        
        return $(div);
    }

    activateListeners(html) {
        super.activateListeners(html);
        const element = html instanceof jQuery ? html[0] : html;

        const style = document.createElement('style');
        style.innerHTML = `
            .gachadnd-tabs .item.active { border-bottom: 2px solid #c9a75d; color: #c9a75d !important; background: rgba(201, 167, 93, 0.1); }
            .gachadnd-tabs .item:hover { color: #fff !important; }
            .gachadnd-terminal .tab { display: none; }
            .gachadnd-terminal .tab.active { display: flex; flex-direction: column; }
            
            .gachadnd-accordion-card {
                background: rgba(20,18,18,0.95);
                border: 1px solid #3d3834;
                border-radius: 4px;
                margin-bottom: 8px;
                overflow: hidden;
            }
            .gachadnd-accordion-header {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 10px 14px;
                cursor: pointer;
                list-style: none;
                user-select: none;
                transition: background 0.2s;
            }
            .gachadnd-accordion-header::-webkit-details-marker { display: none; }
            .gachadnd-accordion-header:hover { background: rgba(35,32,32,0.9); }
            
            .gachadnd-collapse-icon {
                color: #7a7062;
                transition: transform 0.3s ease;
                font-size: 1.1em;
            }
            details[open] .gachadnd-collapse-icon {
                transform: rotate(180deg);
            }
            
            .gachadnd-accordion-body {
                padding: 14px 16px;
                border-top: 1px solid #3d3834;
                background: #111;
                font-family: var(--font-primary), sans-serif;
                font-size: 14px;
                line-height: 1.5;
                color: #c9c1b5;
                text-transform: none;
            }
            .gachadnd-accordion-body ul { margin: 0; padding-left: 20px; }
            .gachadnd-accordion-body li { margin-bottom: 8px; }
            .gachadnd-accordion-body strong { color: #f5efe6; }
            .gachadnd-use-btn:hover { background: #3a2f21 !important; color: #fff !important; }
        `;
        element.appendChild(style);

        const helpBtn = element.querySelector('#gachadnd-help-btn');
        if (helpBtn) {
            helpBtn.addEventListener('click', async () => {
                const journalName = "Правила Тумана";
                let rulebook = game.journal.getName(journalName);
                if (!rulebook) {
                    const pack = game.packs.get(`${MODULE_ID}.gacha-rules`);
                    if (pack) {
                        const docs = await pack.getDocuments();
                        rulebook = docs.find(d => d.name === journalName);
                    }
                }
                if (rulebook) rulebook.sheet.render(true);
                else ui.notifications.warn(`⚠️ Справочник "${journalName}" не найден!`);
            });
        }

        element.querySelectorAll('.gachadnd-toggle-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                
                if (btn.disabled) return;
                btn.disabled = true;

                const item = this.actor.items.get(btn.dataset.itemId);
                if (!item) { btn.disabled = false; return; }

                const ctx = this.getData();
                const currentActive = item.flags[MODULE_ID]?.is_active || false;
                const isActivating = !currentActive;
                let currentAbsoluteCap = ctx.absoluteCap;

                if (isActivating && item.flags[MODULE_ID]?.skill_name === 'Киберпсихоз') currentAbsoluteCap += 4;
                if (isActivating && ctx.activeCount >= currentAbsoluteCap && !currentActive) {
                    ui.notifications.error(`🧠 Достигнут абсолютный предел (${currentAbsoluteCap}).`);
                    btn.disabled = false;
                    return;
                }

                await item.setFlag(MODULE_ID, 'is_active', isActivating);
                await updateActorSynergies(this.actor);
                this.render(false);
            });
        });

        element.querySelectorAll('.gachadnd-use-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation(); 
                const item = this.actor.items.get(btn.dataset.itemId);
                if (item) item.use();
            });
        });
    }
}