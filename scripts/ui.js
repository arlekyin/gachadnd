/**
 * Gacha Roguelike dnd5e — Терминал Тумана (Редизайн UI)
 */

import { MODULE_ID } from "./main.js";
import { updateActorSynergies, isMemorySkill, getSlotBonus, setSkillEquipped } from "./synergy.js";
import { canRankUp, forgeSkill, findDuplicateCrystal, FORGE_COST } from "./inventory.js";
import { isPartyAtRest } from "./map.js";

// Описание с обработкой обогатителей dnd5e ([[/heal]], [[/damage]], [[lookup @prof]]) по данным персонажа
async function enrichDescription(item) {
    const html = item.system?.description?.value;
    if (!html) return '';
    const editor = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
    return editor.enrichHTML(html, { relativeTo: item, rollData: item.getRollData?.(), secrets: item.isOwner, async: true });
}

export class MemoryTerminal extends Application {
    constructor(actor, options = {}) {
        super(options);
        this.actor = actor;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "gachadnd-memory-terminal",
            template: null,
            width: 580, 
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
        
        const gachaItems = actor.items.filter(isMemorySkill);
        const activeItems = gachaItems.filter(i => i.flags[MODULE_ID]?.is_active);
        const slotBonus = getSlotBonus(activeItems);
        const hasCyberpsychosis = slotBonus > 0;
        const absoluteCap = naturalCap + slotBonus;
        const activeCount = activeItems.length;
        const isOverloaded = activeCount > naturalCap;

        const hasActivities = (item) => {
            const acts = item.system?.activities;
            if (!acts) return false;
            if (acts.size !== undefined) return acts.size > 0;
            return Object.keys(acts).length > 0;
        };

        const activeAbilities = actor.items.filter(i => {
            const flags = i.flags?.[MODULE_ID] || {};
            const isSynergy = flags.is_synergy_item;
            const isEquippedCrystal = flags.is_active && flags.skill_name;
            return isSynergy || (isEquippedCrystal && hasActivities(i));
        });

        const synergyEffects = actor.effects.filter(e => e.flags?.[MODULE_ID]?.is_synergy || e.flags?.[MODULE_ID]?.is_system_effect);
        const passiveCrystals = activeItems.filter(i => !hasActivities(i));

        return { 
            actor, level, naturalCap, gachaItems, activeItems, 
            hasCyberpsychosis, absoluteCap, activeCount, isOverloaded,
            activeAbilities, synergyEffects, passiveCrystals
        };
    }

    _generateUsesHtml(item) {
        const uses = item.system?.uses;
        const flags = item.flags?.[MODULE_ID] || {};
        
        let maxVal = parseInt(uses?.max);
        let recoveryText = '';
        let hasSystemUses = !isNaN(maxVal) && maxVal > 0;

        // Приоритет 1: Системные ресурсы Foundry
        if (hasSystemUses) {
            if (uses?.recovery && uses.recovery.length > 0) {
                const period = uses.recovery[0].period;
                if (period === 'sr') recoveryText = 'КО';
                else if (period === 'lr') recoveryText = 'ДО';
                else if (period === 'day') recoveryText = 'ДЕНЬ';
                else recoveryText = CONFIG.DND5E.limitedUsePeriods[period]?.abbreviation ?? '';
            }
        } else {
            // Приоритет 2: Фолбэк на старые флаги, если навык еще не перевыдан
            const cd = flags.cooldown;
            if (cd && cd !== 'Нет' && cd !== 'Нет/Нет') {
                if (cd.includes('/')) {
                    const parts = cd.split('/');
                    maxVal = parseInt(parts[0]);
                    recoveryText = parts[1].toLowerCase();
                } else {
                    maxVal = 1;
                    recoveryText = cd.toLowerCase();
                }

                if (recoveryText.includes('short') || recoveryText.includes('короткий')) recoveryText = 'КО';
                else if (recoveryText.includes('long') || recoveryText.includes('длинный') || recoveryText.includes('забег')) recoveryText = 'ДО';
                else if (recoveryText.includes('day') || recoveryText.includes('день')) recoveryText = 'ДЕНЬ';
                else recoveryText = recoveryText.toUpperCase();
                
                if (!isNaN(maxVal) && maxVal > 0) hasSystemUses = true;
            }
        }

        if (!hasSystemUses) {
            return `<div class="gachadnd-uses-column" style="width: 100px;"></div>`;
        }

        const spent = uses?.spent || 0;
        const current = Math.max(0, maxVal - spent);

        return `
            <div class="gachadnd-uses-column" style="display: flex; flex-direction: row; gap: 8px; align-items: center; width: 100px; justify-content: center;">
                <div class="item-detail item-uses" style="display: flex; align-items: center; gap: 4px;">
                    <input type="text" class="gachadnd-uses-input" data-item-id="${item.id}" value="${current}" data-max="${maxVal}" style="width: 24px; height: 22px; text-align: center; background: rgba(0, 0, 0, 0.3); border: 1px solid #444; border-radius: 3px; color: #ede6dc; font-family: var(--font-primary); font-size: 13px;">
                    <span class="separator" style="color: #7a7062; font-size: 13px;">/</span>
                    <span class="max" style="color: #7a7062; font-size: 13px;">${maxVal}</span>
                </div>
                ${recoveryText ? `<div class="item-detail item-recovery" style="font-size: 12px; color: #7a7062; text-transform: uppercase;">${recoveryText}</div>` : ''}
            </div>
        `;
    }

    async _renderInner(data) {
        const ctx = this.getData();
        const descriptions = new Map();
        for (const item of [...ctx.activeAbilities, ...ctx.passiveCrystals]) {
            descriptions.set(item.id, await enrichDescription(item));
        }
        const div = document.createElement("div");
        div.className = "gachadnd-terminal-wrapper";
        div.style.cssText = "display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: #0b0a0a; color: #d0c9c0; font-family: var(--font-primary), sans-serif;";

        const emittedTags = [];
        ctx.activeItems.forEach(item => {
            const flags = item.flags[MODULE_ID];
            if (flags.tagEmitter && flags.emitted_tag) emittedTags.push(flags.emitted_tag);
        });

        const listHeaderHtml = `
            <div class="gachadnd-list-header">
                <span>НАВЫК</span>
                <span style="width: 100px; text-align: center;">ИСПОЛЬЗОВАНИЯ</span>
            </div>
        `;

        // Кнопка слияния: на Привале, у навыков с доступным рангом и повторным кристаллом в инвентаре
        const atRest = isPartyAtRest();
        const hdValue = actor => actor.system?.attributes?.hd?.value ?? 0;
        const forgeHtml = item => {
            if (!atRest || !canRankUp(item) || !findDuplicateCrystal(this.actor, item)) return '';
            const cost = FORGE_COST[(item.flags[MODULE_ID].rank ?? 1) + 1];
            const enough = hdValue(this.actor) >= cost;
            return `<button type="button" class="gachadnd-forge-btn" data-item-id="${item.id}" ${enough ? '' : 'disabled'} title="Слить повторный кристалл: ранг +1 за Кости Хитов (доступно: ${hdValue(this.actor)})" style="width: 90px; padding: 6px; margin-left: 10px; background: linear-gradient(180deg, #38250d 0%, #1a1105 100%); color: ${enough ? '#ffaa00' : '#6b5a3a'}; border: 1px solid ${enough ? '#ffaa00' : '#3d3834'}; border-radius: 3px; cursor: ${enough ? 'pointer' : 'not-allowed'}; font-family: 'Modesto Condensed', serif; font-size: 1em; flex-shrink: 0;">Слить<br>−${cost} КХ</button>`;
        };

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
                    <div style="display: flex; align-items: center; gap: 14px; overflow: hidden; flex-grow: 1;">
                        <img src="${item.img}" style="width: 44px; height: 44px; border-radius: 4px; border: 1px solid ${borderColor}; flex-shrink: 0;">
                        <div style="overflow: hidden;">
                            <div style="font-family: 'Modesto Condensed', serif; font-weight: bold; font-size: 1.4em; color: ${isActive ? '#f5efe6' : '#8c8275'};">${item.name}</div>
                            <div style="font-size: 0.85em; color: #7a7062; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px;">${category}${(flags.max_rank ?? 1) > 1 ? ` • Ранг ${['I', 'II', 'III'][(flags.rank ?? 1) - 1]}` : ''} ${tags ? `• [${tags}]` : ''}</div>
                        </div>
                    </div>
                    ${this._generateUsesHtml(item)}
                    ${forgeHtml(item)}
                    <button type="button" class="gachadnd-toggle-btn" data-item-id="${item.id}" style="width: 110px; padding: 6px; margin-left: 10px; background: ${isActive ? 'linear-gradient(180deg, #183318 0%, #0d1a0d 100%)' : 'linear-gradient(180deg, #222 0%, #111 100%)'}; color: ${isActive ? '#4eff5c' : '#776e62'}; border: 1px solid ${isActive ? '#2da83b' : '#333'}; border-radius: 3px; cursor: pointer; font-family: 'Modesto Condensed', serif; font-size: 1.1em; text-transform: uppercase; font-weight: bold; flex-shrink: 0;">
                        ${isActive ? 'Экипирован' : 'В Памяти'}
                    </button>
                </div>
            `;
        }).join('');

        if (ctx.gachaItems.length === 0) {
            memoryHtml = `<div style="text-align: center; color: #6b6357; padding: 40px; font-style: italic; font-size: 1.1em;">Разум пуст. Поглотите кристаллы тумана.</div>`;
        }

        let activeHtml = ctx.activeAbilities.map(item => {
            const flags = item.flags?.[MODULE_ID] || {};
            const isSynergy = flags.is_synergy_item;
            const subtitle = isSynergy ? "Активная Синергия" : "Навык Кристалла";
            const borderColor = isSynergy ? "#c9a75d" : "#0070dd";
            const textColor = isSynergy ? "#c9a75d" : "#5a9fe8";

            return `
            <div class="gachadnd-accordion-card">
                <div class="gachadnd-item-row" style="border-left: 4px solid ${borderColor};">
                    <img src="${item.img}" class="gachadnd-rollable" data-item-id="${item.id}" title="Применить">
                    <div class="gachadnd-item-name">
                        <span class="gachadnd-item-title">${item.name}</span>
                        <span class="gachadnd-item-subtitle" style="color: ${textColor};">${subtitle}</span>
                    </div>
                    ${this._generateUsesHtml(item)}
                </div>
                <div class="gachadnd-item-body">
                    ${descriptions.get(item.id) || '<p>Описание отсутствует.</p>'}
                </div>
            </div>
        `}).join('');
        if (!activeHtml) activeHtml = `<div style="text-align: center; color: #6b6357; padding: 40px; font-size: 1.1em;">Нет активных способностей.</div>`;
        else activeHtml = listHeaderHtml + activeHtml;

        let passiveHtml = "";
        passiveHtml += ctx.passiveCrystals.map(item => {
            return `
            <div class="gachadnd-accordion-card">
                <div class="gachadnd-item-row" style="border-left: 4px solid #4eff5c;">
                    <img src="${item.img}">
                    <div class="gachadnd-item-name">
                        <span class="gachadnd-item-title" style="color: #4eff5c;">${item.name}</span>
                        <span class="gachadnd-item-subtitle" style="color: #518c58;">Пассивный Кристалл</span>
                    </div>
                </div>
                <div class="gachadnd-item-body">
                    ${descriptions.get(item.id) || '<p>Пассивный бонус.</p>'}
                </div>
            </div>
        `}).join('');

        passiveHtml += ctx.synergyEffects.map(eff => {
            const isCyber = !!eff.flags?.[MODULE_ID]?.is_system_effect;
            const color = isCyber ? '#ff3b3b' : '#c9a75d';
            const subtitle = isCyber ? "Дебафф Системы" : "Пассивная Синергия";
            return `
            <div class="gachadnd-accordion-card">
                <div class="gachadnd-item-row" style="border-left: 4px solid ${color};">
                    <img src="${eff.img}">
                    <div class="gachadnd-item-name">
                        <span class="gachadnd-item-title" style="color: ${color};">${eff.name}</span>
                        <span class="gachadnd-item-subtitle" style="color: ${color}88;">${subtitle}</span>
                    </div>
                </div>
                <div class="gachadnd-item-body">
                    ${eff.description || '<p>Пассивный бонус активен.</p>'}
                </div>
            </div>
        `}).join('');
        
        if (!passiveHtml) passiveHtml = `<div style="text-align: center; color: #6b6357; padding: 40px; font-size: 1.1em;">Нет пассивных эффектов.</div>`;

        div.innerHTML = `
            <nav class="gachadnd-tabs" style="display: flex; background: #111; border-bottom: 1px solid #333; padding: 0 10px; font-family: 'Modesto Condensed', serif;">
                <a class="item" data-tab="memory" style="padding: 12px 15px; font-size: 1.3em; cursor: pointer; color: #b5a998; font-weight: bold; text-transform: uppercase;">Память</a>
                <a class="item" data-tab="active" style="padding: 12px 15px; font-size: 1.3em; cursor: pointer; color: #b5a998; font-weight: bold; text-transform: uppercase;">Активные</a>
                <a class="item" data-tab="passive" style="padding: 12px 15px; font-size: 1.3em; cursor: pointer; color: #b5a998; font-weight: bold; text-transform: uppercase;">Пассивные</a>
            </nav>
            <section class="gachadnd-content" style="padding: 16px; flex-grow: 1; overflow-y: auto; display: flex; flex-direction: column;">
                
                <div class="tab" data-tab="memory" style="height: 100%;">
                    <div style="display: flex; flex-direction: column; height: 100%;">
                        <div class="gachadnd-cap-counter ${ctx.isOverloaded ? 'overloaded' : ''}" style="margin-bottom: 14px; background: ${ctx.isOverloaded ? 'linear-gradient(180deg, #380d12 0%, #1a0507 100%)' : 'linear-gradient(180deg, #1c1a19 0%, #121110 100%)'}; border: 1px solid ${ctx.isOverloaded ? '#990022' : '#3d3834'}; border-radius: 4px; padding: 14px; text-align: center; font-family: 'Modesto Condensed', serif;">
                            <div style="font-size: 1.8em; color: #ede6dc;">
                                ПРЕДЕЛ РАЗУМА: 
                                <span style="font-weight: bold; color: ${ctx.isOverloaded ? '#ff3b3b' : '#4eff5c'};">${ctx.activeCount} / ${ctx.naturalCap}</span>
                            </div>
                            ${ctx.hasCyberpsychosis ? `<div style="color: #b057f5; font-size: 1.1em; margin-top: 4px;">КИБЕРПСИХОЗ ПОДАВЛЕН (Абсолютный лимит: ${ctx.absoluteCap})</div>` : ''}
                            ${ctx.isOverloaded ? `<div style="color: #ff3b3b; font-size: 1.1em; margin-top: 6px; font-weight: bold;">КРИТИЧЕСКИЙ ПЕРЕГРУЗ РАЗУМА</div>` : ''}
                        </div>
                        <div style="flex-grow: 1;">
                            ${memoryHtml}
                        </div>
                    </div>
                </div>

                <div class="tab" data-tab="active" style="height: 100%;">
                    ${activeHtml}
                </div>

                <div class="tab" data-tab="passive" style="height: 100%;">
                    ${passiveHtml}
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
            .gachadnd-terminal .window-header .close { font-size: 0 !important; margin-right: 5px; }
            .gachadnd-terminal .window-header .close i { font-size: 14px !important; margin: 0; display: inline-block; }

            .gachadnd-list-header {
                display: flex; justify-content: space-between; padding: 0 16px 8px 16px; font-size: 0.85em; 
                color: #7a7062; text-transform: uppercase; font-weight: bold; border-bottom: 1px solid #3d3834; margin-bottom: 8px;
            }

            .gachadnd-tabs .item.active { border-bottom: 2px solid #c9a75d; color: #c9a75d !important; background: rgba(201, 167, 93, 0.1); }
            .gachadnd-tabs .item:hover { color: #fff !important; }
            .gachadnd-terminal .tab { display: none; }
            .gachadnd-terminal .tab.active { display: flex; flex-direction: column; }
            
            .gachadnd-accordion-card {
                background: rgba(20,18,18,0.95); border: 1px solid #3d3834; border-radius: 4px; margin-bottom: 8px; overflow: hidden;
            }
            .gachadnd-item-row {
                display: flex; align-items: center; gap: 12px; padding: 8px 12px; cursor: pointer; transition: background 0.2s;
            }
            .gachadnd-item-row:hover { background: rgba(35,32,32,0.9); }
            .gachadnd-item-row img {
                width: 36px; height: 36px; border-radius: 4px; object-fit: cover;
            }
            .gachadnd-rollable {
                cursor: crosshair; transition: filter 0.2s; box-shadow: 0 0 0 1px transparent;
            }
            .gachadnd-rollable:hover {
                filter: brightness(1.2); box-shadow: 0 0 4px #c9a75d;
            }
            .gachadnd-item-name { flex-grow: 1; display: flex; flex-direction: column; }
            .gachadnd-item-title { font-family: 'Modesto Condensed', serif; font-weight: bold; font-size: 1.4em; color: #f5efe6; line-height: 1.1; }
            .gachadnd-item-subtitle { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.5px; }

            .gachadnd-item-body {
                display: none; padding: 12px; border-top: 1px solid #3d3834; background: #111;
                font-size: 14px; color: #c9c1b5;
            }
            .gachadnd-item-body p { margin-top: 0; margin-bottom: 8px; }
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
            });
        }

        element.querySelectorAll('.gachadnd-item-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.classList.contains('gachadnd-rollable') || e.target.classList.contains('gachadnd-uses-input')) {
                    return;
                }
                e.preventDefault();
                const body = e.currentTarget.closest('.gachadnd-accordion-card').querySelector('.gachadnd-item-body');
                body.style.display = body.style.display === 'none' ? 'block' : 'none';
            });
        });

        element.querySelectorAll('.gachadnd-uses-input').forEach(input => {
            input.addEventListener('change', async (e) => {
                e.preventDefault();
                const item = this.actor.items.get(e.currentTarget.dataset.itemId);
                if (item) {
                    const max = parseInt(e.currentTarget.dataset.max) || 0;
                    let newVal = parseInt(e.currentTarget.value);
                    if (isNaN(newVal)) newVal = max;
                    newVal = Math.max(0, Math.min(max, newVal));
                    
                    const newSpent = max - newVal;
                    await item.update({ "system.uses.spent": newSpent });
                    this.render(false);
                }
            });
        });

        element.querySelectorAll('.gachadnd-rollable').forEach(img => {
            img.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation(); 
                const item = this.actor.items.get(e.currentTarget.dataset.itemId);
                if (item) item.use();
            });
        });

        element.querySelectorAll('.gachadnd-forge-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                if (btn.disabled) return;
                btn.disabled = true;
                const item = this.actor.items.get(btn.dataset.itemId);
                if (item) await forgeSkill(this.actor, item);
                this.render(false);
            });
        });

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

                if (isActivating) currentAbsoluteCap += Number(item.flags[MODULE_ID]?.slot_bonus) || 0;
                if (isActivating && ctx.activeCount >= currentAbsoluteCap && !currentActive) {
                    ui.notifications.error(`Достигнут абсолютный предел (${currentAbsoluteCap}).`);
                    btn.disabled = false;
                    return;
                }

                await setSkillEquipped(item, isActivating);
                await updateActorSynergies(this.actor);
                this.render(false);
            });
        });
    }
}

// Перемещение отряда по карте этажа меняет доступность улучшения на Привале
Hooks.on('updateScene', (scene, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) return;
    Object.values(ui.windows).filter(w => w instanceof MemoryTerminal).forEach(w => w.render(false));
});
