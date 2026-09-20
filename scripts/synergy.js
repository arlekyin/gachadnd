/**
 * Gacha Roguelike dnd5e — Расчёт капов, Синергий и Выдача Навыков
 */

import { MODULE_ID } from "./main.js";
import { getSynergyDictionary } from "./synergy-data.js"; // <--- Подключаем наши тексты

// ==========================================
// 0. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

function getUniversalDC(actor) {
    if (!actor || !actor.system || !actor.system.abilities) return 10;
    let maxMod = -5;
    for (const [key, ability] of Object.entries(actor.system.abilities)) {
        if (ability.mod > maxMod) maxMod = ability.mod;
    }
    const prof = actor.system.attributes.prof || 2;
    return 8 + maxMod + prof;
}

// Генератор шаблона для выдаваемой способности (Feat) для D&D 5e (v3.x+)
function createSynergyFeature(name, icon, description, featureData) {
    const activityId = foundry.utils.randomID ? foundry.utils.randomID() : Math.random().toString(36).substring(2, 10);
    const { actionType, saveAbility, dc, damageParts, target } = featureData;
    
    let activityType = 'utility';
    if (saveAbility) activityType = 'save';
    else if (damageParts && damageParts.some(p => p[1] === 'healing' || p[1] === 'temphp')) activityType = 'heal';
    else if (damageParts) activityType = 'damage';

    let activityData = {
        _id: activityId,
        type: activityType,
        name: 'Применить',
        activation: { type: actionType || 'special', value: 1, condition: '' },
        consumption: { targets: [] },
        uses: { spent: 0, max: '', recovery: [] }
    };

    if (target) {
        if (target.type === 'creature') {
            activityData.target = { affects: { type: "creature", count: target.value ? String(target.value) : "1" } };
        } else {
            activityData.target = { template: { count: 1, type: target.type || 'radius', size: target.value ? String(target.value) : '', units: target.units || 'ft' } };
        }
    }

    if (saveAbility) {
        activityData.save = { ability: [saveAbility], dc: { calculation: 'custom', formula: String(dc) } };
    }

    if (damageParts && damageParts.length > 0) {
        if (activityType === 'heal') {
            activityData.healing = { custom: { enabled: true, formula: String(damageParts[0][0]) }, types: [damageParts[0][1]] };
        } else {
            activityData.damage = { parts: damageParts.map(p => ({ custom: { enabled: true, formula: String(p[0]) }, types: [p[1]] })) };
        }
    }

    return {
        name: name,
        type: 'feat',
        img: icon,
        system: {
            description: { value: `<p>${description}</p>` },
            activities: { [activityId]: activityData }
        }
    };
}

// ==========================================
// 1. ГЛАВНАЯ ФУНКЦИЯ ОБНОВЛЕНИЯ АКТЕРА
// ==========================================
export async function updateActorSynergies(actor) {
    if (!actor) return;

    const gachaItems = actor.items.filter(i => i.flags?.[MODULE_ID]?.skill_name);
    const activeItems = gachaItems.filter(i => i.flags[MODULE_ID].is_active);
    
    // --- А. МАТЕМАТИКА ПЕРЕГРУЗКИ ---
    const level = actor.system.details.level || 1;
    const naturalCap = 6 + Math.floor(level / 2);
    const hasCyberpsychosis = activeItems.some(i => i.flags[MODULE_ID].skill_name === 'Киберпсихоз');
    const absoluteCap = naturalCap + (hasCyberpsychosis ? 4 : 0);
    const activeCount = activeItems.length;

    const overloadCount = activeCount - naturalCap;
    const overloadEffectName = "Системная перегрузка (Киберпсихоз)";
    let existingOverload = actor.effects.find(e => e.name === overloadEffectName);

    if (overloadCount > 0) {
        const statPenalty = overloadCount * -2;
        const effectData = {
            name: overloadEffectName,
            img: "icons/svg/hazard.svg",
            description: `<p>Критический перегруз памяти! Штраф <strong>${statPenalty}</strong> к Интеллекту, Мудрости и Харизме.</p>`,
            origin: actor.uuid,
            disabled: false,
            changes: [
                { key: "system.abilities.int.value", mode: 2, value: statPenalty },
                { key: "system.abilities.wis.value", mode: 2, value: statPenalty },
                { key: "system.abilities.cha.value", mode: 2, value: statPenalty }
            ],
            flags: { [MODULE_ID]: { is_system_effect: true } }
        };

        if (existingOverload) await existingOverload.update(effectData);
        else await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
    } else if (existingOverload) {
        await existingOverload.delete();
    }

    // --- Б. РАСЧЁТ СИНЕРГИЙ И НАВЫКОВ ---
    const tagCounts = {};
    activeItems.forEach(item => {
        const tags = item.flags[MODULE_ID].tags || [];
        tags.forEach(t => {
            const lowerTag = t.toLowerCase().trim();
            tagCounts[lowerTag] = (tagCounts[lowerTag] || 0) + 1;
        });
    });

    const earnedSynergies = [];
    let itemsToGrant = []; 
    const currentDc = getUniversalDC(actor);
    const currentDictionary = getSynergyDictionary(currentDc);

    for (const [tag, config] of Object.entries(currentDictionary)) {
        const count = tagCounts[tag] || 0;
        let highestMet = null;
        let accumulatedDesc = "<ul style='margin: 0; padding-left: 15px;'>"; 
        
        for (const threshold of config.thresholds) {
            if (count >= threshold.count) {
                accumulatedDesc += `<li style='margin-bottom: 4px;'><strong>${threshold.name}:</strong> ${threshold.desc}</li>`;
                highestMet = threshold;
                
                // Генерируем активный навык (оружие/кнопку), если в базе есть grantedFeature
                if (threshold.grantedFeature) {
                    const featureData = createSynergyFeature(
                        `[${tag.charAt(0).toUpperCase() + tag.slice(1)}] ${threshold.name.split(': ')[1]}`, 
                        threshold.icon, 
                        threshold.desc, 
                        threshold.grantedFeature
                    );
                    featureData.flags = { [MODULE_ID]: { is_synergy_item: true, tagSource: tag } };
                    itemsToGrant.push(featureData);
                }
            }
        }
        accumulatedDesc += "</ul>";
        
        if (highestMet) {
            earnedSynergies.push({ tag, ...highestMet, fullDesc: accumulatedDesc });
        }
    }

    // 1. Управление Активными Эффектами (Пассивные бонусы)
    const synergyMarker = "Синергия: ";
    const currentSynergyEffects = actor.effects.filter(e => e.name.startsWith(synergyMarker) && e.flags?.[MODULE_ID]?.is_synergy);
    const currentEffectNames = currentSynergyEffects.map(e => e.name);
    const earnedEffectNames = earnedSynergies.map(s => `${synergyMarker}[${s.name}]`);

    const effectsToDelete = currentSynergyEffects.filter(e => !earnedEffectNames.includes(e.name)).map(e => e.id);
    if (effectsToDelete.length > 0) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", effectsToDelete);
    }

    const effectsToAdd = [];
    for (const syn of earnedSynergies) {
        const effectName = `${synergyMarker}[${syn.name}]`;
        if (!currentEffectNames.includes(effectName)) {
            effectsToAdd.push({
                name: effectName,
                img: syn.icon,
                description: syn.fullDesc, 
                origin: actor.uuid,
                disabled: false,
                changes: syn.changes || [],
                flags: { [MODULE_ID]: { is_synergy: true } }
            });
        }
    }

    if (effectsToAdd.length > 0) {
        await actor.createEmbeddedDocuments("ActiveEffect", effectsToAdd);
    }

    // 2. Управление Выдаваемыми Предметами (Активные кнопки)
    const existingGrantedItems = actor.items.filter(i => i.flags?.[MODULE_ID]?.is_synergy_item);
    const itemsToDelete = [];

    existingGrantedItems.forEach(item => {
        const tag = item.flags[MODULE_ID].tagSource;
        const shouldKeep = itemsToGrant.some(grant => grant.flags[MODULE_ID].tagSource === tag && grant.name === item.name);
        if (!shouldKeep) {
            itemsToDelete.push(item.id);
        }
    });

    if (itemsToDelete.length > 0) {
        await actor.deleteEmbeddedDocuments("Item", itemsToDelete);
    }

    const itemsToCreate = [];
    itemsToGrant.forEach(grant => {
        const alreadyHas = existingGrantedItems.some(i => i.name === grant.name && i.flags[MODULE_ID].tagSource === grant.flags[MODULE_ID].tagSource);
        if (!alreadyHas) {
            itemsToCreate.push(grant);
        }
    });

    if (itemsToCreate.length > 0) {
        await actor.createEmbeddedDocuments("Item", itemsToCreate);
        ui.notifications.info(`✨ Разум расширен: получены новые способности синергий!`);
    }
}

// ==========================================
// 2. ХУКИ ДЛЯ АВТОМАТИЗАЦИИ (БЕЗОПАСНЫЕ)
// ==========================================

Hooks.on('updateItem', (item, changes, options, userId) => {
    if (!item.actor || game.user.id !== userId) return;
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.is_active`)) {
        updateActorSynergies(item.actor);
    }
});

Hooks.on('deleteItem', (item, options, userId) => {
    if (!item.actor || game.user.id !== userId) return;
    const gachaFlags = item.flags?.[MODULE_ID];
    if (gachaFlags && gachaFlags.is_active) {
        setTimeout(() => updateActorSynergies(item.actor), 100); 
    }
});