/**
 * Gacha Roguelike dnd5e — Расчёт капов, Синергий и Выдача Навыков
 */

import { MODULE_ID } from "./main.js";
import { getSynergyDictionary, UNIVERSAL_DC_FORMULA, TAG_KEYS } from "./synergy-data.js";

const actorUpdateLocks = new Set();
const actorUpdatePending = new Set();

// Версия формата выдаваемых способностей синергий. Способности старой версии пересоздаются.
const SYNERGY_FEATURE_VERSION = 2;

// ==========================================
// 0. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

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
        activityData.save = { ability: [saveAbility], dc: { calculation: '', formula: String(dc) } };
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
// ЭКИПИРОВКА НАВЫКОВ
// ==========================================

// Навык Памяти: черта, полученная из кристалла или компендиума навыков
export function isMemorySkill(item) {
    const flags = item?.flags?.[MODULE_ID];
    return item?.type === 'feat' && !!flags?.skill_name && !flags.is_crystal_item && !flags.is_synergy_item;
}

// Сращённый всадник экипирован сверх лимита и слота не занимает
export function occupiesSlot(item) {
    const flags = item?.flags?.[MODULE_ID];
    return !(flags?.horseman && flags?.cleansed);
}

// Персонаж участвует в начатом бою — менять навыки нельзя (кроме Горячей замены)
export function isInCombat(actor) {
    return !!game.combats?.some(c => c.started && c.combatants.some(cb => cb.actor?.id === actor?.id));
}

// Суммарная прибавка к абсолютному лимиту слотов от экипированных навыков
export function getSlotBonus(items) {
    return items.reduce((sum, i) => sum + (Number(i.flags?.[MODULE_ID]?.slot_bonus) || 0), 0);
}

// Обновления эффектов навыка: передаваемые эффекты действуют только у экипированного навыка
function getEffectSyncUpdates(item, active) {
    return item.effects
        .filter(e => e.transfer && (e.disabled === active))
        .map(e => ({ _id: e.id, disabled: !active }));
}

export async function setSkillEquipped(item, active) {
    await item.setFlag(MODULE_ID, 'is_active', active);
    const updates = getEffectSyncUpdates(item, active);
    if (updates.length) await item.updateEmbeddedDocuments('ActiveEffect', updates);
}

// Новые навыки на листе создаются неэкипированными: их эффекты выключены до экипировки
Hooks.on('preCreateItem', (item) => {
    if (!(item.parent instanceof Actor) || !isMemorySkill(item)) return;
    if (item.flags[MODULE_ID].is_active) return;
    const effects = item._source.effects ?? [];
    if (!effects.some(e => e.transfer !== false && !e.disabled)) return;
    item.updateSource({ effects: effects.map(e => (e.transfer === false ? e : { ...e, disabled: true })) });
});

Hooks.on('gachadnd.synergyUpdated', (actor) => updateActorSynergies(actor));

// ==========================================
// 1. ГЛАВНАЯ ФУНКЦИЯ ОБНОВЛЕНИЯ АКТЕРА
// ==========================================
export async function updateActorSynergies(actor) {
    if (!actor) return;
    
    // Повторный вызов во время расчёта не теряется: расчёт перезапускается после текущего
    if (actorUpdateLocks.has(actor.id)) {
        actorUpdatePending.add(actor.id);
        return;
    }
    actorUpdateLocks.add(actor.id);

    try {
        console.log(`[GachaDND] === РАСЧЕТ СИНЕРГИЙ ЗАПУЩЕН (${actor.name}) ===`);
        
        const gachaItems = actor.items.filter(isMemorySkill);
        const activeItems = gachaItems.filter(i => i.flags[MODULE_ID]?.is_active);

        // --- 0. СИНХРОНИЗАЦИЯ ЭФФЕКТОВ С ЭКИПИРОВКОЙ ---
        for (const item of gachaItems) {
            const updates = getEffectSyncUpdates(item, !!item.flags[MODULE_ID]?.is_active);
            if (updates.length) await item.updateEmbeddedDocuments('ActiveEffect', updates);
        }

        // --- А. МАТЕМАТИКА ПЕРЕГРУЗКИ ---
        const level = actor.system.details.level || 1;
        const naturalCap = 6 + Math.floor(level / 2);
        const activeCount = activeItems.filter(occupiesSlot).length;

        const overloadCount = activeCount - naturalCap;
        const overloadEffectName = "Системная перегрузка (Киберпсихоз)";
        let existingOverload = actor.effects.find(e => e.flags?.[MODULE_ID]?.is_system_effect);

        if (overloadCount > 0) {
            const statPenalty = overloadCount * -2;
            const hpPenalty = -overloadCount * level;
            const effectData = {
                name: overloadEffectName,
                img: "icons/svg/hazard.svg",
                icon: "icons/svg/hazard.svg", // Дублируем для V11+
                description: `<p>Критический перегруз памяти! Штраф <strong>${statPenalty}</strong> к Интеллекту, Мудрости и Харизме и <strong>${hpPenalty}</strong> к максимуму ПЗ.</p>`,
                origin: actor.uuid,
                disabled: false,
                changes: [
                    { key: "system.abilities.int.value", mode: 2, value: statPenalty },
                    { key: "system.abilities.wis.value", mode: 2, value: statPenalty },
                    { key: "system.abilities.cha.value", mode: 2, value: statPenalty },
                    { key: "system.attributes.hp.bonuses.overall", mode: 2, value: String(hpPenalty) }
                ],
                flags: { [MODULE_ID]: { is_system_effect: true } }
            };

            if (existingOverload) await existingOverload.update(effectData);
            else await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
        } else if (existingOverload) {
            await existingOverload.delete();
        }

        // --- Б. РАСЧЁТ СИНЕРГИЙ И НАВЫКОВ ---
        const emittedTags = [];
        activeItems.forEach(item => {
            const flags = item.flags[MODULE_ID] || {};
            // Защита от строкового 'true'
            const isEmitter = flags.tagEmitter === true || flags.tagEmitter === "true";
            if (isEmitter && flags.emitted_tag) {
                emittedTags.push(flags.emitted_tag.toLowerCase().trim());
            }
        });
        console.log(`[GachaDND] Найдены излучаемые теги:`, emittedTags);

        const tagCounts = {};
        // Теги каждого экипированного навыка с учётом излучения — для memory_scaling
        const equippedTags = new Map();
        activeItems.forEach(item => {
            const flags = item.flags[MODULE_ID] || {};
            let currentTags = [...(flags.tags || [])].map(t => String(t).toLowerCase().trim());
            const isEmitter = flags.tagEmitter === true || flags.tagEmitter === "true";

            if (!isEmitter) {
                emittedTags.forEach(tag => {
                    if (!currentTags.includes(tag)) currentTags.push(tag);
                });
            } else if (flags.emitted_tag) {
                const myEmittedTag = flags.emitted_tag.toLowerCase().trim();
                if (!currentTags.includes(myEmittedTag)) currentTags.push(myEmittedTag);
            }

            equippedTags.set(item.id, currentTags);
            currentTags.forEach(t => {
                tagCounts[t] = (tagCounts[t] || 0) + 1;
            });
        });
        
        console.log(`[GachaDND] Итоговое количество тегов:`, tagCounts);

        const earnedSynergies = [];
        let itemsToGrant = []; 
        const currentDictionary = getSynergyDictionary(UNIVERSAL_DC_FORMULA);

        for (const [tag, config] of Object.entries(currentDictionary)) {
            const count = tagCounts[tag] || 0;
            let highestMet = null;
            let accumulatedDesc = "<ul style='margin: 0; padding-left: 15px;'>"; 
            
            for (const threshold of config.thresholds) {
                if (count >= threshold.count) {
                    accumulatedDesc += `<li style='margin-bottom: 4px;'><strong>${threshold.name}:</strong> ${threshold.desc}</li>`;
                    highestMet = threshold;
                    
                    if (threshold.grantedFeature) {
                        const featureData = createSynergyFeature(
                            `[${tag.charAt(0).toUpperCase() + tag.slice(1)}] ${threshold.name.split(': ')[1]}`, 
                            threshold.icon, 
                            threshold.desc, 
                            threshold.grantedFeature
                        );
                        featureData.flags = { [MODULE_ID]: { is_synergy_item: true, tagSource: tag, feature_version: SYNERGY_FEATURE_VERSION } };
                        itemsToGrant.push(featureData);
                    }
                }
            }
            accumulatedDesc += "</ul>";
            
            if (highestMet) {
                earnedSynergies.push({ tag, ...highestMet, fullDesc: accumulatedDesc });
            }
        }
        
        console.log(`[GachaDND] Заработанные синергии:`, earnedSynergies.map(s => s.name));

        // 1. Управление Активными Эффектами
        const synergyMarker = "Синергия: ";
        const currentSynergyEffects = actor.effects.filter(e => e.name.startsWith(synergyMarker) && e.flags?.[MODULE_ID]?.is_synergy);
        const earnedEffectNames = earnedSynergies.map(s => `${synergyMarker}[${s.name}]`);

        const effectsToDelete = [];
        const seenEffectNames = new Set();

        for (const e of currentSynergyEffects) {
            if (!earnedEffectNames.includes(e.name) || seenEffectNames.has(e.name)) {
                effectsToDelete.push(e.id);
            } else {
                seenEffectNames.add(e.name);
            }
        }

        if (effectsToDelete.length > 0) {
            await actor.deleteEmbeddedDocuments("ActiveEffect", effectsToDelete);
            console.log(`[GachaDND] Удалены старые эффекты:`, effectsToDelete.length);
        }

        const effectsToAdd = [];
        for (const syn of earnedSynergies) {
            const effectName = `${synergyMarker}[${syn.name}]`;
            if (!seenEffectNames.has(effectName)) {
                effectsToAdd.push({
                    name: effectName,
                    img: syn.icon,
                    icon: syn.icon, // КРИТИЧЕСКИЙ ФИКС ДЛЯ FOUNDRY V11+
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
            console.log(`[GachaDND] Добавлены новые эффекты:`, effectsToAdd.map(e => e.name));
        }

        // 2. Управление Выдаваемыми Предметами
        const existingGrantedItems = actor.items.filter(i => i.flags?.[MODULE_ID]?.is_synergy_item);
        const itemsToDelete = [];
        const seenItemNames = new Set();

        for (const item of existingGrantedItems) {
            const tag = item.flags[MODULE_ID].tagSource;
            const isEarned = itemsToGrant.some(grant => grant.flags[MODULE_ID].tagSource === tag && grant.name === item.name);
            const isOutdated = item.flags[MODULE_ID].feature_version !== SYNERGY_FEATURE_VERSION;

            if (!isEarned || isOutdated || seenItemNames.has(item.name)) {
                itemsToDelete.push(item.id);
            } else {
                seenItemNames.add(item.name);
            }
        }

        if (itemsToDelete.length > 0) {
            await actor.deleteEmbeddedDocuments("Item", itemsToDelete);
        }

        const itemsToCreate = [];
        itemsToGrant.forEach(grant => {
            if (!seenItemNames.has(grant.name)) {
                itemsToCreate.push(grant);
            }
        });

        if (itemsToCreate.length > 0) {
            await actor.createEmbeddedDocuments("Item", itemsToCreate);
            ui.notifications.info(`✨ Разум расширен: получены новые способности синергий!`);
        }

        await syncMemoryScaling(actor, gachaItems, activeItems, equippedTags, tagCounts);

        console.log(`[GachaDND] === РАСЧЕТ УСПЕШНО ЗАВЕРШЕН ===`);

    } catch (err) {
        console.error(`[GachaDND] ❌ КРИТИЧЕСКАЯ ОШИБКА РАСЧЕТА:`, err);
    } finally {
        actorUpdateLocks.delete(actor.id);
        if (actorUpdatePending.delete(actor.id)) await updateActorSynergies(actor);
    }
}

// ==========================================
// 2. ЭФФЕКТЫ ОТ СОСТАВА ПАМЯТИ (memory_scaling)
// ==========================================

/**
 * Экипированные навыки с memory_scaling получают эффекты на персонаже, сила которых зависит
 * от состава Памяти или экипировки. Для каждой записи:
 * число = count − offset; эффект действует, если число ≥ min и подходит по parity;
 * n = floor(число / every), не больше max ('prof' — бонус мастерства).
 * Заодно число экипированных навыков с каждым тегом пишется во флаг counts — его читают формулы бросков.
 */
function scalingCount(config, { actor, memory, equipped, equippedTags }) {
    const count = String(config.count);
    const tag = count.includes(':') ? count.slice(count.indexOf(':') + 1) : null;
    const tagsOf = item => equippedTags.get(item.id) ?? item.flags[MODULE_ID]?.tags ?? [];
    if (count === 'memory') return memory.length;
    if (count === 'burned') return actor.getFlag(MODULE_ID, 'burned_count') || 0;
    if (count === 'equipped') return equipped.length;
    if (count === 'equipped_tags') return new Set(equipped.flatMap(tagsOf)).size;
    if (count.startsWith('tag:')) return memory.filter(i => (i.flags[MODULE_ID]?.tags ?? []).includes(tag)).length;
    if (count.startsWith('equipped_tag:')) return equipped.filter(i => tagsOf(i).includes(tag)).length;
    if (count.startsWith('equipped_not_tag:')) return equipped.filter(i => !tagsOf(i).includes(tag)).length;
    return 0;
}

async function syncMemoryScaling(actor, memory, equipped, equippedTags = new Map(), tagCounts = {}) {
    const prof = actor.system.attributes?.prof ?? 2;
    const context = { actor, memory, equipped, equippedTags };
    const desired = new Map();
    for (const item of equipped) {
        const raw = item.flags[MODULE_ID]?.memory_scaling;
        if (!raw) continue;
        (Array.isArray(raw) ? raw : [raw]).forEach((config, index) => {
            const count = scalingCount(config, context) - (config.offset ?? 0);
            if (count < (config.min ?? 1)) return;
            if (config.parity === 'even' && count % 2 !== 0) return;
            if (config.parity === 'odd' && count % 2 !== 1) return;
            let n = Math.floor(count / (config.every ?? 1));
            const max = config.max === 'prof' ? prof : config.max;
            if (max !== undefined) n = Math.min(n, max);
            if (n > 0) desired.set(`${item.id}:${index}`, { item, index, n, config });
        });
    }

    const existing = actor.effects.filter(e => e.flags?.[MODULE_ID]?.memory_scaling_source);
    const toDelete = [];
    const toUpdate = [];
    for (const effect of existing) {
        const flags = effect.flags[MODULE_ID];
        const key = `${flags.memory_scaling_source}:${flags.memory_scaling_index ?? 0}`;
        const want = desired.get(key);
        if (!want) { toDelete.push(effect.id); continue; }
        if (flags.memory_scaling_n !== want.n) toUpdate.push({ _id: effect.id, ...scalingEffectData(want) });
        desired.delete(key);
    }
    if (toDelete.length) await actor.deleteEmbeddedDocuments('ActiveEffect', toDelete);
    if (toUpdate.length) await actor.updateEmbeddedDocuments('ActiveEffect', toUpdate);
    const toCreate = [...desired.values()].map(scalingEffectData);
    if (toCreate.length) await actor.createEmbeddedDocuments('ActiveEffect', toCreate);

    // Счётчики тегов для формул: @flags.gachadnd.counts.explosion и т.п.
    const counts = Object.fromEntries(Object.entries(TAG_KEYS).map(([tag, key]) => [key, tagCounts[tag] ?? 0]));
    if (!foundry.utils.objectsEqual(actor.getFlag(MODULE_ID, 'counts') ?? {}, counts)) {
        await actor.setFlag(MODULE_ID, 'counts', counts);
    }
}

function scalingEffectData({ item, index, n, config }) {
    return {
        name: `${item.name} (${n})`,
        img: item.img,
        origin: item.uuid,
        disabled: false,
        description: config.text ? `<p>${String(config.text).replaceAll('{n}', n)}</p>` : '',
        changes: (config.changes ?? []).map(c => ({ ...c, value: String(c.value).replaceAll('{n}', n) })),
        flags: { [MODULE_ID]: { memory_scaling_source: item.id, memory_scaling_index: index, memory_scaling_n: n } }
    };
}

// Состав Памяти изменился — пересчитать эффекты, зависящие от него
Hooks.on('createItem', (item, options, userId) => {
    if (game.user.id === userId && item.parent instanceof Actor && isMemorySkill(item)) updateActorSynergies(item.parent);
});

// Неиспользованная Горячая замена не переносится в следующий бой
Hooks.on('deleteCombat', (combat) => {
    if (!game.user.isGM) return;
    for (const combatant of combat.combatants) {
        if (combatant.actor?.getFlag(MODULE_ID, 'swapPending')) combatant.actor.unsetFlag(MODULE_ID, 'swapPending');
    }
});
