/**
 * Gacha Roguelike dnd5e — Кристаллы
 *
 * Кристалл — упаковка навыка, а не отдельная запись: он собирается на лету из компендиума навыков.
 * Единственный источник данных — gacha-skills (собирается из YAML). Связь кристалла с навыком — id навыка
 * в компендиуме (флаг skill_id), поэтому переименование навыка не ломает уже выданные кристаллы.
 */

import { MODULE_ID } from "./main.js";

export function getSkillPack() {
    return game.packs.get(`${MODULE_ID}.gacha-skills`) || game.packs.get('world.gacha-skills');
}

export function crystalImage(rarity) {
    // У оранжевых всадников пока нет своей иконки
    const file = { gray: 'grey', orange: 'red' }[rarity] ?? rarity;
    return `modules/${MODULE_ID}/assets/icons/skills/${file}_fog_crystall.webp`;
}

// Старые имена переименованных навыков — для кристаллов, выданных до появления skill_id
const RENAMED = {
    'брайн-данс': 'Брейнданс',
    'я особенный!': 'Думаешь, ты особенный?'
};

/**
 * Текущее имя навыка, на который ссылается кристалл или навык в Памяти.
 * Синхронно: индекс компендиума загружен при запуске мира. Без skill_id или вне индекса — имя из флага.
 */
export function currentSkillName(flags = {}, fallbackName = '') {
    const entry = flags.skill_id ? getSkillPack()?.index?.get(flags.skill_id) : null;
    if (entry) return entry.name;
    const name = flags.skill_name ?? fallbackName.replace(/^Кристалл:\s*/, '');
    return RENAMED[name.trim().toLowerCase()] ?? name;
}

// Данные кристалла из документа навыка компендиума
export function buildCrystalData(skill) {
    const source = skill._source ?? skill;
    const flags = source.flags?.[MODULE_ID] ?? {};
    const rarity = flags.rarity || 'gray';
    const activityId = foundry.utils.randomID();
    return {
        name: `Кристалл: ${source.name}`,
        type: 'consumable',
        img: crystalImage(rarity),
        system: {
            description: { value: `<p>Сожмите кристалл в руке, чтобы поглотить этот навык.</p><hr>${source.system?.description?.value ?? ''}` },
            type: { value: 'potion', subtype: '' },
            quantity: 1,
            uses: { spent: 0, max: '1', recovery: [], autoDestroy: true },
            activities: {
                [activityId]: {
                    _id: activityId,
                    type: 'utility',
                    name: 'Поглотить кристалл',
                    activation: { type: 'special', value: null, condition: '' },
                    consumption: { targets: [{ type: 'itemUses', target: '', value: '1' }] }
                }
            }
        },
        flags: {
            [MODULE_ID]: {
                is_crystal_item: true,
                skill_id: source._id,
                skill_name: source.name,
                rarity,
                category: flags.category ?? '',
                tags: flags.tags ?? [],
                ...(flags.horseman ? { horseman: flags.horseman } : {})
            }
        }
    };
}

/**
 * Случайный кристалл заданной редкости. requiredTag — подстрока тега (Проклятая комната);
 * если навыков с тегом этой редкости нет, тег важнее редкости, а без тега — любой навык.
 * @returns {Promise<object|null>} Данные кристалла для createEmbeddedDocuments.
 */
export async function randomCrystal(rarity, requiredTag = null) {
    const pack = getSkillPack();
    if (!pack) return null;
    const index = await pack.getIndex({ fields: [`flags.${MODULE_ID}.rarity`, `flags.${MODULE_ID}.tags`] });
    // Всадники не выпадают в добыче — только с алтаря Погибели
    const all = [...index].filter(e => e.flags?.[MODULE_ID]?.rarity !== 'orange');
    const rarityOf = e => e.flags?.[MODULE_ID]?.rarity;
    const hasTag = e => (e.flags?.[MODULE_ID]?.tags ?? []).some(t => t.toLowerCase().includes(requiredTag.toLowerCase()));

    let pool = all.filter(e => rarityOf(e) === rarity);
    if (requiredTag) pool = pool.filter(hasTag).length ? pool.filter(hasTag) : all.filter(hasTag);
    if (!pool.length) pool = all;
    if (!pool.length) return null;

    const entry = pool[Math.floor(Math.random() * pool.length)];
    return buildCrystalData(await pack.getDocument(entry._id));
}

// Кристалл конкретного навыка — по id или имени
export async function crystalForSkill({ skillId, skillName } = {}) {
    const pack = getSkillPack();
    if (!pack) return null;
    const index = await pack.getIndex();
    const entry = (skillId && index.get(skillId))
        ?? index.find(e => e.name.toLowerCase() === String(skillName ?? '').trim().toLowerCase());
    return entry ? buildCrystalData(await pack.getDocument(entry._id)) : null;
}
