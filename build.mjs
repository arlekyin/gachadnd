/**
 * Сборка компендиума навыков: src/packs/gacha-skills/<категория>/*.yaml → dist/packs/gacha-skills/*.json
 *
 * Перед записью каждый YAML-файл проверяется по схеме (см. src/packs/gacha-skills/SCHEMA.md).
 * При любой ошибке сборка останавливается и ничего не записывает.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as yaml from 'js-yaml';
import { RECOVERY_VALUES } from './scripts/recovery.js';
import { getSynergyDictionary, UNIVERSAL_DC_FORMULA, TAG_KEYS } from './scripts/synergy-data.js';
const TAG_NAMES = Object.fromEntries(Object.entries(TAG_KEYS).map(([tag, key]) => [key, tag]));

const BASE_SRC_DIR = './src/packs/gacha-skills';
const DIST_DIR = './dist/packs/gacha-skills';
const ICON_DIR = 'modules/gachadnd/assets/icons/skills';

// ==========================================
// СПРАВОЧНИКИ СХЕМЫ
// ==========================================

const RARITIES = {
    gray: { label: 'Серый', img: 'grey_fog_active.webp' },
    green: { label: 'Зелёный', img: 'green_fog_active.webp' },
    blue: { label: 'Синий', img: 'blue_fog_active.webp' },
    purple: { label: 'Фиолетовый', img: 'purple_fog_active.webp' },
    red: { label: 'Красный', img: 'red_fog_active.webp' },
    // Всадники Погибели; своей иконки пока нет
    orange: { label: 'Оранжевый', img: 'red_fog_active.webp' }
};

// Папка → категория
const CATEGORIES = {
    anomaly: 'АНОМАЛИЯ',
    damage: 'УРОН',
    defense: 'ЗАЩИТА',
    memory: 'ПАМЯТЬ',
    mobility: 'МОБИЛЬНОСТЬ',
    resource: 'РЕСУРС',
    synergy: 'СИНЕРГИЯ',
    utility: 'УТИЛИТА',
    horseman: 'ВСАДНИК'
};

const TAGS = Object.keys(getSynergyDictionary(10));

const ACTIVATION_TYPES = [
    'none', 'action', 'bonus', 'reaction', 'minute', 'hour', 'day', 'longRest', 'shortRest',
    'encounter', 'turnStart', 'turnEnd', 'legendary', 'mythic', 'lair', 'crew', 'special'
];
const ACTIVATION_WITH_VALUE = ['minute', 'hour', 'day'];

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const DAMAGE_TYPES = [
    'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
    'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'
];
const HEALING_TYPES = ['healing', 'temphp'];
const TEMPLATE_TYPES = ['circle', 'cone', 'cube', 'cylinder', 'line', 'radius', 'sphere', 'square', 'wall'];
const ON_SAVE = ['half', 'none', 'full'];

// Значения dc, кроме числа и объекта { formula }
const DC_KEYWORDS = ['spellcasting', 'universal', ...ABILITIES];

const EFFECT_MODES = { custom: 0, multiply: 1, add: 2, downgrade: 3, upgrade: 4, override: 5 };

const ALLOWED_FIELDS = [
    'id', 'name', 'rarity', 'category', 'tags', 'description', 'activation', 'range', 'target',
    'uses', 'recovery', 'slot_bonus', 'forced_loot', 'tagEmitter', 'drawback', 'cost', 'save', 'damage', 'roll', 'changes',
    'ranks', 'stacking', 'memory_scaling', 'memory_bonus', 'undeletable', 'combat_swap', 'personal', 'loot_bonus', 'horseman', 'cleanse', 'cleanse_goal', 'cleansed'
];

// Ранг меняет только числа: заряды, дальность, размер области, формулы урона/лечения/броска,
// значения тех же эффектов. Новых механик ранг не добавляет. Ранг наследует предыдущий ранг.
const RANK_FIELDS = ['text', 'uses', 'range', 'target', 'damage', 'roll', 'changes'];
const MAX_EXTRA_RANKS = 2;
// Уникальные редкости: повтор навыка не поглощается, рангов нет
const UNIQUE_RARITIES = ['purple', 'red', 'orange'];
// Всадники Погибели: проклятое состояние и сращённая форма
const HORSEMEN = ['hunger', 'plague', 'war', 'death'];
const RANK_LABELS = ['I', 'II', 'III'];
// Личный эффект вписывает Мастер в копию навыка на листе персонажа (scripts/inventory.js → setPersonalEffect)
const SCALING_COUNTS = ['memory', 'burned', 'equipped', 'equipped_tags'];
const SCALING_TAG_COUNTS = ['tag', 'equipped_tag', 'equipped_not_tag'];
const PERSONAL_PLACEHOLDER = '<div class="gd-personal"><p><strong>Личный эффект:</strong> не определён. Определяется Мастером вместе с игроком при получении навыка.</p></div>';

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Детерминированный 16-символьный ID Foundry: одинаковый при каждой сборке
function stableId(...parts) {
    const hash = crypto.createHash('sha256').update(parts.join(':')).digest();
    let id = '';
    for (let i = 0; i < 16; i++) id += ID_ALPHABET[hash[i] % ID_ALPHABET.length];
    return id;
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Пустая строка разделяет абзацы, одиночный перевод строки — <br>
function textToHtml(text) {
    return String(text).trim().split(/\n\s*\n/)
        .map(p => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

const isPositiveInt = v => Number.isInteger(v) && v > 0;
const isNonEmptyString = v => typeof v === 'string' && v.trim() !== '';
const isNumeric = v => (typeof v === 'number' && v > 0) || (typeof v === 'string' && /^\d+$/.test(v.trim()));

// ==========================================
// ПРОВЕРКА СХЕМЫ
// ==========================================

// Навык на указанном ранге (1 — базовый): базовые поля + переопределения рангов II..rank
function resolveRank(skill, rank) {
    const { ranks = [], ...base } = skill;
    const resolved = { ...base };
    for (const override of ranks.slice(0, rank - 1)) {
        const { text, ...fields } = override ?? {};
        Object.assign(resolved, fields);
    }
    return resolved;
}

function validateSkill(skill, folder) {
    const errors = [];
    const err = (field, msg) => errors.push(`${field}: ${msg}`);

    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return ['файл не содержит объект навыка'];

    for (const key of Object.keys(skill)) {
        if (!ALLOWED_FIELDS.includes(key)) err(key, `неизвестное поле (допустимы: ${ALLOWED_FIELDS.join(', ')})`);
    }

    if (typeof skill.id !== 'string' || !/^[a-zA-Z0-9]{16}$/.test(skill.id)) err('id', `должен состоять ровно из 16 латинских букв и цифр, получено «${skill.id}»`);
    if (!isNonEmptyString(skill.name)) err('name', 'обязательное поле');
    if (!isNonEmptyString(skill.description)) err('description', 'обязательное поле');
    if (!(skill.rarity in RARITIES)) err('rarity', `«${skill.rarity}» — допустимо: ${Object.keys(RARITIES).join(', ')}`);

    const folderCategory = CATEGORIES[folder];
    if (!folderCategory) err('category', `папка «${folder}» не сопоставлена ни с одной категорией`);
    else if (skill.category !== undefined && skill.category !== folderCategory) {
        err('category', `«${skill.category}» не совпадает с категорией папки «${folder}» (${folderCategory})`);
    }

    if (skill.tags !== undefined) {
        if (!Array.isArray(skill.tags)) err('tags', 'должен быть списком');
        else skill.tags.forEach(t => {
            if (!TAGS.includes(t)) err('tags', `«${t}» отсутствует в словаре синергий (допустимо: ${TAGS.join(', ')})`);
        });
    }

    const activation = skill.activation ?? 'none';
    if (!ACTIVATION_TYPES.includes(activation)) err('activation', `«${activation}» — допустимо: ${ACTIVATION_TYPES.join(', ')}`);
    const isActive = activation !== 'none';

    if (skill.uses !== undefined && !isPositiveInt(skill.uses)) err('uses', 'должно быть целым числом больше 0');
    if (skill.recovery !== undefined && !(skill.recovery in RECOVERY_VALUES)) {
        err('recovery', `«${skill.recovery}» — допустимо: ${Object.keys(RECOVERY_VALUES).join(', ')}`);
    }
    if (skill.forced_loot !== undefined && !isPositiveInt(skill.forced_loot)) err('forced_loot', 'должно быть целым числом больше 0');
    if (skill.drawback !== undefined && !isNonEmptyString(skill.drawback)) err('drawback', 'должно быть непустой строкой');

    if (skill.ranks !== undefined && UNIQUE_RARITIES.includes(skill.rarity)) {
        err('ranks', `навыки редкости ${UNIQUE_RARITIES.join(', ')} уникальны и не имеют рангов`);
    } else if (skill.ranks !== undefined) {
        if (!Array.isArray(skill.ranks) || skill.ranks.length === 0 || skill.ranks.length > MAX_EXTRA_RANKS) {
            err('ranks', `должен быть списком из 1–${MAX_EXTRA_RANKS} элементов (ранги II и III)`);
        } else {
            skill.ranks.forEach((rank, i) => {
                const label = `ranks[${i}] (ранг ${RANK_LABELS[i + 1]})`;
                if (!rank || typeof rank !== 'object' || Array.isArray(rank)) return err(label, 'должен быть объектом');
                Object.keys(rank).forEach(k => {
                    if (!RANK_FIELDS.includes(k)) err(`${label}.${k}`, `поле нельзя менять по рангам (допустимы: ${RANK_FIELDS.join(', ')})`);
                });
                if (!isNonEmptyString(rank.text)) err(`${label}.text`, 'обязательное поле: что даёт ранг');
                if (!Object.keys(rank).some(k => k !== 'text')) err(label, 'ранг должен менять хотя бы одно число (uses, range, target, damage, roll, changes), а не только текст');
                if (rank.target && skill.target && rank.target.type !== skill.target.type) err(`${label}.target.type`, 'форма области по рангам не меняется');
                if (rank.target && !skill.target) err(`${label}.target`, 'у навыка нет области — ранг может только менять её размер');
                if (rank.roll && !skill.roll) err(`${label}.roll`, 'у навыка нет броска — ранг может только менять его формулу');
                if (rank.damage) {
                    const types = d => (Array.isArray(d) ? d : []).map(x => x?.type).join(',');
                    if (types(rank.damage) !== types(skill.damage)) err(`${label}.damage`, 'типы урона/лечения по рангам не меняются — только формулы');
                }
                if (rank.changes) {
                    const keys = c => (Array.isArray(c) ? c : []).map(x => x?.key).sort().join(',');
                    if (keys(rank.changes) !== keys(skill.changes)) err(`${label}.changes`, 'ранг может менять только значения тех же эффектов, что и у навыка');
                }
                // Ранг проверяется как полноценный навык после наложения переопределений
                validateSkill(resolveRank(skill, i + 2), folder).forEach(e => errors.push(`${label} → ${e}`));
            });
        }
    }
    if (skill.slot_bonus !== undefined && !isPositiveInt(skill.slot_bonus)) err('slot_bonus', 'должно быть целым числом больше 0');
    if (skill.tagEmitter !== undefined && typeof skill.tagEmitter !== 'boolean') err('tagEmitter', 'должно быть true или false');

    // Поля активности имеют смысл только при activation, отличном от none
    for (const field of ['range', 'target', 'save', 'damage', 'roll', 'uses', 'recovery', 'cost']) {
        if (!isActive && skill[field] !== undefined) err(field, 'задано при activation: none — поле не будет использовано');
    }

    if (skill.range !== undefined && !isNumeric(skill.range)) err('range', 'должно быть числом (футы)');

    if (skill.cost !== undefined) {
        const { hp, ...rest } = skill.cost ?? {};
        Object.keys(rest).forEach(k => err(`cost.${k}`, 'неизвестное поле (допустимо: hp)'));
        if (hp === undefined || String(hp).trim() === '') err('cost.hp', 'обязательное поле: сколько ПЗ стоит использование (число или формула)');
    }

    // Бесконечные ранги: каждое слияние прибавляет базовое значение урона
    if (skill.stacking !== undefined) {
        if (skill.stacking !== true) err('stacking', 'допустимо только true');
        if (skill.ranks !== undefined) err('stacking', 'нельзя совмещать с ranks');
        if (UNIQUE_RARITIES.includes(skill.rarity)) err('stacking', 'фиолетовые и красные навыки уникальны');
        if (!Array.isArray(skill.damage) || skill.damage.length !== 1 || !/^\d+$/.test(String(skill.damage[0]?.formula))) {
            err('stacking', 'требует ровно одну запись damage с целым числом в formula (прибавка за ранг)');
        }
    }

    if (skill.roll !== undefined) {
        if (!skill.roll || typeof skill.roll !== 'object' || !isNonEmptyString(String(skill.roll.formula ?? ''))) err('roll.formula', 'обязательное поле');
        if (skill.save !== undefined || skill.damage !== undefined) err('roll', 'бросок (roll) — для навыков без урона, лечения и спасброска');
    }

    if (skill.target !== undefined) {
        if (!TEMPLATE_TYPES.includes(skill.target?.type)) err('target.type', `«${skill.target?.type}» — допустимо: ${TEMPLATE_TYPES.join(', ')}`);
        if (!isNumeric(skill.target?.value)) err('target.value', 'должно быть числом (футы)');
    }

    if (skill.save !== undefined) {
        const { ability, dc, on_save, ...rest } = skill.save ?? {};
        Object.keys(rest).forEach(k => err(`save.${k}`, 'неизвестное поле (допустимы: ability, dc, on_save)'));
        if (!ABILITIES.includes(ability)) err('save.ability', `«${ability}» — допустимо: ${ABILITIES.join(', ')}`);
        const dcValid = dc === undefined || DC_KEYWORDS.includes(dc) || isPositiveInt(dc)
            || (dc && typeof dc === 'object' && isNonEmptyString(dc.formula) && Object.keys(dc).length === 1);
        if (!dcValid) err('save.dc', `«${JSON.stringify(dc)}» — допустимо: ${DC_KEYWORDS.join(', ')}, число или { formula: "..." }`);
        if (on_save !== undefined && !ON_SAVE.includes(on_save)) err('save.on_save', `«${on_save}» — допустимо: ${ON_SAVE.join(', ')}`);
    }

    if (skill.damage !== undefined) {
        if (!Array.isArray(skill.damage) || skill.damage.length === 0) err('damage', 'должен быть непустым списком');
        else {
            skill.damage.forEach((d, i) => {
                if (d?.formula === undefined || String(d.formula).trim() === '') err(`damage[${i}].formula`, 'обязательное поле');
                if (![...DAMAGE_TYPES, ...HEALING_TYPES].includes(d?.type)) err(`damage[${i}].type`, `«${d?.type}» — допустимо: ${[...DAMAGE_TYPES, ...HEALING_TYPES].join(', ')}`);
            });
            const healCount = skill.damage.filter(d => HEALING_TYPES.includes(d?.type)).length;
            if (healCount > 0 && healCount < skill.damage.length) err('damage', 'нельзя смешивать лечение и урон в одном навыке');
            if (healCount > 1) err('damage', 'лечение поддерживает только одну запись');
            if (healCount > 0 && skill.save !== undefined) err('damage', 'лечение нельзя совмещать со спасброском');
        }
    }

    const checkChanges = (list, field) => {
        if (!Array.isArray(list) || list.length === 0) return err(field, 'должен быть непустым списком');
        list.forEach((c, i) => {
            if (typeof c?.key !== 'string' || !/^(system|flags)\.[A-Za-z0-9_.]+$/.test(c.key)) err(`${field}[${i}].key`, `«${c?.key}» — путь должен начинаться с system. или flags. и состоять из латиницы, цифр, _ и .`);
            if (!(c?.mode in EFFECT_MODES)) err(`${field}[${i}].mode`, `«${c?.mode}» — допустимо: ${Object.keys(EFFECT_MODES).join(', ')}`);
            if (c?.value === undefined || c?.value === null) err(`${field}[${i}].value`, 'обязательное поле');
        });
    };
    if (skill.changes !== undefined) checkChanges(skill.changes, 'changes');

    // Эффекты, сила которых зависит от состава Памяти или экипировки: объект или список объектов
    if (skill.memory_scaling !== undefined) {
        const list = Array.isArray(skill.memory_scaling) ? skill.memory_scaling : [skill.memory_scaling];
        if (!list.length) err('memory_scaling', 'должен быть объектом или непустым списком');
        list.forEach((entry, i) => {
            const field = list.length > 1 || Array.isArray(skill.memory_scaling) ? `memory_scaling[${i}]` : 'memory_scaling';
            const { count, every, min, max, offset, parity, changes, text, ...rest } = entry ?? {};
            Object.keys(rest).forEach(k => err(`${field}.${k}`, 'неизвестное поле (допустимы: count, every, min, max, offset, parity, changes, text)'));
            const [mode, tag] = typeof count === 'string' && count.includes(':') ? [count.slice(0, count.indexOf(':')), count.slice(count.indexOf(':') + 1)] : [count, null];
            const validCount = tag === null
                ? SCALING_COUNTS.includes(mode)
                : SCALING_TAG_COUNTS.includes(mode) && TAGS.includes(tag);
            if (!validCount) err(`${field}.count`, `«${count}» — допустимо: ${SCALING_COUNTS.join(', ')}, ${SCALING_TAG_COUNTS.map(m => `${m}:<тег>`).join(', ')}`);
            if (every !== undefined && !isPositiveInt(every)) err(`${field}.every`, 'должно быть целым числом больше 0');
            if (min !== undefined && !(Number.isInteger(min) && min >= 0)) err(`${field}.min`, 'должно быть целым числом не меньше 0');
            if (offset !== undefined && !isPositiveInt(offset)) err(`${field}.offset`, 'должно быть целым числом больше 0');
            if (parity !== undefined && !['even', 'odd'].includes(parity)) err(`${field}.parity`, 'допустимо: even, odd');
            if (max !== undefined && max !== 'prof' && !isPositiveInt(max)) err(`${field}.max`, 'должно быть целым числом больше 0 или prof');
            if (text !== undefined && !isNonEmptyString(text)) err(`${field}.text`, 'должно быть непустой строкой');
            checkChanges(changes, `${field}.changes`);
        });
    }

    // Счётчики экипированных тегов в формулах: @flags.gachadnd.counts.<ключ тега>
    const formulas = [...(skill.damage ?? []).map(d => d?.formula), skill.roll?.formula, skill.cost?.hp].filter(f => f !== undefined).map(String);
    for (const formula of formulas) {
        for (const [, key] of formula.matchAll(/@flags\.gachadnd\.counts\.(\w+)/g)) {
            if (!Object.values(TAG_KEYS).includes(key)) err('formula', `«${key}» — неизвестный ключ тега (допустимо: ${Object.values(TAG_KEYS).join(', ')})`);
        }
    }
    if (skill.memory_bonus !== undefined && !isPositiveInt(skill.memory_bonus)) err('memory_bonus', 'должно быть целым числом больше 0');
    // Всадник: только оранжевая редкость, обязательны условие сращивания и сращённая форма
    if ((skill.rarity === 'orange') !== (skill.horseman !== undefined)) err('horseman', 'оранжевая редкость — только у всадников, и всадник — только оранжевый');
    if (skill.horseman !== undefined) {
        if (!HORSEMEN.includes(skill.horseman)) err('horseman', `«${skill.horseman}» — допустимо: ${HORSEMEN.join(', ')}`);
        if (!isNonEmptyString(skill.cleanse)) err('cleanse', 'обязательное поле: условие сращивания');
        if (skill.cleanse_goal !== undefined && !isPositiveInt(skill.cleanse_goal)) err('cleanse_goal', 'должно быть целым числом больше 0');
        const { name, description, ...rest } = skill.cleansed ?? {};
        Object.keys(rest).forEach(k => err(`cleansed.${k}`, 'неизвестное поле (допустимы: name, description)'));
        if (!isNonEmptyString(name)) err('cleansed.name', 'обязательное поле');
        if (!isNonEmptyString(description)) err('cleansed.description', 'обязательное поле');
    } else {
        ['cleanse', 'cleanse_goal', 'cleansed'].forEach(f => { if (skill[f] !== undefined) err(f, 'только у всадников (horseman)'); });
    }
    if (skill.loot_bonus !== undefined && !isPositiveInt(skill.loot_bonus)) err('loot_bonus', 'должно быть целым числом больше 0');
    if (skill.personal !== undefined && !UNIQUE_RARITIES.includes(skill.rarity)) err('personal', 'личный эффект — только у уникальных навыков (фиолетовых и красных)');
    for (const field of ['undeletable', 'combat_swap', 'personal']) {
        if (skill[field] !== undefined && skill[field] !== true) err(field, 'допустимо только true');
    }
    if (skill.combat_swap && !(isActive && skill.recovery)) err('combat_swap', 'требует activation и recovery: заряд тратится на замену');

    // {damage} подставляет формулу текущего ранга — у навыка должна быть запись в damage
    if ([skill.description, skill.drawback].some(t => typeof t === 'string' && t.includes('{damage}'))
        && !(isActive && Array.isArray(skill.damage) && skill.damage.length)) {
        err('description', '{damage} требует активации и записи в damage');
    }
    if ([skill.description, skill.drawback].some(t => typeof t === 'string' && t.includes('{roll}')) && !skill.roll) {
        err('description', '{roll} требует поля roll');
    }

    // [[/heal]] и [[/damage]] без формулы dnd5e разрешает не во всех окнах (в карточке чата — нет)
    if ([skill.description, skill.drawback].some(t => typeof t === 'string' && /\[\[\/(heal|healing|damage)((\s+(average|extended|temp))*)\s*]]/.test(t))) {
        err('description', '[[/heal]] и [[/damage]] без формулы не используются — пишите {damage}');
    }

    return errors;
}

// ==========================================
// ПРЕОБРАЗОВАНИЕ В ПРЕДМЕТ dnd5e
// ==========================================

function buildDc(dc) {
    if (dc === undefined || dc === 'spellcasting') return { calculation: 'spellcasting', formula: '' };
    if (ABILITIES.includes(dc)) return { calculation: dc, formula: '' };
    if (dc === 'universal') return { calculation: '', formula: UNIVERSAL_DC_FORMULA };
    if (typeof dc === 'number') return { calculation: '', formula: String(dc) };
    return { calculation: '', formula: String(dc.formula) };
}

function buildActivity(skill, usesMax) {
    const id = stableId(skill.id, 'activity', 0);
    const damage = skill.damage ?? [];
    const isHeal = damage.length > 0 && HEALING_TYPES.includes(damage[0].type);

    let type = 'utility';
    if (skill.save) type = 'save';
    else if (isHeal) type = 'heal';
    else if (damage.length > 0) type = 'damage';

    const damagePart = d => ({
        number: null,
        denomination: null,
        bonus: '',
        types: [d.type],
        custom: { enabled: true, formula: String(d.formula) },
        scaling: { mode: '', number: null, formula: '' }
    });

    const activity = {
        _id: id,
        type,
        name: 'Активировать навык',
        activation: {
            type: skill.activation,
            value: ACTIVATION_WITH_VALUE.includes(skill.activation) ? 1 : null,
            condition: '',
            override: false
        },
        consumption: {
            targets: [
                ...(usesMax ? [{ type: 'itemUses', target: '', value: '1', scaling: { mode: '', formula: '' } }] : []),
                // Плата ПЗ — штатный расход атрибута dnd5e: не даёт использовать, если ПЗ не хватает
                ...(skill.cost?.hp !== undefined ? [{ type: 'attribute', target: 'attributes.hp.value', value: String(skill.cost.hp), scaling: { mode: '', formula: '' } }] : [])
            ],
            scaling: { allowed: false, max: '' }
        }
    };

    if (skill.range !== undefined) activity.range = { value: String(skill.range), units: 'ft', special: '', override: false };

    if (skill.target) {
        activity.target = {
            template: { count: '1', contiguous: false, type: skill.target.type, size: String(skill.target.value), width: '', height: '', units: 'ft' },
            affects: { count: '', type: '', choice: false, special: '' },
            prompt: true,
            override: false
        };
    }

    if (type === 'utility' && skill.roll) {
        activity.roll = { formula: String(skill.roll.formula), name: skill.roll.name ?? 'Бросок', prompt: false, visible: true };
    }

    if (type === 'save') {
        activity.save = { ability: [skill.save.ability], dc: buildDc(skill.save.dc) };
        activity.damage = { onSave: skill.save.on_save ?? 'half', parts: damage.map(damagePart) };
    } else if (type === 'heal') {
        activity.healing = damagePart(damage[0]);
    } else if (type === 'damage') {
        activity.damage = { critical: { allow: true, bonus: '' }, parts: damage.map(damagePart) };
    }

    return activity;
}

// Формула словами, как в описаниях dnd5e: «1d10 + ваш уровень»
const ABILITY_NAMES = { str: 'Силы', dex: 'Ловкости', con: 'Телосложения', int: 'Интеллекта', wis: 'Мудрости', cha: 'Харизмы' };
// Дательный падеж первого слагаемого после «равное»: «равное бонусу мастерства + ваш уровень»
const DATIVE = [['бонус мастерства', 'бонусу мастерства'], ['ваш уровень', 'вашему уровню'], ['модификатор ', 'модификатору ']];
function formulaToText(formula, { dative = false } = {}) {
    const perProf = /\(@prof\)d\d+/.test(formula);
    let text = String(formula)
        .replace(/\(@flags\.gachadnd\.counts\.(\w+)\)d(\d+)/g, (_, key, die) => `1d${die} за каждый экипированный навык с тегом «${TAG_NAMES[key] ?? key}»`)
        .replace(/@flags\.gachadnd\.counts\.(\w+)/g, (_, key) => `число экипированных навыков с тегом «${TAG_NAMES[key] ?? key}»`)
        .replace(/\(@prof\)d(\d+)/g, 'Nd$1')
        .replace(/max\(@abilities\.(\w+)\.mod,\s*0\)/g, (_, a) => `модификатор ${ABILITY_NAMES[a] ?? a} (не меньше 0)`)
        .replace(/@abilities\.(\w+)\.mod/g, (_, a) => `модификатор ${ABILITY_NAMES[a] ?? a}`)
        .replace(/@prof/g, 'бонус мастерства')
        .replace(/@details\.level/g, 'ваш уровень')
        .replace(/\s*\*\s*/g, ' × ');
    if (dative) {
        const match = DATIVE.find(([nom]) => text.startsWith(nom));
        if (match) text = match[1] + text.slice(match[0].length);
    }
    return perProf ? `${text}, где N — ваш бонус мастерства` : text;
}

// {damage} → урон или лечение навыка на данном ранге.
// Постоянный урон (только кости и числа) — кнопкой броска dnd5e, как у заговоров;
// формула с переменными или лечение — словами, как «1d10 + ваш уровень» у Второго дыхания.
function withFormula(text, skill) {
    const damage = skill.damage ?? [];
    const isConstant = d => !String(d.formula).includes('@');
    const rendered = damage.length && damage.every(d => isConstant(d) && DAMAGE_TYPES.includes(d.type))
        ? damage.map(d => `[[/damage ${d.formula} ${d.type}]]`).join(' и ')
        : null;
    text = String(text).replaceAll('{roll}', skill.roll ? formulaToText(skill.roll.formula) : '{roll}');
    if (rendered) return String(text).replaceAll('{damage}', rendered);
    const formula = damage.map(d => d.formula).join(' + ');
    return String(text)
        .replaceAll('равное {damage}', `равное ${formulaToText(formula, { dative: true })}`)
        .replaceAll('{damage}', formulaToText(formula));
}

function buildItem(skill, folder, rank = 1) {
    const maxRank = 1 + (skill.ranks?.length ?? 0);
    const ranked = resolveRank(skill, rank);
    // Эффект первооткрывателя: в описании только полученные ранги, следующий раскрывается при слиянии
    const obtained = (skill.ranks ?? []).slice(0, rank - 1);
    const rankHtml = skill.stacking ? ['<p><strong>Ранг:</strong> {rank}</p>'] : maxRank > 1 ? [
        `<p><strong>Ранг:</strong> ${RANK_LABELS[rank - 1]}</p>`,
        ...(obtained.length ? [
            '<ul>',
            ...obtained.map((r, i) => `<li><strong>Ранг ${RANK_LABELS[i + 1]}:</strong> ${escapeHtml(withFormula(r.text, resolveRank(skill, i + 2)))}</li>`),
            '</ul>'
        ] : [])
    ] : [];
    const hasChanges = [skill, ...(skill.ranks ?? [])].some(r => r?.changes);
    const rankTexts = (skill.ranks ?? []).map((r, i) => withFormula(r.text, resolveRank(skill, i + 2)));
    skill = ranked;
    const rarity = RARITIES[skill.rarity];
    const category = CATEGORIES[folder];
    const tags = skill.tags ?? [];
    const activation = skill.activation ?? 'none';
    const isActive = activation !== 'none';
    const img = `${ICON_DIR}/${rarity.img}`;

    const recovery = skill.recovery ? RECOVERY_VALUES[skill.recovery] : null;
    // Если указан период восстановления, но не указаны заряды — считаем, что заряд один
    const usesMax = skill.uses ?? (recovery?.period ? 1 : null);
    const cooldownText = usesMax
        ? `${usesMax}/${recovery?.label ?? 'без восстановления'}`
        : 'Нет';

    const description = [
        `<p><strong>Категория:</strong> ${escapeHtml(category)} | <strong>Редкость:</strong> ${rarity.label}</p>`,
        `<p><strong>Теги синергий:</strong> ${escapeHtml(tags.join(', ') || 'нет')}</p>`,
        `<p><strong>Перезарядка:</strong> ${escapeHtml(cooldownText)}</p>`,
        ...(skill.drawback ? [`<p><strong>Штраф:</strong> ${escapeHtml(withFormula(skill.drawback, skill))}</p>`] : []),
        ...(skill.cost?.hp !== undefined ? [`<p><strong>Цена:</strong> ${escapeHtml(formulaToText(String(skill.cost.hp)))} ПЗ за использование</p>`] : []),
        '<hr>',
        textToHtml(withFormula(skill.description, skill)),
        ...(skill.personal ? [PERSONAL_PLACEHOLDER] : []),
        ...(skill.horseman ? [
            `<p><strong>Сращивание:</strong> ${escapeHtml(skill.cleanse)}</p>`,
            `<p><strong>Сращённая форма — ${escapeHtml(skill.cleansed.name)}:</strong></p>`,
            textToHtml(skill.cleansed.description)
        ] : []),
        ...rankHtml
    ].join('\n');
    // Описание всадника после сращивания: штрафа и условия больше нет
    const cleansedDescription = skill.horseman ? [
        `<p><strong>Категория:</strong> ${escapeHtml(category)} | <strong>Редкость:</strong> ${rarity.label}</p>`,
        `<p><strong>Сращённая форма — ${escapeHtml(skill.cleansed.name)}</strong></p>`,
        '<hr>',
        textToHtml(skill.cleansed.description)
    ].join('\n') : null;

    const item = {
        _id: skill.id,
        _key: `!items!${skill.id}`,
        name: skill.name,
        type: 'feat',
        img,
        system: {
            description: { value: description, chat: '', unidentified: '' },
            source: { custom: 'Gacha Roguelike DnD5e' },
            type: { value: 'feat', subtype: '' },
            uses: {
                spent: 0,
                max: usesMax ? String(usesMax) : '',
                recovery: (usesMax && recovery?.period) ? [{ period: recovery.period, type: 'recoverAll', formula: '' }] : []
            },
            activities: {}
        },
        flags: {
            gachadnd: {
                skill_id: skill.id,
                skill_name: skill.name,
                rarity: skill.rarity,
                rarity_label: rarity.label,
                category,
                tags,
                cooldown: cooldownText,
                has_activation: isActive,
                rank,
                max_rank: maxRank,
                // Тексты рангов II–III: для сообщения о слиянии и для Мастера в Терминале
                ...(rankTexts.length ? { rank_texts: rankTexts } : {}),
                ...(skill.drawback ? { drawback: skill.drawback } : {}),
                ...(skill.forced_loot ? { forced_loot: skill.forced_loot } : {}),
                ...(skill.stacking ? { stacking: true, stack_base: Number(skill.damage[0].formula) } : {}),
                ...(skill.slot_bonus ? { slot_bonus: skill.slot_bonus } : {}),
                ...(skill.tagEmitter ? { tagEmitter: true } : {}),
                ...(skill.memory_scaling ? {
                    memory_scaling: (Array.isArray(skill.memory_scaling) ? skill.memory_scaling : [skill.memory_scaling]).map(entry => ({
                        ...entry,
                        changes: entry.changes.map(c => ({ key: c.key, mode: EFFECT_MODES[c.mode], value: String(c.value) }))
                    }))
                } : {}),
                ...(skill.memory_bonus ? { memory_bonus: skill.memory_bonus } : {}),
                ...(skill.undeletable ? { undeletable: true } : {}),
                ...(skill.combat_swap ? { combat_swap: true } : {}),
                ...(skill.personal ? { personal: true } : {}),
                ...(skill.loot_bonus ? { loot_bonus: skill.loot_bonus } : {}),
                ...(skill.horseman ? {
                    horseman: skill.horseman,
                    cleansed: false,
                    cleanse_goal: skill.cleanse_goal ?? null,
                    cleanse_progress: 0,
                    cleansed_name: skill.cleansed.name,
                    cleansed_description: cleansedDescription
                } : {})
            }
        },
        effects: [],
        folder: null,
        sort: 0,
        ownership: { default: 0 }
    };

    if (isActive) {
        const activity = buildActivity(skill, usesMax);
        item.system.activities[activity._id] = activity;
    }

    // Эффект создаётся, если изменения есть хотя бы на одном ранге: ранги меняют только его changes
    if (hasChanges) {
        const effectId = stableId(skill.id, 'effect', 0);
        item.effects.push({
            _id: effectId,
            _key: `!items.effects!${skill.id}.${effectId}`,
            name: skill.name,
            img,
            changes: (skill.changes ?? []).map(c => ({
                key: c.key,
                mode: EFFECT_MODES[c.mode],
                value: String(c.value),
                priority: 20
            })),
            disabled: false,
            transfer: true,
            flags: {},
            tint: '#ffffff'
        });
    }

    return item;
}

// ==========================================
// СБОРКА
// ==========================================

const folders = fs.readdirSync(BASE_SRC_DIR)
    .filter(item => fs.statSync(path.join(BASE_SRC_DIR, item)).isDirectory())
    .sort();

const errors = [];
const items = [];
const seenIds = new Map();
const seenNames = new Map();

for (const folder of folders) {
    const dir = path.join(BASE_SRC_DIR, folder);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).sort();

    for (const file of files) {
        const relPath = path.join(folder, file);
        let skill;
        try {
            skill = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
        } catch (e) {
            errors.push(`${relPath}: ошибка разбора YAML — ${e.message}`);
            continue;
        }

        const skillErrors = validateSkill(skill, folder);
        if (skill?.id) {
            if (seenIds.has(skill.id)) skillErrors.push(`id: «${skill.id}» уже используется в ${seenIds.get(skill.id)}`);
            else seenIds.set(skill.id, relPath);
        }
        if (skill?.name) {
            const key = String(skill.name).trim().toLowerCase();
            if (seenNames.has(key)) skillErrors.push(`name: «${skill.name}» уже используется в ${seenNames.get(key)}`);
            else seenNames.set(key, relPath);
        }

        if (skillErrors.length) {
            skillErrors.forEach(e => errors.push(`${relPath}: ${e}`));
            continue;
        }

        let item;
        if (skill.stacking) {
            // Шаблон описания с {n} (урон) и {rank}; на листе подставляется при каждом слиянии
            const template = buildItem({ ...skill, damage: [{ ...skill.damage[0], formula: '{n}' }] }, folder, 1).system.description.value;
            item = buildItem(skill, folder, 1);
            item.flags.gachadnd.stack_template = template;
            item.system.description.value = template.replaceAll('{n}', skill.damage[0].formula).replaceAll('{rank}', 'I');
        } else item = buildItem(skill, folder, 1);
        const maxRank = item.flags.gachadnd.max_rank;
        if (maxRank > 1) {
            // Данные каждого ранга для повышения ранга на листе персонажа (scripts/inventory.js)
            item.flags.gachadnd.rank_data = Array.from({ length: maxRank }, (_, i) => {
                const ranked = buildItem(skill, folder, i + 1);
                const { spent, ...uses } = ranked.system.uses;
                return {
                    system: { description: ranked.system.description, uses, activities: ranked.system.activities },
                    cooldown: ranked.flags.gachadnd.cooldown,
                    effects: ranked.effects.map(e => ({ _id: e._id, changes: e.changes }))
                };
            });
        }
        items.push({ file: `${path.basename(file, path.extname(file))}_${skill.id}.json`, item });
    }
}

if (errors.length) {
    console.error(`Сборка остановлена: ошибок — ${errors.length}.\n`);
    errors.forEach(e => console.error(`  ${e}`));
    process.exit(1);
}

fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });
for (const { file, item } of items) {
    fs.writeFileSync(path.join(DIST_DIR, file), JSON.stringify(item, null, 2) + '\n', 'utf8');
}

console.log(`Сборка завершена: навыков — ${items.length}. База готова к упаковке.`);
