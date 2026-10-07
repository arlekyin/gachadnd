/**
 * Gacha Roguelike dnd5e — Обработка инвентаря и поглощения кристаллов
 */

import { MODULE_ID } from "./main.js";
import { getSynergyDictionary } from "./synergy-data.js";
import { isMemorySkill } from "./synergy.js";
import { getSkillPack, currentSkillName, crystalForSkill, buildCrystalData } from "./crystals.js";
import { getHorseman, isCleansed, hasTakenHorseman, feedHunger } from "./horsemen.js";
import { isRiskActive } from "./risk.js";

const RARITY_MAP = {
    'gray': { label: 'Серый', color: '#9d9d9d', class: 'rarity-gray' },
    'green': { label: 'Зелёный', color: '#1eff00', class: 'rarity-green' },
    'blue': { label: 'Синий', color: '#0070dd', class: 'rarity-blue' },
    'purple': { label: 'Фиолетовый', color: '#a335ee', class: 'rarity-purple' },
    'red': { label: 'Красный', color: '#ff003c', class: 'rarity-red' },
    'orange': { label: 'Оранжевый', color: '#ff8000', class: 'rarity-orange' }
};

// Вместимость Памяти: навыки на листе, включая неэкипированные; навыки с memory_bonus её расширяют, даже не экипированные
export const MEMORY_CAPACITY = 20;
export function getMemoryCapacity(actor) {
    return MEMORY_CAPACITY + actor.items
        .filter(isMemorySkill)
        .reduce((sum, i) => sum + (Number(i.flags[MODULE_ID].memory_bonus) || 0), 0);
}

// Сравнение по текущему имени навыка в компендиуме: переименование не создаёт «новый» навык
function findMemorySkill(actor, skillName) {
    const key = skillName.trim().toLowerCase();
    return actor.items.find(i => isMemorySkill(i) && currentSkillName(i.flags[MODULE_ID], i.name).trim().toLowerCase() === key);
}

export function canRankUp(item) {
    const flags = item.flags[MODULE_ID];
    if (flags.stacking) return true;
    return (flags.rank ?? 1) < (flags.max_rank ?? 1) && Array.isArray(flags.rank_data);
}

async function addBurned(actor, count) {
    await actor.setFlag(MODULE_ID, 'burned_count', (actor.getFlag(MODULE_ID, 'burned_count') || 0) + count);
    Hooks.callAll("gachadnd.synergyUpdated", actor);
}

// Повышает ранг навыка данными ранга из компендиума; расход зарядов и экипировка сохраняются
// Римская запись ранга — у навыков с бесконечными рангами он может быть любым
export function romanRank(n) {
    const table = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    for (const [value, sign] of table) while (n >= value) { out += sign; n -= value; }
    return out;
}

// Бесконечные ранги: урон = прибавка × ранг, описание пересобирается из шаблона
async function stackSkill(item) {
    const flags = item.flags[MODULE_ID];
    const rank = (flags.rank ?? 1) + 1;
    const value = String((flags.stack_base ?? 1) * rank);
    const activity = item.system.activities?.contents?.[0];
    const update = {
        [`flags.${MODULE_ID}.rank`]: rank,
        'system.description.value': String(flags.stack_template ?? '').replaceAll('{n}', value).replaceAll('{rank}', romanRank(rank))
    };
    if (activity) {
        const parts = foundry.utils.deepClone(item._source.system.activities[activity.id]?.damage?.parts ?? []);
        if (parts[0]) parts[0].custom = { ...(parts[0].custom ?? {}), enabled: true, formula: value };
        update[`system.activities.${activity.id}.damage.parts`] = parts;
    }
    await item.update(update);
    return rank;
}

async function rankUpSkill(item) {
    const flags = item.flags[MODULE_ID];
    if (flags.stacking) return stackSkill(item);
    const rank = (flags.rank ?? 1) + 1;
    const data = flags.rank_data[rank - 1];

    await item.update({
        [`flags.${MODULE_ID}.rank`]: rank,
        [`flags.${MODULE_ID}.cooldown`]: data.cooldown,
        'system.description': data.system.description,
        'system.uses': data.system.uses,
        'system.activities': data.system.activities
    });

    const effects = Array.from(item.effects);
    const updates = data.effects.map((e, i) => {
        const effect = item.effects.get(e._id) ?? (effects.length === data.effects.length ? effects[i] : null);
        return effect ? { _id: effect.id, changes: e.changes } : null;
    }).filter(Boolean);
    if (updates.length) await item.updateEmbeddedDocuments('ActiveEffect', updates);
    return rank;
}

// Данные навыка для листа: запись компендиума навыков или заглушка из описания кристалла
async function buildSkillData(skillName, { extraFlags = {}, fallbackDescription = '' } = {}) {
    let skillData = null;
    const pack = getSkillPack();

    if (pack) {
        const index = await pack.getIndex();
        const entry = (extraFlags.skill_id && index.get(extraFlags.skill_id))
            ?? index.find(i => i.name.toLowerCase() === skillName.toLowerCase());
        if (entry) skillData = (await pack.getDocument(entry._id)).toObject();
    }

    const rarity = extraFlags.rarity || skillData?.flags?.[MODULE_ID]?.rarity || 'gray';
    const imgPrefix = rarity === 'gray' ? 'grey' : rarity;
    const activeImg = skillData?.img || `modules/${MODULE_ID}/assets/icons/skills/${imgPrefix}_fog_active.webp`;

    if (!skillData) {
        skillData = {
            name: skillName,
            type: 'feat',
            img: activeImg,
            system: {
                description: { value: fallbackDescription },
                source: { custom: "Gacha Roguelike DnD5e" },
                type: { value: "feat", subtype: "" }
            }
        };
    }

    const featData = foundry.utils.duplicate(skillData);
    delete featData._id;
    featData.type = 'feat';
    featData.img = activeImg;
    featData.flags ??= {};
    // Данные навыка берутся из компендиума; флаги кристалла (могли устареть) — только для заглушки
    const fromPack = !!skillData.flags?.[MODULE_ID]?.skill_name;
    featData.flags[MODULE_ID] = {
        ...(fromPack ? skillData.flags[MODULE_ID] : extraFlags),
        is_active: false,
        skill_name: fromPack ? skillData.name : skillName
    };
    delete featData.flags[MODULE_ID].is_crystal_item;
    return featData;
}

const RANK_LABELS = ['I', 'II', 'III'];

// Сообщение в чат о повышении ранга — видно всем игрокам
export async function announceRankUp(actor, item, rank, note = '') {
    // Открытие нового ранга: его эффект игроки узнают только сейчас
    const flags = item.flags?.[MODULE_ID] ?? {};
    const revealed = flags.stacking ? `Сила навыка: ${(flags.stack_base ?? 1) * rank}` : flags.rank_texts?.[rank - 2];
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gachadnd-rank-up"><strong>⬆️ ${item.name}</strong> — ранг ${romanRank(rank)}`
            + `${revealed ? `<br>${String(revealed).replace(/&/g, '&amp;').replace(/</g, '&lt;')}` : ''}`
            + `${note ? `<br><span style="opacity: 0.75">${note}</span>` : ''}</div>`
    });
}

// Цена улучшения на Привале в Костях Хитов: ранг II — 1, ранг III — 2
export const FORGE_COST = { 2: 1, 3: 2 };

// Кости Хитов: тратятся с самых маленьких, возвращаются в самые большие
export function availableHitDice(actor) {
    return getHitDice(actor)?.value ?? 0;
}

export async function spendHitDice(actor, count) {
    const hd = getHitDice(actor);
    if (!hd || hd.value < count) return false;
    const classes = [...hd.classes].sort((a, b) =>
        parseInt(a.system.hd.denomination.slice(1)) - parseInt(b.system.hd.denomination.slice(1)));
    const updates = [];
    let left = count;
    for (const cls of classes) {
        const take = Math.min(left, cls.system.hd.value);
        if (take > 0) updates.push({ _id: cls.id, 'system.hd.spent': cls.system.hd.spent + take });
        left -= take;
        if (!left) break;
    }
    await actor.updateEmbeddedDocuments('Item', updates);
    return true;
}

export async function restoreHitDice(actor, count) {
    const hd = getHitDice(actor);
    if (!hd) return 0;
    const classes = [...hd.classes].filter(c => c.system.hd.spent > 0).sort((a, b) =>
        parseInt(b.system.hd.denomination.slice(1)) - parseInt(a.system.hd.denomination.slice(1)));
    const updates = [];
    let left = count;
    for (const cls of classes) {
        const give = Math.min(left, cls.system.hd.spent);
        if (give > 0) updates.push({ _id: cls.id, 'system.hd.spent': cls.system.hd.spent - give });
        left -= give;
        if (!left) break;
    }
    if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
    return count - left;
}

// Расход одного кристалла: стопка уменьшается, последний удаляется
export async function consumeCrystal(crystal) {
    const quantity = crystal.system?.quantity ?? 1;
    if (quantity > 1) await crystal.update({ 'system.quantity': quantity - 1 });
    else await crystal.delete();
}

function getHitDice(actor) {
    const hd = actor.system?.attributes?.hd;
    return hd?.classes ? hd : null;
}

// Кристалл пригоден для слияния: есть в количестве и не израсходован
export function isUsableCrystal(crystal) {
    if ((crystal.system?.quantity ?? 1) <= 0) return false;
    const uses = crystal.system?.uses;
    if (uses?.max) return (uses.value ?? (Number(uses.max) - (uses.spent ?? 0))) > 0;
    return true;
}

// Повторный кристалл навыка в инвентаре персонажа
export function findDuplicateCrystal(actor, item) {
    const key = currentSkillName(item.flags[MODULE_ID], item.name).trim().toLowerCase();
    return actor.items.find(i => isCrystalItem(i) && isUsableCrystal(i)
        && currentSkillName(i.flags?.[MODULE_ID], i.name).trim().toLowerCase() === key);
}

// Слияние на Привале: повторный кристалл + Кости Хитов → ранг; кости списываются с самых маленьких
export async function forgeSkill(actor, item) {
    if (!canRankUp(item)) return ui.notifications.warn(`⚠️ Навык «${item.name}» нельзя улучшить.`);
    const crystal = findDuplicateCrystal(actor, item);
    if (!crystal) return ui.notifications.warn(`⚠️ Для слияния нужен повторный кристалл «${item.name}» в инвентаре.`);
    const rank = (item.flags[MODULE_ID].rank ?? 1) + 1;
    const cost = FORGE_COST[rank] ?? 2;
    if (!(await spendHitDice(actor, cost))) return ui.notifications.warn(`⚠️ Не хватает Костей Хитов: нужно ${cost}, доступно ${availableHitDice(actor)}.`);
    await consumeCrystal(crystal);
    await rankUpSkill(item);
    await announceRankUp(actor, item, rank, `Привал: слит повторный кристалл, потрачено Костей Хитов — ${cost}`);
}

/**
 * Проверка, можно ли добавить навык в Память без принудительного режима.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkMemoryAccess(actor, skillName) {
    const existing = findMemorySkill(actor, skillName);
    if (existing) {
        if (canRankUp(existing)) return { ok: false, reason: `Навык «${skillName}» уже в Памяти. Повторный кристалл сливается с ним на Привале кнопкой «Слить» в Терминале Тумана.` };
        if ((existing.flags[MODULE_ID].max_rank ?? 1) === 1) return { ok: false, reason: `Навык «${skillName}» уникален и уже есть в Памяти.` };
        return { ok: false, reason: `Навык «${skillName}» уже в Памяти на максимальном ранге.` };
    }
    if (actor.items.filter(isMemorySkill).length >= getMemoryCapacity(actor)) {
        return { ok: false, reason: `Память персонажа ${actor.name} переполнена (максимум ${getMemoryCapacity(actor)} навыков). Освободите место.` };
    }
    return { ok: true };
}

/**
 * Добавляет навык в Память персонажа.
 * Повтор навыка повышает его ранг. В принудительном режиме (Жадность) при переполнении сгорает
 * случайный неэкипированный навык, а повтор навыка на максимальном ранге сгорает сам.
 * @returns {Promise<{ status: 'added'|'ranked'|'replaced'|'burned'|'blocked', rank?: number, replacedName?: string, reason?: string }>}
 */
export async function addSkillToMemory(actor, skillName, { forced = false, extraFlags = {}, fallbackDescription = '' } = {}) {
    const existing = findMemorySkill(actor, skillName);
    if (existing) {
        if (!forced) return { status: 'blocked', reason: checkMemoryAccess(actor, skillName).reason };
        // Повтор с доступным рангом остаётся кристаллом в инвентаре — его сливают на Привале
        if (canRankUp(existing)) return { status: 'duplicate' };
        await addBurned(actor, 1);
        return { status: 'burned' };
    }

    let replacedName;
    const memory = actor.items.filter(isMemorySkill);
    if (memory.length >= getMemoryCapacity(actor)) {
        if (!forced) return { status: 'blocked', reason: checkMemoryAccess(actor, skillName).reason };
        const candidates = memory.filter(i => !i.flags[MODULE_ID].is_active && !i.flags[MODULE_ID].undeletable);
        if (!candidates.length) {
            await addBurned(actor, 1);
            return { status: 'burned' };
        }
        const replaced = candidates[Math.floor(Math.random() * candidates.length)];
        replacedName = replaced.name;
        // Сгоревший навык учитывается в счётчике хуком deleteItem
        await replaced.delete();
    }

    await actor.createEmbeddedDocuments("Item", [await buildSkillData(skillName, { extraFlags, fallbackDescription })], { gachadndMemory: true });
    return { status: replacedName ? 'replaced' : 'added', replacedName };
}

async function absorbCrystal(actor, item) {
    if (!actor || !item) return false;

    const gachaFlags = item.flags?.[MODULE_ID] || {};
    const skillName = currentSkillName(gachaFlags, item.name);
    const { is_crystal_item, ...extraFlags } = gachaFlags;

    try {
        const result = await addSkillToMemory(actor, skillName, {
            extraFlags,
            fallbackDescription: item.system?.description?.value || ""
        });
        if (result.status === 'added') ui.notifications.info(`🧠 Кристалл «${skillName}» поглощён в Память персонажа ${actor.name}!`);
        else ui.notifications.warn(`⚠️ ${result.reason}`);
    } catch (err) {
        console.error(`❌ Ошибка поглощения кристалла:`, err);
    }

    return true;
}

export function isCrystalItem(item) {
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
        if (isRiskActive() && !game.user.isGM) {
            ui.notifications.warn('Во время испытания Риска кристаллы не поглощаются.');
            return false;
        }
        // Всадник: только один на персонажа за забег
        if (item.flags?.[MODULE_ID]?.horseman && getHorseman(actor)) {
            ui.notifications.warn(`⚠️ У персонажа ${actor.name} уже есть всадник.`);
            return false;
        }
        // Проклятый Голод: кристалл можно скормить ему вместо поглощения
        const hunger = getHorseman(actor, 'hunger');
        if (hunger && !isCleansed(hunger) && !usageConfig?.gachadndToMemory) {
            chooseHungerOrMemory(actor, item);
            return false;
        }
        const skillName = currentSkillName(item.flags?.[MODULE_ID], item.name);
        const access = checkMemoryAccess(actor, skillName);
        if (!access.ok) {
            ui.notifications.warn(`⚠️ ${access.reason}`);
            return false;
        }
    }
    
    // ПРИНУДИТЕЛЬНО вызываем стандартное диалоговое окно системы
    if (dialogConfig) {
        dialogConfig.configure = true;
    }
    
    return true; 
});

async function chooseHungerOrMemory(actor, crystal) {
    const choice = await foundry.applications.api.DialogV2.wait({
        window: { title: crystal.name },
        content: '<p>Голод ждёт. Скормить кристалл ему или поглотить навык в Память?</p>',
        buttons: [
            { action: 'feed', label: 'Скормить Голоду', icon: 'fas fa-skull', default: true },
            { action: 'memory', label: 'В Память', icon: 'fas fa-brain' }
        ],
        rejectClose: false
    });
    if (choice === 'feed') return feedHunger(actor, crystal);
    if (choice === 'memory') {
        const activity = crystal.system.activities?.contents?.[0] ?? [...(crystal.system.activities?.values?.() ?? [])][0];
        return activity?.use({ gachadndToMemory: true });
    }
}

// Навык, брошенный на лист из компендиума или с другого персонажа, становится кристаллом в инвентаре:
// в Память навык попадает только поглощением кристалла (как свиток из заклинания в dnd5e)
Hooks.on('preCreateItem', (item, data, options) => {
    if (!(item.parent instanceof Actor) || !isMemorySkill(item) || options.gachadndMemory) return;
    giveCrystal(item.parent, { skillId: item.flags[MODULE_ID].skill_id ?? item._source._id, skillName: item.flags[MODULE_ID].skill_name }, item.toObject());
    return false;
});

/**
 * Выдаёт персонажу кристалл навыка. Данные навыка — из компендиума навыков.
 * @param {Actor} actor
 * @param {{ skillId?: string, skillName?: string }} skill
 * @param {object} [fallback]  Данные навыка, если в компендиуме его нет.
 */
export async function giveCrystal(actor, skill, fallback = null) {
    const crystal = await crystalForSkill(skill) ?? (fallback ? buildCrystalData(fallback) : null);
    if (!crystal) return ui.notifications.warn(`⚠️ Навык «${skill.skillName ?? skill.skillId}» не найден в компендиуме навыков.`);
    await actor.createEmbeddedDocuments('Item', [crystal]);
    ui.notifications.info(`💎 ${crystal.name} — в инвентаре персонажа ${actor.name}.`);
}

// Копия навыка, который уже есть в Памяти, на лист не добавляется
Hooks.on('preCreateItem', (item) => {
    if (!(item.parent instanceof Actor) || !isMemorySkill(item)) return;
    const skillName = currentSkillName(item.flags[MODULE_ID], item.name);
    const existing = findMemorySkill(item.parent, skillName);
    if (!existing) return;
    ui.notifications.warn(`⚠️ ${checkMemoryAccess(item.parent, skillName).reason}`);
    return false;
});

// Личный эффект уникального навыка: хранится в копии навыка на листе персонажа,
// компендиум и копии у других персонажей не меняются
const PERSONAL_BLOCK = /<div class="gd-personal">[\s\S]*?<\/div>/;
export async function setPersonalEffect(item, text) {
    const clean = String(text ?? '').trim();
    const paragraphs = clean
        ? clean.split(/\n\s*\n/).map((p, i) => `<p>${i === 0 ? '<strong>Личный эффект:</strong> ' : ''}${foundry.utils.escapeHTML ? foundry.utils.escapeHTML(p) : p.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</p>`.replace(/\n/g, '<br>')).join('')
        : '<p><strong>Личный эффект:</strong> не определён. Определяется Мастером вместе с игроком при получении навыка.</p>';
    const block = `<div class="gd-personal">${paragraphs}</div>`;
    const description = item.system.description?.value ?? '';
    const value = PERSONAL_BLOCK.test(description) ? description.replace(PERSONAL_BLOCK, block) : `${description}\n${block}`;
    await item.update({ 'system.description.value': value, [`flags.${MODULE_ID}.personal_effect`]: clean });
}

// Неудаляемые навыки (Битый сектор): удалить может только Мастер
Hooks.on('preDeleteItem', (item) => {
    if (!isMemorySkill(item) || !item.flags[MODULE_ID].undeletable || game.user.isGM) return;
    ui.notifications.error('Файл повреждён.');
    return false;
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
    ui.notifications.info(`🔥 Навык «${item.name}» сожжён.`);
    // Удаление навыка из Памяти — сожжение: растёт счётчик (Легенда Найт-Сити),
    // а синергии и эффекты от состава Памяти пересчитываются
    addBurned(actor, 1);
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