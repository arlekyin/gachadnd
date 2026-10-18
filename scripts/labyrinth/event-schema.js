/**
 * Gacha Roguelike dnd5e — Формат событий
 *
 * Общая проверка для сборки (build.mjs: src/events/*.yaml → data/events.json) и для загрузки в Foundry.
 * Без зависимостей от Foundry. Описание формата — src/events/SCHEMA.md.
 */

import { SKILL_KEYS } from "./risk-schema.js";

const isText = v => typeof v === 'string' && v.trim().length > 0;

export const EVENT_BIOMES = ['swamp', 'town', 'sea', 'storm', 'deep', 'sky', 'labyrinth', 'any'];
export const EVENT_WHO = ['one', 'all', 'none'];
export const EVENT_RARITIES = ['gray', 'green', 'blue', 'purple', 'red'];
export const REWARD_TIERS = ['small', 'notable', 'rare', 'floor'];
export const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
/** Исходы: ключ → проверка значения */
export const EFFECTS = {
    gold: v => typeof v === 'number' && v !== 0 || 'доля Базы этажа: число, + получить, − заплатить',
    reward: v => (v && REWARD_TIERS.includes(v.tier) && (v.count === undefined || (Number.isInteger(v.count) && v.count > 0))) || `{ tier: ${REWARD_TIERS.join('|')}, count }`,
    crystal: v => (v && (EVENT_RARITIES.includes(v.rarity) || v.rarity === 'up') && (v.tag === undefined || isText(v.tag))) || `{ rarity: ${EVENT_RARITIES.join('|')}|up, tag? } — up: на редкость выше отданного (take_crystal)`,
    take_crystal: v => (v === true || (v && (v.min === undefined || EVENT_RARITIES.includes(v.min)))) || `true или { min: ${EVENT_RARITIES.join('|')} } — забрать кристалл (самый дешёвый не ниже min)`,
    take_skill: v => (v && typeof v.pay === 'number' && v.pay >= 0) || '{ pay } — забрать случайный навык Памяти, заплатить долю Базы × вес редкости',
    burn_skill: v => v === true || 'true — сгорает случайный навык Памяти',
    cool: v => v === true || 'true — снять перегрев и блок со всех навыков',
    omen: v => (Number.isInteger(v) && v !== 0) || 'целое: + предвестие Пожирателя ближе, − дальше (не до прихода)',
    deal_preview: v => v === true || 'true — открыть отряду лоты следующей Сделки луны',
    moon_mark: v => v === true || 'true — метка луны на персонаже',
    scar: v => v === true || ['voice', 'burn', 'crack'].includes(v) || 'true (случайный шрам) или вид: voice, burn, crack',
    skill: v => (v && EVENT_RARITIES.includes(v.rarity)) || `{ rarity: ${EVENT_RARITIES.join('|')} } — случайный навык сразу в Память`,
    hit_dice: v => (Number.isInteger(v) && v !== 0) || 'целое: + вернуть потраченные Кости Хитов, − потратить',
    hp: v => (typeof v === 'number' && v !== 0 && Math.abs(v) <= 1) || 'доля максимума ПЗ: + лечение, − урон (−0,25 = четверть)',
    note: v => isText(v) || 'текст напоминания Мастеру',
    fight: v => isText(v) || 'кого выставить в бой — подсказка Мастеру'
};

function validateEffects(list, field, err) {
    if (!Array.isArray(list)) return err(field, 'список исходов');
    list.forEach((e, i) => {
        const f = `${field}[${i}]`;
        const { to, ...rest } = e ?? {};
        const keys = Object.keys(rest);
        if (keys.length !== 1) return err(f, `один исход в записи (${Object.keys(EFFECTS).join(', ')}), по желанию to`);
        const check = EFFECTS[keys[0]];
        if (!check) return err(`${f}.${keys[0]}`, `неизвестный исход (допустимы: ${Object.keys(EFFECTS).join(', ')})`);
        const ok = check(rest[keys[0]]);
        if (ok !== true) err(`${f}.${keys[0]}`, ok);
        if (to !== undefined && !EVENT_WHO.includes(to)) err(`${f}.to`, `кому: ${EVENT_WHO.join('|')}`);
    });
}

function validateOutcome(out, field, err) {
    const { text, effects, ...rest } = out ?? {};
    Object.keys(rest).forEach(k => err(`${field}.${k}`, 'неизвестное поле (допустимы: text, effects)'));
    if (!isText(text)) err(`${field}.text`, 'обязательное поле: что случилось');
    if (effects !== undefined) validateEffects(effects, `${field}.effects`, err);
}

export function validateEvent(ev) {
    const errs = [];
    const err = (field, msg) => errs.push(`${field}: ${msg}`);
    const { id, title, biome, floors, once, image, sketch, caption, text, options, ...rest } = ev ?? {};
    Object.keys(rest).forEach(k => err(k, 'неизвестное поле (допустимы: id, title, biome, floors, once, image, sketch, caption, text, options)'));
    if (!/^[a-z0-9_]+$/.test(String(id))) err('id', 'латиница в нижнем регистре, цифры и _');
    if (!isText(title)) err('title', 'обязательное поле');
    const biomes = Array.isArray(biome) ? biome : [biome];
    if (!biomes.length || biomes.some(b => !EVENT_BIOMES.includes(b))) err('biome', `один или список: ${EVENT_BIOMES.join(', ')}`);
    if (floors !== undefined && !(Array.isArray(floors) && floors.length === 2 && floors.every(Number.isInteger) && floors[0] <= floors[1])) err('floors', '[от, до] — номера этажей');
    if (once !== undefined && typeof once !== 'boolean') err('once', 'true или false');
    if (image !== undefined) {
        const { src, w, h, lights, ...more } = image ?? {};
        Object.keys(more).forEach(k => err(`image.${k}`, 'неизвестное поле (допустимы: src, w, h, lights)'));
        if (!isText(src)) err('image.src', 'путь к картинке от папки модуля, например assets/sketches/x.webp');
        if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) err('image.w/h', 'размер картинки в пикселях');
        if (lights !== undefined && !(Array.isArray(lights) && lights.every(l => [l?.x, l?.y, l?.r].every(n => typeof n === 'number')))) err('image.lights', 'список { x, y, r } в пикселях картинки');
    }
    if (sketch !== undefined && !isText(sketch)) err('sketch', 'имя зарисовки кодом');
    if (caption !== undefined && !isText(caption)) err('caption', 'подпись под рисунком');
    if (!Array.isArray(text) || !text.length || !text.every(isText)) err('text', 'список абзацев (1–4)');
    if (!Array.isArray(options) || options.length < 2 || options.length > 3) return [...errs, 'options: 2–3 варианта'];
    options.forEach((o, i) => {
        const f = `options[${i}]`;
        const { label, detail, who, check, text: otext, effects, success, failure, ...more } = o ?? {};
        Object.keys(more).forEach(k => err(`${f}.${k}`, 'неизвестное поле (допустимы: label, detail, who, check, text, effects, success, failure)'));
        if (!isText(label)) err(`${f}.label`, 'обязательное поле');
        if (detail !== undefined && !isText(detail)) err(`${f}.detail`, 'строка: цена и награда коротко');
        if (who !== undefined && !EVENT_WHO.includes(who)) err(`${f}.who`, `кто делает: ${EVENT_WHO.join('|')}`);
        if (check) {
            const { skill, ability, save, dc, ...cm } = check;
            Object.keys(cm).forEach(k => err(`${f}.check.${k}`, 'неизвестное поле (допустимы: skill, ability, save, dc)'));
            const kinds = [skill, ability, save].filter(v => v !== undefined).length;
            if (kinds !== 1) err(`${f}.check`, 'одно из: skill (навык), ability (проверка характеристики), save (спасбросок)');
            if (skill !== undefined && !SKILL_KEYS.includes(skill)) err(`${f}.check.skill`, `навык dnd5e: ${SKILL_KEYS.join(', ')}`);
            if (ability !== undefined && !ABILITY_KEYS.includes(ability)) err(`${f}.check.ability`, `характеристика: ${ABILITY_KEYS.join(', ')}`);
            if (save !== undefined && !ABILITY_KEYS.includes(save)) err(`${f}.check.save`, `спасбросок: ${ABILITY_KEYS.join(', ')}`);
            if (dc !== undefined && !Number.isInteger(dc)) err(`${f}.check.dc`, 'поправка к Сл этажа (11 + этаж), целое');
            if (who === 'none') err(`${f}.who`, 'проверку кто-то бросает: one или all');
            validateOutcome(success, `${f}.success`, err);
            validateOutcome(failure, `${f}.failure`, err);
            if (otext !== undefined || effects !== undefined) err(f, 'с проверкой исходы — в success и failure');
        } else {
            if (!isText(otext)) err(`${f}.text`, 'обязательное поле: что случилось');
            if (effects !== undefined) validateEffects(effects, `${f}.effects`, err);
            if (success !== undefined || failure !== undefined) err(f, 'success и failure — только с проверкой (check)');
        }
    });
    return errs;
}
