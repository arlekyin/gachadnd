/**
 * Gacha Roguelike dnd5e — Мрачный Терминал Памяти
 */

import { MODULE_ID } from "./main.js";

export class MemoryTerminal extends Application {
    constructor(actor, options = {}) {
        super(options);
        this.actor = actor;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "gachadnd-memory-terminal",
            template: null,
            width: 440,
            height: 560,
            resizable: true,
            classes: ["dnd5e2", "gachadnd-terminal", "gacha-dark-theme"]
        });
    }

    get title() {
        return `Память Разума: ${this.actor.name}`;
    }

    getData() {
        const actor = this.actor;
        const level = actor.system.details.level || 1;
        const naturalCap = 6 + Math.floor(level / 2);
        
        // Ищем на листе персонажа ТОЛЬКО выданные черты-навыки (исключая физические предметы-кристаллы)
        const gachaItems = actor.items.filter(i => i.type === 'feat' && i.flags?.[MODULE_ID]?.skill_name);
        const activeItems = gachaItems.filter(i => i.flags[MODULE_ID]?.is_active);
        const hasCyberpsychosis = activeItems.some(i => i.flags[MODULE_ID]?.skill_name === 'Киберпсихоз');
        const absoluteCap = naturalCap + (hasCyberpsychosis ? 4 : 0);
        const activeCount = activeItems.length;
        const isOverloaded = activeCount > naturalCap;

        return { actor, level, naturalCap, gachaItems, activeItems, hasCyberpsychosis, absoluteCap, activeCount, isOverloaded };
    }

    async _renderInner(data) {
        const ctx = this.getData();
        const div = document.createElement("div");
        div.className = "gachadnd-terminal-wrapper";
        div.style.cssText = "padding: 14px; display: flex; flex-direction: column; gap: 12px; height: 100%; box-sizing: border-box; background: #0b0a0a; color: #d0c9c0; font-family: 'Modesto Condensed', serif;";

        let itemsHtml = ctx.gachaItems.map(item => {
            const flags = item.flags[MODULE_ID] || {};
            const isActive = flags.is_active;
            const category = flags.category || 'НАВЫК';
            const tags = (flags.tags || []).join(', ');
            const rarity = flags.rarity || 'gray';

            const rarityColors = {
                gray: '#7f7f7f', green: '#1eff00', blue: '#0070dd', 
                purple: '#a335ee', red: '#ff003c', orange: '#ff8000'
            };
            const borderColor = rarityColors[rarity] || '#444';

            // Иконка теперь берется напрямую из свойств черты и НЕ сбрасывается при деактивации
            const customImg = item.img;

            return `
                <div class="gachadnd-terminal-item" style="display: flex; align-items: center; justify-content: space-between; background: linear-gradient(90deg, rgba(20,18,18,0.9) 0%, rgba(10,9,9,0.95) 100%); padding: 8px 12px; border-radius: 4px; border: 1px solid ${isActive ? borderColor : '#2a2626'}; box-shadow: ${isActive ? `inset 0 0 8px rgba(0,0,0,0.8), 0 0 6px ${borderColor}44` : 'none'}; transition: all 0.2s ease;">
                    <div style="display: flex; align-items: center; gap: 12px; overflow: hidden;">
                        <img src="${customImg}" style="width: 40px; height: 40px; border-radius: 3px; border: 1px solid ${borderColor}; box-shadow: 0 2px 4px rgba(0,0,0,0.5); flex-shrink: 0;">
                        <div style="overflow: hidden;">
                            <div style="font-weight: bold; font-size: 1.15em; color: ${isActive ? '#f5efe6' : '#8c8275'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.5px;">${item.name}</div>
                            <div style="font-size: 0.8em; color: #7a7062; text-transform: uppercase; letter-spacing: 1px;">${category} ${tags ? `• [${tags}]` : ''}</div>
                        </div>
                    </div>
                    <button type="button" class="gachadnd-toggle-btn" data-item-id="${item.id}" style="width: 100px; padding: 6px; background: ${isActive ? 'linear-gradient(180deg, #183318 0%, #0d1a0d 100%)' : 'linear-gradient(180deg, #222 0%, #111 100%)'}; color: ${isActive ? '#4eff5c' : '#776e62'}; border: 1px solid ${isActive ? '#2da83b' : '#333'}; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 0.85em; text-transform: uppercase; letter-spacing: 1px; box-shadow: 0 2px 4px rgba(0,0,0,0.4);">
                        ${isActive ? 'Экипирован'  : 'В Памяти'}
                    </button>
                </div>
            `;
        }).join('');
        // ... (дальше код рендеринга без изменений)

        if (ctx.gachaItems.length === 0) {
            itemsHtml = `<div style="text-align: center; color: #6b6357; padding: 40px; font-style: italic; font-size: 1.1em;">Разум пуст. Поглотите кристаллы тумана из инвентаря.</div>`;
        }

        div.innerHTML = `
            <div class="gachadnd-cap-counter ${ctx.isOverloaded ? 'overloaded' : ''}" style="position: relative; background: ${ctx.isOverloaded ? 'linear-gradient(180deg, #380d12 0%, #1a0507 100%)' : 'linear-gradient(180deg, #1c1a19 0%, #121110 100%)'}; border: 1px solid ${ctx.isOverloaded ? '#990022' : '#3d3834'}; border-radius: 4px; padding: 12px; text-align: center; box-shadow: inset 0 0 10px rgba(0,0,0,0.6);">
                
                <!-- НОВАЯ КНОПКА ПРАВИЛ -->
                <button type="button" id="gachadnd-help-btn" style="position: absolute; top: 8px; right: 8px; background: transparent; border: 1px solid #7a7062; color: #7a7062; border-radius: 50%; width: 24px; height: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s;" title="Правила и Синергии">
                    <i class="fas fa-question" style="font-size: 12px;"></i>
                </button>

                <div style="font-size: 1.4em; letter-spacing: 1px; color: #ede6dc;">
                    <i class="fas fa-brain" style="color: ${ctx.isOverloaded ? '#ff3b3b' : '#c2b59b'};"></i> ПРЕДЕЛ РАЗУМА: 
                    <span style="font-weight: bold; color: ${ctx.isOverloaded ? '#ff3b3b' : '#4eff5c'};">${ctx.activeCount} / ${ctx.naturalCap}</span>
                </div>
                ${ctx.hasCyberpsychosis ? `<div style="color: #b057f5; font-size: 0.9em; font-weight: bold; margin-top: 3px; letter-spacing: 0.5px;">КИБЕРПСИХОЗ ПОДАВЛЕН (Абсолютный лимит: ${ctx.absoluteCap})</div>` : ''}
                ${ctx.isOverloaded ? `<div style="color: #ff3b3b; font-size: 0.85em; font-weight: bold; margin-top: 5px; text-transform: uppercase; letter-spacing: 1.5px; text-shadow: 0 0 6px rgba(255,0,60,0.5);">⚠️ КРИТИЧЕСКИЙ ПЕРЕГРУЗ РАЗУМА</div>` : ''}
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px; overflow-y: auto; flex-grow: 1; padding-right: 2px;">
                ${itemsHtml}
            </div>
        `;
        
        return $(div);
    }

    activateListeners(html) {
        super.activateListeners(html);
        const element = html instanceof jQuery ? html[0] : html;

        // Обработчик кнопки помощи
        const helpBtn = element.querySelector('#gachadnd-help-btn');
        if (helpBtn) {
            helpBtn.addEventListener('mouseenter', () => { helpBtn.style.color = '#ffaa00'; helpBtn.style.borderColor = '#ffaa00'; });
            helpBtn.addEventListener('mouseleave', () => { helpBtn.style.color = '#7a7062'; helpBtn.style.borderColor = '#7a7062'; });
            helpBtn.addEventListener('click', async () => {
                const journalName = "Правила Тумана";
                
                // 1. Сначала ищем журнал в мире (если Мастер захотел сделать свои хоумрулы)
                let rulebook = game.journal.getName(journalName);
                
                // 2. Если в мире журнала нет, ищем в "коробочном" компендиуме модуля
                if (!rulebook) {
                    const pack = game.packs.get(`${MODULE_ID}.gacha-rules`);
                    if (pack) {
                        // Загружаем документы из компендиума
                        const docs = await pack.getDocuments();
                        rulebook = docs.find(d => d.name === journalName);
                    }
                }

                // 3. Открываем найденный журнал
                if (rulebook) {
                    rulebook.sheet.render(true);
                } else {
                    ui.notifications.warn(`⚠️ Справочник "${journalName}" не найден ни в мире, ни в компендиуме модуля!`);
                }
            });
        }

        element.querySelectorAll('.gachadnd-toggle-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const itemId = btn.dataset.itemId;
                const item = this.actor.items.get(itemId);
                if (!item) return;

                const ctx = this.getData();
                const currentActive = item.flags[MODULE_ID]?.is_active || false;
                const isActivating = !currentActive;
                let currentAbsoluteCap = ctx.absoluteCap;

                if (isActivating && item.flags[MODULE_ID]?.skill_name === 'Киберпсихоз') {
                    currentAbsoluteCap += 4;
                }

                if (isActivating && ctx.activeCount >= currentAbsoluteCap && !currentActive) {
                    ui.notifications.error(`🧠 Разум трещит по швам! Достигнут абсолютный предел (${currentAbsoluteCap}).`);
                    return;
                }

                await item.setFlag(MODULE_ID, 'is_active', isActivating);
                this.render(false);
            });
        });
    }
}




