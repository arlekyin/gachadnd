/**
 * Gacha Roguelike dnd5e — Генератор лута и гачи (Интерфейс Мастера)
 */

import { MODULE_ID } from "./main.js";
import { isMemorySkill } from "./synergy.js";
import { addSkillToMemory } from "./inventory.js";

const RARITY_WEIGHTS = {
    'gray': 600,
    'green': 250,
    'blue': 100,
    'purple': 40,
    'red': 9,
    'orange': 1
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
    const source = skill._source || skill;
    const flags = source.flags?.[MODULE_ID] || {};
    
    const rarity = flags.rarity || 'gray';
    const category = flags.category || 'УТИЛИТА';
    const tags = flags.tags || [];
    
    const fileColor = rarity === 'gray' ? 'grey' : rarity;
    const skillDesc = source.system?.description?.value || "";
    const actId = generateActivityId();
    
    const itemData = {
        name: `Кристалл: ${source.name}`,
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
                skill_name: source.name,
                rarity: rarity,
                category: category,
                tags: tags
            }
        }
    };

    await actor.createEmbeddedDocuments("Item", [itemData]);
    ui.notifications.info(`💎 Кристалл «${source.name}» выдан персонажу ${actor.name}`);
}

// ==========================================
// СИНХРОНИЗАТОР КОМПЕНДИУМОВ (АВТО-СБОРКА)
// ==========================================
async function syncCrystalsCompendium() {
    const skillPack = game.packs.get(`${MODULE_ID}.gacha-skills`) || game.packs.get('world.gacha-skills');
    const itemPack = game.packs.get(`${MODULE_ID}.gacha-items`) || game.packs.get('world.gacha-items');

    if (!skillPack || !itemPack) {
        return ui.notifications.error("❌ Компендиумы не найдены.");
    }

    ui.notifications.info("🔄 Начинаю чистую пересборку базы кристаллов...");

    const wasLocked = itemPack.locked;
    if (wasLocked) await itemPack.configure({ locked: false });

    const index = await itemPack.getIndex({ force: true });
    const oldIds = index.map(i => i._id);
    if (oldIds.length > 0) {
        await Item.deleteDocuments(oldIds, { pack: itemPack.collection });
    }

    const skills = await skillPack.getDocuments();
    
    // УМНЫЙ ФИЛЬТР: Выбор лучшей версии навыка, если есть пустышки
    const uniqueSkillsMap = new Map();
    skills.forEach(skill => {
        const source = skill._source || skill;
        const cleanName = source.name?.trim().toLowerCase();
        if (!cleanName) return;

        let score = 0;
        const flags = source.flags?.[MODULE_ID];
        const desc = source.system?.description?.value || "";

        if (flags) score += 10;
        if (flags?.rarity) score += 5;
        if (desc.includes("Категория:")) score += 10;
        if (desc.length > 20) score += 5;

        const existing = uniqueSkillsMap.get(cleanName);
        const existingScore = existing ? existing.score : -1;

        if (score > existingScore) {
            uniqueSkillsMap.set(cleanName, { skill, score });
        }
    });

    const uniqueSkills = Array.from(uniqueSkillsMap.values()).map(v => v.skill);
    console.log(`[GachaDND] Умный фильтр: из ${skills.length} записей отобрано ${uniqueSkills.length} полных.`);

    const crystalsData = uniqueSkills.map(skill => {
        const source = skill._source || skill;
        const flags = source.flags?.[MODULE_ID] || {};
        
        const rarity = flags.rarity || 'gray';
        const category = flags.category || 'УТИЛИТА';
        const tags = flags.tags || [];
        
        const fileColor = rarity === 'gray' ? 'grey' : rarity;
        const skillDesc = source.system?.description?.value || "";
        const actId = generateActivityId();

        return {
            _id: source._id,
            name: `Кристалл: ${source.name}`,
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
                    skill_name: source.name,
                    rarity: rarity,
                    category: category,
                    tags: tags
                }
            }
        };
    });

    if (crystalsData.length > 0) {
        await Item.createDocuments(crystalsData, { pack: itemPack.collection, keepId: true });
    }

    if (wasLocked) await itemPack.configure({ locked: true });
    ui.notifications.info(`✅ База очищена! Создано ровно ${crystalsData.length} уникальных кристаллов.`);
}

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
    let filtered = docs.filter(d => {
        const flags = d._source?.flags?.[MODULE_ID] || d.flags?.[MODULE_ID] || {};
        return flags.rarity === rarity;
    });

    if (requiredTag) {
        const req = requiredTag.toLowerCase();
        filtered = filtered.filter(d => {
            const flags = d._source?.flags?.[MODULE_ID] || d.flags?.[MODULE_ID] || {};
            const tags = flags.tags || [];
            return tags.some(t => t.toLowerCase().includes(req));
        });
        
        if (filtered.length === 0) {
            filtered = docs.filter(d => {
                const flags = d._source?.flags?.[MODULE_ID] || d.flags?.[MODULE_ID] || {};
                const tags = flags.tags || [];
                return tags.some(t => t.toLowerCase().includes(req));
            });
        }
    }

    if (filtered.length === 0) return docs[Math.floor(Math.random() * docs.length)] || null;
    return filtered[Math.floor(Math.random() * filtered.length)];
}

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

    get title() { return `Генератор Лута (Мастер)`; }

    async _renderInner(data) {
        const activePlayersCount = game.users.filter(u => u.active && !u.isGM).length || 4;
        const div = document.createElement("div");
        div.style.cssText = "padding: 18px; display: flex; flex-direction: column; gap: 16px; background: #0b0a0a; color: #d0c9c0; font-family: 'Modesto Condensed', serif; box-sizing: border-box;";
        div.innerHTML = `
            <div style="text-align: center; border-bottom: 1px solid #3d3834; padding-bottom: 12px;">
                <div style="font-size: 1.6em; color: #ede6dc; letter-spacing: 1px;"><i class="fas fa-gem" style="color: #ffaa00;"></i> ПРИЗЫВ ТУМАНА</div>
            </div>
            <div>
                <label style="display: block; font-size: 1.15em; color: #8c8275; margin-bottom: 6px;">Тип завершенной комнаты:</label>
                <select id="gacha-room-type" style="width: 100%; background: #161414; color: #f5efe6; border: 1px solid #3d3834; height: 30px; border-radius: 4px;">
                    <option value="normal">Обычная комната (25% на игрока)</option>
                    <option value="elite">Элитный противник (50% на игрока)</option>
                    <option value="boss">Босс (100% на игрока)</option>
                    <option value="cursed">Проклятая комната (150% на игрока)</option>
                </select>
            </div>
            <div>
                <label style="display: block; font-size: 1.15em; color: #8c8275; margin-bottom: 6px;">Фильтр редкости:</label>
                <select id="gacha-rarity-filter" style="width: 100%; background: #161414; color: #f5efe6; border: 1px solid #3d3834; height: 30px; border-radius: 4px;">
                    <option value="any">Без фильтра (Стандартные шансы гачи)</option>
                    <option style="color: #9d9d9d;" value="gray">Только Серые</option>
                    <option style="color: #1eff00;" value="green">Только Зелёные</option>
                    <option style="color: #0070dd;" value="blue">Только Синие</option>
                    <option style="color: #a335ee;" value="purple">Только Фиолетовые</option>
                    <option style="color: #ff003c;" value="red">Только Красные</option>
                </select>
            </div>
            <div>
                <label style="display: block; font-size: 1.15em; color: #8c8275; margin-bottom: 6px;">Игроков:</label>
                <div style="display: flex; align-items: center; background: #161414; border: 1px solid #3d3834; border-radius: 4px; padding: 4px 6px; height: 30px;">
                    <input type="number" id="gacha-player-count" value="${activePlayersCount}" min="1" max="10" style="width: 100%; background: transparent; color: #f5efe6; border: none; outline: none;">
                </div>
            </div>
            <button type="button" id="gacha-generate-btn" style="margin-top: 5px; padding: 12px; background: linear-gradient(180deg, #38250d 0%, #1a1105 100%); border: 1px solid #ffaa00; border-radius: 4px; color: #ffaa00; font-size: 1.25em; font-weight: bold; cursor: pointer;">
                <i class="fas fa-dice-d20"></i> Сгенерировать добычу
            </button>
            <hr style="border-color: #3d3834; margin: 10px 0;">
            <button type="button" id="gacha-sync-btn" style="padding: 10px; background: linear-gradient(180deg, #183318 0%, #0d1a0d 100%); border: 1px solid #2da83b; border-radius: 4px; color: #4eff5c; font-size: 1.1em; font-weight: bold; cursor: pointer;">
                <i class="fas fa-sync-alt"></i> Синхронизировать кристаллы
            </button>
        `;
        return $(div);
    }

    activateListeners(html) {
        super.activateListeners(html);
        const element = html instanceof jQuery ? html[0] : html;

        element.querySelector('#gacha-generate-btn').addEventListener('click', async (e) => {
            e.preventDefault();
            const roomType = element.querySelector('#gacha-room-type').value;
            const rarityFilter = element.querySelector('#gacha-rarity-filter').value;
            const players = parseInt(element.querySelector('#gacha-player-count').value) || 1;
            await this.generateLoot(roomType, players, rarityFilter);
            this.close();
        });

        element.querySelector('#gacha-sync-btn').addEventListener('click', async (e) => {
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
            if (rarityFilter === 'any') targetRarity = rollRarity(template.bonusRoll, template.excludeOrange);

            const item = await getRandomCrystalByRarity(targetRarity, template.requiredTag);
            if (item) {
                const flags = item._source?.flags?.[MODULE_ID] || item.flags?.[MODULE_ID] || {};
                drops.push({ item, rarity: flags.rarity || targetRarity });
            }
        }

        const targets = canvas.tokens.controlled;
        const targetActor = targets.length === 1 ? targets[0].actor : null;

        if (targetActor && drops.length > 0) {
            await targetActor.createEmbeddedDocuments("Item", drops.map(d => d.item.toObject()));
        }

        const forced = await this.applyForcedLoot(template, rarityFilter);
        await this.printLootCard(template.name, drops, targetActor, forced);
    }

    // Жадность: персонажи с экипированным навыком forced_loot получают кристаллы сразу в Память, без выбора
    async applyForcedLoot(template, rarityFilter) {
        const results = [];
        const actors = game.actors.filter(a => a.type === 'character' && a.hasPlayerOwner);

        for (const actor of actors) {
            const count = actor.items
                .filter(i => isMemorySkill(i) && i.flags[MODULE_ID].is_active)
                .reduce((sum, i) => sum + (Number(i.flags[MODULE_ID].forced_loot) || 0), 0);

            for (let i = 0; i < count; i++) {
                const rarity = rarityFilter === 'any' ? rollRarity(template.bonusRoll, template.excludeOrange) : rarityFilter;
                const crystal = await getRandomCrystalByRarity(rarity, template.requiredTag);
                if (!crystal) continue;

                const { is_crystal_item, ...extraFlags } = crystal._source?.flags?.[MODULE_ID] || {};
                const skillName = extraFlags.skill_name || crystal.name.replace(/^Кристалл:\s*/, '');
                const result = await addSkillToMemory(actor, skillName, {
                    forced: true,
                    extraFlags,
                    fallbackDescription: crystal.system?.description?.value || ''
                });
                if (result.status === 'duplicate') await actor.createEmbeddedDocuments('Item', [crystal.toObject()]);
                results.push({ actor, skillName, rarity: extraFlags.rarity || rarity, ...result });
            }
        }
        return results;
    }

    async printLootCard(roomName, drops, targetActor, forced = []) {
        let contentHtml = ``;
        if (drops.length === 0) {
            contentHtml = `<div style="text-align: center; padding: 15px; color: #7a7062;">Ничего ценного...</div>`;
        } else {
            contentHtml = drops.map(d => {
                const color = RARITY_COLORS[d.rarity] || '#aaa';
                const flags = d.item._source?.flags?.[MODULE_ID] || d.item.flags?.[MODULE_ID] || {};
                const tags = (flags.tags || []).join(', ');
                const customImg = `modules/${MODULE_ID}/assets/icons/skills/${d.rarity === 'gray' ? 'grey' : d.rarity}_fog_crystall.webp`;

                return `
                    <div style="display: flex; align-items: center; gap: 12px; background: #111; padding: 8px; border: 1px solid ${color}; border-radius: 4px; margin-bottom: 8px;">
                        <img src="${customImg}" style="width: 40px; height: 40px; border-radius: 3px; border: 1px solid ${color};">
                        <div>
                            <div style="font-weight: bold; color: ${color}; font-size: 1.15em;">${d.item.name}</div>
                            <div style="font-size: 0.8em; color: #8c8275;">${flags.category || 'УТИЛИТА'} ${tags ? `• [${tags}]` : ''}</div>
                        </div>
                    </div>`;
            }).join('');
        }

        const forcedText = {
            added: () => 'занесён в Память',
            duplicate: () => 'повтор — кристалл в инвентаре, слияние на Привале',
            replaced: r => `занесён в Память, сгорел «${r.replacedName}»`,
            burned: () => 'сгорел'
        };
        const forcedHtml = forced.length ? `
            <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2626;">
                <div style="color: #ff003c; text-align: center; margin-bottom: 6px;">ЖАДНОСТЬ</div>
                ${forced.map(r => `<div style="font-size: 0.9em; color: #d0c9c0;"><strong>${r.actor.name}:</strong> <span style="color: ${RARITY_COLORS[r.rarity] || '#aaa'};">${r.skillName}</span> — ${forcedText[r.status]?.(r) ?? r.status}</div>`).join('')}
            </div>` : '';

        const statusText = targetActor ? `<span style="color: #1eff00;">Предметы добавлены: <strong>${targetActor.name}</strong></span>` : `<span style="color: #ffaa00;">Токен не выделен.</span>`;

        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: "Туманный Разлом" }),
            content: `
            <div style="background: #0b0a0a; border: 2px solid #3d3834; border-radius: 6px; padding: 12px; font-family: 'Modesto Condensed', serif;">
                <h3 style="text-align: center; color: #ede6dc; margin-bottom: 12px;">ДОБЫЧА: <span style="color: #ffaa00;">${roomName.toUpperCase()}</span></h3>
                ${contentHtml}
                <div style="text-align: center; margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2626;">${statusText}</div>
                ${forcedHtml}
            </div>`
        });
    }
}