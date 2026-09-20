/**
 * Gacha Roguelike dnd5e — Генератор лута и гачи (Интерфейс Мастера)
 */

import { MODULE_ID } from "./main.js";

const RARITY_WEIGHTS = {
    'gray': 600,   // 60.0%
    'green': 250,  // 25.0%
    'blue': 100,   // 10.0%
    'purple': 40,  // 4.0%
    'red': 9,      // 0.9%
    'orange': 1    // 0.1%
};

const RARITY_COLORS = {
    'gray': '#7f7f7f', 'green': '#1eff00', 'blue': '#0070dd', 
    'purple': '#a335ee', 'red': '#ff003c', 'orange': '#ff8000'
};

const ROOM_TEMPLATES = {
    'normal': { name: 'Обычная комната', chancePerPlayer: 0.25, bonusRoll: false },
    'elite': { name: 'Элитный противник', chancePerPlayer: 0.5, bonusRoll: true },
    'boss': { name: 'Босс', chancePerPlayer: 1.0, bonusRoll: true },
    'cursed': { name: 'Проклятая комната', chancePerPlayer: 1.5, bonusRoll: false, excludeOrange: true, requiredTag: 'проклят' }
};

function generateActivityId() {
    return foundry.utils.randomID ? foundry.utils.randomID() : Math.random().toString(36).substring(2, 10);
}

// ==========================================
// УНИВЕРСАЛЬНАЯ ФАБРИКА СБОРКИ КРИСТАЛЛА
// ==========================================
export async function giveCrystalToActor(actor, skill) {
    const flags = skill.flags[MODULE_ID] || {};
    const rarity = flags.rarity || 'gray';
    const fileColor = rarity === 'gray' ? 'grey' : rarity;
    const skillDesc = skill.system?.description?.value || "";
    const actId = generateActivityId();
    
    const itemData = {
        name: `Кристалл: ${skill.name}`,
        type: 'consumable',
        img: `modules/${MODULE_ID}/assets/icons/skills/${fileColor}_fog_crystall.webp`,
        system: {
            description: { 
                value: `<p>Сожмите кристалл в руке, чтобы поглотить этот навык.</p><hr>${skillDesc}` 
            },
            consumableType: 'potion',
            uses: { value: 1, max: 1, per: 'charges', autoDestroy: true },
            activities: {
                [actId]: {
                    _id: actId,
                    type: 'utility',
                    name: 'Поглотить кристалл',
                    activation: { type: 'special', value: 1, condition: '' },
                    consumption: { targets: [{ type: 'itemUses', value: 1 }] },
                    uses: { spent: 0, max: '' }
                }
            }
        },
        flags: {
            [MODULE_ID]: {
                is_crystal_item: true,
                skill_name: skill.name,
                rarity: rarity,
                category: flags.category || 'УТИЛИТА',
                tags: flags.tags || []
            }
        }
    };

    await actor.createEmbeddedDocuments("Item", [itemData]);
    ui.notifications.info(`💎 Кристалл «${skill.name}» выдан персонажу ${actor.name}`);
}

// ==========================================
// СИНХРОНИЗАТОР КОМПЕНДИУМОВ (АВТО-СБОРКА)
// ==========================================
async function syncCrystalsCompendium() {
    const skillPack = game.packs.get(`${MODULE_ID}.gacha-skills`) || game.packs.get('world.gacha-skills');
    const itemPack = game.packs.get(`${MODULE_ID}.gacha-items`) || game.packs.get('world.gacha-items');

    if (!skillPack || !itemPack) {
        return ui.notifications.error("❌ Компендиумы не найдены. Проверьте module.json");
    }

    ui.notifications.info("🔄 Начинаю пересборку базы кристаллов...");

    const wasLocked = itemPack.locked;
    if (wasLocked) await itemPack.configure({ locked: false });

    const oldIds = itemPack.index.map(i => i._id);
    if (oldIds.length > 0) {
        await itemPack.documentClass.deleteDocuments(oldIds, { pack: itemPack.collection });
    }

    const skills = await skillPack.getDocuments();
    const crystalsData = skills.map(skill => {
        const flags = skill.flags[MODULE_ID] || {};
        const rarity = flags.rarity || 'gray';
        const fileColor = rarity === 'gray' ? 'grey' : rarity;
        const skillDesc = skill.system?.description?.value || "";
        const actId = generateActivityId();

        return {
            name: `Кристалл: ${skill.name}`,
            type: 'consumable',
            img: `modules/${MODULE_ID}/assets/icons/skills/${fileColor}_fog_crystall.webp`,
            system: {
                description: { 
                    value: `<p>Сожмите кристалл в руке, чтобы поглотить этот навык.</p><hr>${skillDesc}` 
                },
                consumableType: 'potion',
                uses: { value: 1, max: 1, per: 'charges', autoDestroy: true },
                activities: {
                    [actId]: {
                        _id: actId,
                        type: 'utility',
                        name: 'Поглотить кристалл',
                        activation: { type: 'special', value: 1, condition: '' },
                        consumption: { targets: [{ type: 'itemUses', value: 1 }] },
                        uses: { spent: 0, max: '' }
                    }
                }
            },
            flags: {
                [MODULE_ID]: {
                    is_crystal_item: true,
                    skill_name: skill.name,
                    rarity: rarity,
                    category: flags.category || 'УТИЛИТА',
                    tags: flags.tags || []
                }
            }
        };
    });

    if (crystalsData.length > 0) {
        await itemPack.documentClass.createDocuments(crystalsData, { pack: itemPack.collection });
    }

    if (wasLocked) await itemPack.configure({ locked: true });

    ui.notifications.info(`✅ База успешно обновлена! Создано ${crystalsData.length} кристаллов.`);
}

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ГЕНЕРАЦИИ
// ==========================================
function rollRarity(bonusRoll = false, excludeOrange = false) {
    let weights = { ...RARITY_WEIGHTS };
    if (bonusRoll) delete weights['gray'];
    if (excludeOrange) delete weights['orange'];

    let totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    let roll = Math.floor(Math.random() * totalWeight) + 1;
    
    for (const [rarity, weight] of Object.entries(weights)) {
        if (roll <= weight) return rarity;
        roll -= weight;
    }
    return bonusRoll ? 'green' : 'gray'; 
}

async function getRandomCrystalByRarity(rarity, requiredTag = null) {
    const pack = game.packs.get(`${MODULE_ID}.gacha-items`) || game.packs.get('world.gacha-items');
    if (!pack) return null;

    const docs = await pack.getDocuments();
    let filtered = docs.filter(d => d.flags?.[MODULE_ID]?.rarity === rarity);

    if (requiredTag) {
        filtered = filtered.filter(d => {
            const tags = d.flags?.[MODULE_ID]?.tags || [];
            return tags.some(t => t.toLowerCase().includes(requiredTag));
        });
        if (filtered.length === 0) {
            filtered = docs.filter(d => {
                const tags = d.flags?.[MODULE_ID]?.tags || [];
                return tags.some(t => t.toLowerCase().includes(requiredTag));
            });
        }
    }

    if (filtered.length === 0) return docs[Math.floor(Math.random() * docs.length)] || null;
    return filtered[Math.floor(Math.random() * filtered.length)];
}

// ==========================================
// ИНТЕРФЕЙС МАСТЕРА
// ==========================================
export class GachaLootTerminal extends Application {
    constructor(options = {}) {
        super(options);
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "gachadnd-loot-terminal",
            template: null,
            width: 380,
            height: "auto",
            resizable: false,
            classes: ["dnd5e2", "gacha-dark-theme"]
        });
    }

    get title() {
        return `Генератор Лута (Мастер)`;
    }

    async _renderInner(data) {
        const activePlayersCount = game.users.filter(u => u.active && !u.isGM).length || 4;

        const div = document.createElement("div");
        div.style.cssText = "padding: 18px; display: flex; flex-direction: column; gap: 16px; background: #0b0a0a; color: #d0c9c0; font-family: 'Modesto Condensed', serif; box-sizing: border-box;";

        div.innerHTML = `
            <div style="text-align: center; border-bottom: 1px solid #3d3834; padding-bottom: 12px;">
                <div style="font-size: 1.6em; color: #ede6dc; letter-spacing: 1px;"><i class="fas fa-gem" style="color: #ffaa00;"></i> ПРИЗЫВ ТУМАНА</div>
                <div style="font-size: 0.9em; color: #7a7062; letter-spacing: 0.5px; text-transform: uppercase;">Система распределения добычи</div>
            </div>

            <!-- СЕКЦИЯ: СЛУЧАЙНАЯ ГЕНЕРАЦИЯ -->
            <div>
                <label style="display: block; font-size: 1.15em; color: #8c8275; margin-bottom: 6px;">Тип завершенной комнаты:</label>
                <select id="gacha-room-type" style="width: 100%; background: #161414; color: #f5efe6; border: 1px solid #3d3834; height: 30px; border-radius: 4px; outline: none; cursor: pointer;">
                    <option style="background: #161414; color: #f5efe6;" value="normal">Обычная комната (25% на игрока)</option>
                    <option style="background: #161414; color: #f5efe6;" value="elite">Элитный противник (50% на игрока)</option>
                    <option style="background: #161414; color: #f5efe6;" value="boss">Босс (100% на игрока)</option>
                    <option style="background: #161414; color: #f5efe6;" value="cursed">Проклятая комната (150% на игрока)</option>
                </select>
            </div>

            <div>
                <label style="display: block; font-size: 1.15em; color: #8c8275; margin-bottom: 6px;">Фильтр редкости (Принудительно):</label>
                <select id="gacha-rarity-filter" style="width: 100%; background: #161414; color: #f5efe6; border: 1px solid #3d3834; height: 30px; border-radius: 4px; outline: none; cursor: pointer;">
                    <option style="background: #161414; color: #f5efe6;" value="any">Без фильтра (Стандартные шансы гачи)</option>
                    <option style="background: #161414; color: #9d9d9d;" value="gray">Только Серые (Обычные)</option>
                    <option style="background: #161414; color: #1eff00;" value="green">Только Зелёные (Необычные)</option>
                    <option style="background: #161414; color: #0070dd;" value="blue">Только Синие (Редкие)</option>
                    <option style="background: #161414; color: #a335ee;" value="purple">Только Фиолетовые (Эпические)</option>
                    <option style="background: #161414; color: #ff003c;" value="red">Только Красные (Легендарные)</option>
                </select>
            </div>

            <div>
                <label style="display: block; font-size: 1.15em; color: #8c8275; margin-bottom: 6px;">Количество активных игроков:</label>
                <div style="display: flex; align-items: center; background: #161414; border: 1px solid #3d3834; border-radius: 4px; padding: 4px 6px; height: 30px; box-sizing: border-box;">
                    <i class="fas fa-users" style="color: #c2b59b; margin: 0 10px;"></i>
                    <input type="number" id="gacha-player-count" value="${activePlayersCount}" min="1" max="10" style="width: 100%; background: transparent; color: #f5efe6; border: none; outline: none; height: 100%;">
                </div>
            </div>

            <button type="button" id="gacha-generate-btn" style="margin-top: 5px; padding: 12px; background: linear-gradient(180deg, #38250d 0%, #1a1105 100%); border: 1px solid #ffaa00; border-radius: 4px; color: #ffaa00; font-size: 1.25em; font-weight: bold; cursor: pointer; text-transform: uppercase; letter-spacing: 1.5px; box-shadow: 0 0 12px rgba(255, 170, 0, 0.2); transition: all 0.2s ease;">
                <i class="fas fa-dice-d20"></i> Сгенерировать добычу
            </button>

            <!-- СЕКЦИЯ: ОБСЛУЖИВАНИЕ БАЗЫ -->
            <hr style="border-color: #3d3834; margin: 10px 0;">
            <button type="button" id="gacha-sync-btn" style="padding: 10px; background: linear-gradient(180deg, #183318 0%, #0d1a0d 100%); border: 1px solid #2da83b; border-radius: 4px; color: #4eff5c; font-size: 1.1em; font-weight: bold; cursor: pointer; text-transform: uppercase; letter-spacing: 1px; transition: all 0.2s ease;">
                <i class="fas fa-sync-alt"></i> Синхронизировать кристаллы
            </button>
            <div style="text-align: center; font-size: 0.8em; color: #5a5348; margin-top: 6px; line-height: 1.2;">
                Нажмите эту кнопку, если вы изменили навыки в компендиуме, чтобы обновить физические кристаллы.
            </div>
        `;

        return $(div);
    }

    activateListeners(html) {
        super.activateListeners(html);
        const element = html instanceof jQuery ? html[0] : html;

        const genBtn = element.querySelector('#gacha-generate-btn');
        genBtn.addEventListener('mouseenter', () => genBtn.style.boxShadow = '0 0 18px rgba(255, 170, 0, 0.5)');
        genBtn.addEventListener('mouseleave', () => genBtn.style.boxShadow = '0 0 12px rgba(255, 170, 0, 0.2)');

        const syncBtn = element.querySelector('#gacha-sync-btn');
        syncBtn.addEventListener('mouseenter', () => syncBtn.style.boxShadow = '0 0 15px rgba(78, 255, 92, 0.4)');
        syncBtn.addEventListener('mouseleave', () => syncBtn.style.boxShadow = 'none');

        genBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            const roomType = element.querySelector('#gacha-room-type').value;
            const rarityFilter = element.querySelector('#gacha-rarity-filter').value;
            const players = parseInt(element.querySelector('#gacha-player-count').value) || 1;
            
            await this.generateLoot(roomType, players, rarityFilter);
            this.close();
        });

        syncBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            await syncCrystalsCompendium();
        });
    }

    async generateLoot(roomType, players, rarityFilter) {
        const template = ROOM_TEMPLATES[roomType] || ROOM_TEMPLATES['normal'];
        const totalChance = players * template.chancePerPlayer;
        const guaranteedDrops = Math.floor(totalChance);
        const fractionalChance = totalChance - guaranteedDrops;
        
        let dropsCount = guaranteedDrops;
        if (Math.random() <= fractionalChance) dropsCount += 1;

        const drops = [];
        for (let i = 0; i < dropsCount; i++) {
            let targetRarity = rarityFilter;
            if (rarityFilter === 'any') {
                targetRarity = rollRarity(template.bonusRoll, template.excludeOrange);
            }

            const item = await getRandomCrystalByRarity(targetRarity, template.requiredTag);
            if (item) {
                const actualRarity = item.flags?.[MODULE_ID]?.rarity || targetRarity;
                drops.push({ item, rarity: actualRarity });
            }
        }

        const targets = canvas.tokens.controlled;
        const targetActor = targets.length === 1 ? targets[0].actor : null;

        if (targetActor && drops.length > 0) {
            const itemsToCreate = drops.map(d => d.item.toObject());
            await targetActor.createEmbeddedDocuments("Item", itemsToCreate);
        }

        await this.printLootCard(template.name, drops, targetActor);
    }

    async printLootCard(roomName, drops, targetActor) {
        let contentHtml = ``;

        if (drops.length === 0) {
            contentHtml = `<div style="text-align: center; padding: 15px; color: #7a7062; font-style: italic; font-size: 1.1em;">Среди пыли и тумана не нашлось ничего ценного...</div>`;
        } else {
            contentHtml = drops.map(d => {
                const color = RARITY_COLORS[d.rarity] || '#aaa';
                const category = d.item.flags?.[MODULE_ID]?.category || 'УТИЛИТА';
                const tags = (d.item.flags?.[MODULE_ID]?.tags || []).join(', ');
                
                const fileColor = d.rarity === 'gray' ? 'grey' : d.rarity;
                const customImg = `modules/${MODULE_ID}/assets/icons/skills/${fileColor}_fog_crystall.webp`;

                return `
                    <div class="gacha-drop-item" style="display: flex; align-items: center; gap: 12px; background: linear-gradient(90deg, rgba(20,18,18,0.9) 0%, rgba(10,9,9,0.95) 100%); padding: 8px 10px; border: 1px solid ${color}; border-radius: 4px; margin-bottom: 8px; box-shadow: inset 0 0 10px ${color}22;">
                        <img src="${customImg}" style="width: 40px; height: 40px; border-radius: 3px; border: 1px solid ${color}; box-shadow: 0 2px 4px rgba(0,0,0,0.5);">
                        <div style="flex-grow: 1;">
                            <div style="font-weight: bold; color: ${color}; font-size: 1.15em; text-shadow: 0 0 6px ${color}66; letter-spacing: 0.5px;">${d.item.name}</div>
                            <div style="font-size: 0.8em; color: #8c8275; text-transform: uppercase;">${category} ${tags ? `• [${tags}]` : ''}</div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        const statusText = targetActor 
            ? `<span style="color: #1eff00;"><i class="fas fa-check"></i> Предметы добавлены в инвентарь: <strong>${targetActor.name}</strong></span>`
            : `<span style="color: #ffaa00;"><i class="fas fa-exclamation-triangle"></i> Токен не выделен. Достаньте предметы из компендиума вручную.</span>`;

        const chatHtml = `
            <div class="gacha-loot-card" style="background: #0b0a0a; border: 2px solid #3d3834; border-radius: 6px; padding: 12px; font-family: 'Modesto Condensed', serif;">
                <div style="text-align: center; border-bottom: 1px solid #2a2626; padding-bottom: 8px; margin-bottom: 12px;">
                    <h3 style="margin: 0; color: #ede6dc; font-size: 1.5em; letter-spacing: 1px;"><i class="fas fa-chest"></i> ДОБЫЧА: <span style="color: #ffaa00;">${roomName.toUpperCase()}</span></h3>
                </div>
                ${contentHtml}
                <div style="text-align: center; font-size: 0.9em; margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2626;">
                    ${statusText}
                </div>
            </div>
        `;

        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: "Туманный Разлом" }),
            content: chatHtml
        });
    }
}