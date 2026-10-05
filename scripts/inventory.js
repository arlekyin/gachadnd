/**
 * Gacha Roguelike dnd5e — Обработка инвентаря и поглощения кристаллов
 */

import { MODULE_ID } from "./main.js";
import { getSynergyDictionary } from "./synergy-data.js";
import { isMemorySkill } from "./synergy.js";

const RARITY_MAP = {
    'gray': { label: 'Серый', color: '#9d9d9d', class: 'rarity-gray' },
    'green': { label: 'Зелёный', color: '#1eff00', class: 'rarity-green' },
    'blue': { label: 'Синий', color: '#0070dd', class: 'rarity-blue' },
    'purple': { label: 'Фиолетовый', color: '#a335ee', class: 'rarity-purple' },
    'red': { label: 'Красный', color: '#ff003c', class: 'rarity-red' },
    'orange': { label: 'Оранжевый', color: '#ff8000', class: 'rarity-orange' }
};

function generate16CharID() {
    return foundry.utils.randomID ? foundry.utils.randomID() : Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
}

async function absorbCrystal(actor, item) {
    if (!actor || !item) return false;

    const gachaFlags = item.flags?.gachadnd || {};
    const skillName = gachaFlags.skill_name || item.name.replace(/^Кристалл:\s*/, '');
    console.log(`🎲 [GachaDND Absorb] Поглощение предмета "${item.name}" (Навык: "${skillName}") для персонажа ${actor.name}`);

    let skillData = null;
    const pack = game.packs.get(`${MODULE_ID}.gacha-skills`) || game.packs.get('world.gacha-skills');
    
    if (pack) {
        const index = await pack.getIndex();
        const entries = index.filter(i => i.name.toLowerCase() === skillName.toLowerCase());
        
        if (entries.length > 0) {
            const docs = await Promise.all(entries.map(e => pack.getDocument(e._id)));
            
            // Умная сортировка: берем самый полный навык (игнорируя пустые копии)
            docs.sort((a, b) => {
                const scoreA = (a.flags?.[MODULE_ID] ? 10 : 0) + ((a.system?.description?.value?.length || 0) > 20 ? 5 : 0);
                const scoreB = (b.flags?.[MODULE_ID] ? 10 : 0) + ((b.system?.description?.value?.length || 0) > 20 ? 5 : 0);
                return scoreB - scoreA;
            });
            
            skillData = docs[0].toObject();
        }
    }

    const rarity = gachaFlags.rarity || 'gray';
    const imgPrefix = rarity === 'gray' ? 'grey' : rarity;
    const activeImg = skillData?.img || `modules/${MODULE_ID}/assets/icons/skills/${imgPrefix}_fog_active.webp`;

    if (!skillData) {
        skillData = {
            name: skillName,
            type: 'feat',
            img: activeImg,
            system: {
                description: { value: item.system?.description?.value || "" },
                source: "Gacha Roguelike DnD5e",
                type: { value: "feat", subtype: "" }
            }
        };
    }

    const featData = foundry.utils.duplicate(skillData);
    delete featData._id; 
    featData.type = 'feat';
    featData.img = activeImg; 

    if (!featData.flags) featData.flags = {};
    
    const newFlags = foundry.utils.duplicate(gachaFlags);
    delete newFlags.is_crystal_item;

    const compendiumFlags = skillData.flags?.[MODULE_ID] || {};

    featData.flags[MODULE_ID] = {
        ...compendiumFlags, 
        ...newFlags,        
        is_active: false, 
        skill_name: skillName
    };

    if (featData.system && featData.system.activities) {
        const newActivities = {};
        for (const [actKey, actVal] of Object.entries(featData.system.activities)) {
            const newActId = generate16CharID();
            const actCopy = foundry.utils.duplicate(actVal);
            actCopy._id = newActId;
            newActivities[newActId] = actCopy;
        }
        featData.system.activities = newActivities;
    }

    try {
        await actor.createEmbeddedDocuments("Item", [featData]);
        ui.notifications.info(`🧠 Кристалл «${skillName}» поглощён в Память персонажа ${actor.name}!`);
    } catch (err) {
        console.error(`❌ Ошибка создания черты на листе персонажа:`, err);
    }

    return true;
}

function isCrystalItem(item) {
    if (!item) return false;
    const isCrystal = item.getFlag(MODULE_ID, 'is_crystal_item');
    return isCrystal || item.name.startsWith('Кристалл:');
}

// ==========================================
// ХУКИ: ПОДТВЕРЖДЕНИЕ И ИСПОЛЬЗОВАНИЕ
// ==========================================

Hooks.on('dnd5e.preUseActivity', (activity, usageConfig, dialogConfig) => {
    const item = activity.item;
    if (!isCrystalItem(item)) return true;

    const actor = item.actor;
    if (actor) {
        const currentMemoryCount = actor.items.filter(i => i.type === 'feat' && i.flags?.[MODULE_ID]?.skill_name).length;
        if (currentMemoryCount >= 20) {
            ui.notifications.warn(`⚠️ Память персонажа ${actor.name} переполнена! (Максимум 20 навыков). Освободите место.`);
            return false;
        }
    }
    
    // ПРИНУДИТЕЛЬНО вызываем стандартное диалоговое окно системы
    if (dialogConfig) {
        dialogConfig.configure = true;
    }
    
    return true; 
});

Hooks.on('dnd5e.postUseActivity', (activity, usageConfig, results) => {
    const item = activity.item;
    if (!isCrystalItem(item)) return;
    
    if (item.actor) {
        absorbCrystal(item.actor, item);
    }
});

Hooks.on('deleteItem', (item, options, userId) => {
    if (game.user.id !== userId) return;
    const actor = item.actor;
    if (!actor) return;

    if (!isMemorySkill(item)) return;
    ui.notifications.info(`🗑️ Навык «${item.name}» удалён из Памяти.`);
    // Пересчёт нужен, только если навык участвовал в синергиях
    const flags = item.flags[MODULE_ID];
    if (flags.is_active || flags.tagEmitter) Hooks.callAll("gachadnd.synergyUpdated", actor);
});

// ==========================================
// КРАСИВАЯ КАРТОЧКА В ЧАТЕ
// ==========================================
function renderCustomCard(message, htmlElement) {
    const itemData = message.flags?.dnd5e?.itemData || {};
    const gachaFlags = itemData.flags?.gachadnd || message.flags?.gachadnd || {};

    if (!gachaFlags || !gachaFlags.rarity) return;

    const rarity = gachaFlags.rarity || 'gray';
    const rarityInfo = RARITY_MAP[rarity] || RARITY_MAP['gray'];
    const itemName = itemData.name || message.item?.name || 'Кристалл Памяти';
    const itemImg = itemData.img || message.item?.img || 'icons/svg/item-bag.svg';
    const category = gachaFlags.category || 'НАВЫК';
    const tags = gachaFlags.tags || [];

    const tagsHtml = tags.map(t => `<span class="gachadnd-tag">[${t}]</span>`).join(' ');

    const customCardHtml = `
        <div class="gachadnd-chat-card ${rarityInfo.class}">
            <div class="gachadnd-card-header">
                <img class="gachadnd-card-icon" src="${itemImg}" />
                <div class="gachadnd-card-title-box">
                    <h3 class="gachadnd-card-title">${itemName}</h3>
                    <span class="gachadnd-card-subtitle" style="color: ${rarityInfo.color};">
                        💎 Кристалл Памяти • ${rarityInfo.label}
                    </span>
                </div>
            </div>

            <div class="gachadnd-tags-container">
                <span class="gachadnd-category-badge">${category}</span>${tagsHtml}
            </div>

            <div class="gachadnd-card-description">
                <p>Кристалл успешно поглощен и интегрирован в нейросеть.</p>
            </div>
        </div>
    `;

    if (htmlElement instanceof HTMLElement) {
        const content = htmlElement.querySelector('.message-content');
        if (content) content.innerHTML = customCardHtml;
    } else if (htmlElement && htmlElement.find) {
        const content = htmlElement.find('.message-content');
        if (content.length) content.html(customCardHtml);
    }
}

if (Hooks.events['renderChatMessageHTML']) {
    Hooks.on('renderChatMessageHTML', (message, html) => renderCustomCard(message, html));
} else {
    Hooks.on('renderChatMessage', (message, html) => renderCustomCard(message, html));
}
// ==========================================
// УНИВЕРСАЛЬНЫЙ ДИСПЕТЧЕР МЕХАНИК ПРИ ВЗЯТИИ
// ==========================================
Hooks.on('createItem', async (item, options, userId) => {
    // Реагируем только если предмет создался у нас на клиенте
    if (game.user.id !== userId) return;
    if (item.type !== 'feat') return;
    
    const flags = item.flags?.[MODULE_ID];
    console.log(`[GachaDND] Хук createItem пойман для: ${item.name}`);
    console.log(`[GachaDND] Флаги предмета:`, flags);

    if (!flags) return;

    // 1. Универсальная логика для излучателей тегов
    if (flags.tagEmitter && !flags.emitted_tag) {
        console.log(`[GachaDND] ⚙️ Обнаружен модуль-излучатель! Запускаем окно настройки...`);
        
        const actor = item.actor;
        if (!actor) return;

        try {
            // Пробуем загрузить словарь
            const synergyDict = getSynergyDictionary(10); 
            if (!synergyDict) throw new Error("Словарь синергий пуст или не загрузился!");
            
            const officialTags = Object.keys(synergyDict);
            const optionsHtml = officialTags.map(t => 
                `<option value="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</option>`
            ).join('');

            new Dialog({
                title: `Настройка: ${item.name}`,
                content: `
                    <form autocomplete="off" style="padding-bottom: 10px;">
                        <p><strong>Навык интегрирован в Память!</strong></p>
                        <p>Этот модуль требует калибровки спектра излучения.</p>
                        
                        <div class="form-group">
                            <label>Тег для трансляции:</label>
                            <div class="form-fields">
                                <select id="emitter-tag">
                                    <option value="" disabled selected>-- Выберите тег --</option>
                                    ${optionsHtml}
                                </select>
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <label>Или свой тег:</label>
                            <div class="form-fields">
                                <input type="text" id="emitter-custom-tag" placeholder="Например: пустота">
                            </div>
                        </div>
                    </form>
                `,
                buttons: {
                    apply: {
                        icon: '<i class="fas fa-sliders-h"></i>',
                        label: "Запустить модуль",
                        callback: async (html) => {
                            const customTag = html.find('#emitter-custom-tag').val().trim().toLowerCase();
                            const selectedTag = html.find('#emitter-tag').val();
                            const finalTag = customTag || selectedTag;

                            if (!finalTag) {
                                ui.notifications.warn("Тег не выбран!");
                                return;
                            }

                            await item.setFlag(MODULE_ID, 'emitted_tag', finalTag);
                            
                            await item.update({
                                name: `${item.name.replace(/\s*\[.*?\]/, '')} [${finalTag}]`,
                                'system.description.value': `<p><strong>Излучает тег:</strong> ${finalTag}</p><hr>` + item.system.description.value
                            });

                            ui.notifications.info(`⚙️ Модуль настроен на тег: [${finalTag}]`);
                            Hooks.callAll("gachadnd.synergyUpdated", actor);
                        }
                    }
                },
                default: "apply"
            }).render(true);
            
        } catch (error) {
            console.error(`[GachaDND] ❌ Ошибка при вызове окна Сингулярности:`, error);
            ui.notifications.error("Ошибка окна настройки! Проверьте консоль (F12).");
        }
    } else if (flags.tagEmitter && flags.emitted_tag) {
        console.log(`[GachaDND] Модуль уже имеет тег: ${flags.emitted_tag}. Окно не требуется.`);
    }
});