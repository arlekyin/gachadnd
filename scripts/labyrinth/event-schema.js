/**
 * Gacha Roguelike dnd5e — Формат событий
 *
 * Общая проверка для сборки (build.mjs: src/events/*.yaml → data/events.json) и для загрузки в Foundry.
 * Без зависимостей от Foundry. Описание формата — src/events/SCHEMA.md.
 */

import { SKILL_KEYS } from "./risk-schema.js";
import { t } from "../core/i18n.js";

const isText = v => typeof v === 'string' && v.trim().length > 0;

export const EVENT_BIOMES = ['swamp', 'town', 'sea', 'storm', 'deep', 'sky', 'labyrinth', 'any'];
export const EVENT_WHO = ['one', 'all', 'none'];
export const EVENT_RARITIES = ['gray', 'green', 'blue', 'purple', 'red'];
export const REWARD_TIERS = ['small', 'notable', 'rare', 'floor'];
export const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
/** Исходы: ключ → проверка значения */
export const EFFECTS = {
    gold: v => typeof v === 'number' && v !== 0 || t('доля Базы этажа: число, + получить, − заплатить'),
    reward: v => (v && REWARD_TIERS.includes(v.tier) && (v.count === undefined || (Number.isInteger(v.count) && v.count > 0))) || `{ tier: ${REWARD_TIERS.join('|')}, count }`,
    crystal: v => (v && (EVENT_RARITIES.includes(v.rarity) || v.rarity === 'up') && (v.tag === undefined || isText(v.tag))) || t('{ rarity: {v}|up, tag? } — up: на редкость выше отданного (take_crystal)', { v: EVENT_RARITIES.join('|') }),
    take_crystal: v => (v === true || (v && (v.min === undefined || EVENT_RARITIES.includes(v.min)))) || t('true или { min: {v} } — забрать кристалл (самый дешёвый не ниже min)', { v: EVENT_RARITIES.join('|') }),
    take_skill: v => (v && typeof v.pay === 'number' && v.pay >= 0) || t('{ pay } — забрать случайный навык Памяти, заплатить долю Базы × вес редкости'),
    burn_skill: v => v === true || t('true — сгорает случайный навык Памяти'),
    cool: v => v === true || t('true — снять перегрев и блок со всех навыков'),
    omen: v => (Number.isInteger(v) && v !== 0) || t('целое: + предвестие Пожирателя ближе, − дальше (не до прихода)'),
    deal_preview: v => v === true || t('true — открыть отряду лоты следующей Сделки луны'),
    moon_mark: v => v === true || t('true — метка луны на персонаже'),
    scar: v => v === true || ['voice', 'burn', 'crack'].includes(v) || t('true (случайный шрам) или вид: voice, burn, crack'),
    skill: v => (v && EVENT_RARITIES.includes(v.rarity)) || t('{ rarity: {v} } — случайный навык сразу в Память', { v: EVENT_RARITIES.join('|') }),
    hit_dice: v => (Number.isInteger(v) && v !== 0) || t('целое: + вернуть потраченные Кости Хитов, − потратить'),
    hp: v => (typeof v === 'number' && v !== 0 && Math.abs(v) <= 1) || t('доля максимума ПЗ: + лечение, − урон (−0,25 = четверть)'),
    note: v => isText(v) || t('текст напоминания Мастеру'),
    fight: v => isText(v) || t('кого выставить в бой — подсказка Мастеру')
};

function validateEffects(list, field, err) {
    if (!Array.isArray(list)) return err(field, t('список исходов'));
    list.forEach((e, i) => {
        const f = `${field}[${i}]`;
        const { to, ...rest } = e ?? {};
        const keys = Object.keys(rest);
        if (keys.length !== 1) return err(f, t('один исход в записи ({v}), по желанию to', { v: Object.keys(EFFECTS).join(', ') }));
        const check = EFFECTS[keys[0]];
        if (!check) return err(`${f}.${keys[0]}`, t('неизвестный исход (допустимы: {v})', { v: Object.keys(EFFECTS).join(', ') }));
        const ok = check(rest[keys[0]]);
        if (ok !== true) err(`${f}.${keys[0]}`, ok);
        if (to !== undefined && !EVENT_WHO.includes(to)) err(`${f}.to`, t('кому: {v}', { v: EVENT_WHO.join('|') }));
    });
}

function validateOutcome(out, field, err) {
    const { text, effects, ...rest } = out ?? {};
    Object.keys(rest).forEach(k => err(`${field}.${k}`, t('неизвестное поле (допустимы: text, effects)')));
    if (!isText(text)) err(`${field}.text`, t('обязательное поле: что случилось'));
    if (effects !== undefined) validateEffects(effects, `${field}.effects`, err);
}

export function validateEvent(ev) {
    const errs = [];
    const err = (field, msg) => errs.push(`${field}: ${msg}`);
    const { id, title, biome, floors, once, image, sketch, caption, text, options, ...rest } = ev ?? {};
    Object.keys(rest).forEach(k => err(k, t('неизвестное поле (допустимы: id, title, biome, floors, once, image, sketch, caption, text, options)')));
    if (!/^[a-z0-9_]+$/.test(String(id))) err('id', t('латиница в нижнем регистре, цифры и _'));
    if (!isText(title)) err('title', t('обязательное поле'));
    const biomes = Array.isArray(biome) ? biome : [biome];
    if (!biomes.length || biomes.some(b => !EVENT_BIOMES.includes(b))) err('biome', t('один или список: {v}', { v: EVENT_BIOMES.join(', ') }));
    if (floors !== undefined && !(Array.isArray(floors) && floors.length === 2 && floors.every(Number.isInteger) && floors[0] <= floors[1])) err('floors', t('[от, до] — номера этажей'));
    if (once !== undefined && typeof once !== 'boolean') err('once', t('true или false'));
    if (image !== undefined) {
        const { src, w, h, lights, ...more } = image ?? {};
        Object.keys(more).forEach(k => err(`image.${k}`, t('неизвестное поле (допустимы: src, w, h, lights)')));
        if (!isText(src)) err('image.src', t('путь к картинке от папки модуля, например assets/sketches/x.webp'));
        if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) err('image.w/h', t('размер картинки в пикселях'));
        if (lights !== undefined && !(Array.isArray(lights) && lights.every(l => [l?.x, l?.y, l?.r].every(n => typeof n === 'number')))) err('image.lights', t('список { x, y, r } в пикселях картинки'));
    }
    if (sketch !== undefined && !isText(sketch)) err('sketch', t('имя зарисовки кодом'));
    if (caption !== undefined && !isText(caption)) err('caption', t('подпись под рисунком'));
    if (!Array.isArray(text) || !text.length || !text.every(isText)) err('text', t('список абзацев (1–4)'));
    if (!Array.isArray(options) || options.length < 2 || options.length > 3) return [...errs, t('options: 2–3 варианта')];
    options.forEach((o, i) => {
        const f = `options[${i}]`;
        const { label, detail, who, check, text: otext, effects, success, failure, ...more } = o ?? {};
        Object.keys(more).forEach(k => err(`${f}.${k}`, t('неизвестное поле (допустимы: label, detail, who, check, text, effects, success, failure)')));
        if (!isText(label)) err(`${f}.label`, t('обязательное поле'));
        if (detail !== undefined && !isText(detail)) err(`${f}.detail`, t('строка: цена и награда коротко'));
        if (who !== undefined && !EVENT_WHO.includes(who)) err(`${f}.who`, t('кто делает: {v}', { v: EVENT_WHO.join('|') }));
        if (check) {
            const { skill, ability, save, dc, ...cm } = check;
            Object.keys(cm).forEach(k => err(`${f}.check.${k}`, t('неизвестное поле (допустимы: skill, ability, save, dc)')));
            const kinds = [skill, ability, save].filter(v => v !== undefined).length;
            if (kinds !== 1) err(`${f}.check`, t('одно из: skill (навык), ability (проверка характеристики), save (спасбросок)'));
            if (skill !== undefined && !SKILL_KEYS.includes(skill)) err(`${f}.check.skill`, t('навык dnd5e: {v}', { v: SKILL_KEYS.join(', ') }));
            if (ability !== undefined && !ABILITY_KEYS.includes(ability)) err(`${f}.check.ability`, t('характеристика: {v}', { v: ABILITY_KEYS.join(', ') }));
            if (save !== undefined && !ABILITY_KEYS.includes(save)) err(`${f}.check.save`, t('спасбросок: {v}', { v: ABILITY_KEYS.join(', ') }));
            if (dc !== undefined && !Number.isInteger(dc)) err(`${f}.check.dc`, t('поправка к Сл этажа (11 + этаж), целое'));
            if (who === 'none') err(`${f}.who`, t('проверку кто-то бросает: one или all'));
            validateOutcome(success, `${f}.success`, err);
            validateOutcome(failure, `${f}.failure`, err);
            if (otext !== undefined || effects !== undefined) err(f, t('с проверкой исходы — в success и failure'));
        } else {
            if (!isText(otext)) err(`${f}.text`, t('обязательное поле: что случилось'));
            if (effects !== undefined) validateEffects(effects, `${f}.effects`, err);
            if (success !== undefined || failure !== undefined) err(f, t('success и failure — только с проверкой (check)'));
        }
    });
    return errs;
}
