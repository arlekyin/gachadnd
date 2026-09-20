/**
 * Gacha Roguelike dnd5e — Обработка инвентаря и поглощения кристаллов
 */

import { MODULE_ID } from "./main.js";

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
        const entry = index.find(i => i.name.toLowerCase() === skillName.toLowerCase());
        if (entry) {
            const skillDoc = await pack.getDocument(entry._id);
            skillData = skillDoc.toObject();
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

    featData.flags[MODULE_ID] = {
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
        console.log(`✅ [GachaDND] Черта «${skillName}» успешно создана у актера ${actor.name}`);
        ui.notifications.info(`🧠 Кристалл «${skillName}» поглощён в Память персонажа ${actor.name}!`);
    } catch (err) {
        console.error(`❌ Ошибка создания черты на листе персонажа:`, err);
    }

    // Удаление кристалла теперь автоматически обрабатывается самой системой Foundry 
    // через consumable consumption, нам больше не нужно его удалять скриптом!
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

    const gachaFlags = item.flags?.[MODULE_ID];
    if (gachaFlags && gachaFlags.is_active) {
        ui.notifications.info(`🗑️ Навык «${item.name}» удалён из Памяти.`);
    }
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