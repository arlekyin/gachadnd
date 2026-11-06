/**
 * Gacha Roguelike dnd5e — Перевод (docs/i18n.md)
 *
 * Текст — ключ: в коде остаётся русская фраза, обёрнутая в t(): t('Обмен'), t('Обмен {a} ⇄ {b}', { a, b }).
 * Словарь языка клиента — i18n/<язык>.json, плоский: { "Обмен": "Trade" }. Русский — исходный язык, словаря у
 * него нет; нет перевода фразы — показывается русская. Словари собирает tools/i18n/extract.mjs.
 *
 * Не lang/: Foundry раскладывает ключи lang-файлов по точкам, а в фразах точки есть.
 *
 * Словарь грузится сразу, при загрузке модуля: язык клиента Foundry хранит в localStorage (core.language),
 * поэтому t() переводит и таблицы на верхнем уровне модулей, и названия настроек из init. На i18nInit язык
 * сверяется с тем, что выбрала Foundry; разошёлся — словарь перегружается, настройки переподписываются.
 * В Node (сборка импортирует схемы событий) словаря нет: t() — русская фраза с подстановками.
 * Идентификаторы (теги, категории — scripts/core/ids.js) через t() не пропускают: они в данных миров.
 */

import { MODULE_ID } from "./constants.js";

/** Исходный язык модуля */
export const SOURCE_LANG = 'ru';
let dictionary = null;
let loadedLang = SOURCE_LANG;

/** Подстановка {имя} из данных; без данных — фраза как есть */
function fill(text, data) {
    if (!data) return text;
    return text.replace(/\{(\w+)\}/g, (m, key) => key in data ? String(data[key] ?? '') : m);
}

/**
 * Перевод фразы на язык клиента.
 * @param {string} text   русская фраза — она же ключ словаря
 * @param {object} [data] подстановки {имя}
 */
export function t(text, data) {
    const raw = String(text ?? '');
    const translated = dictionary?.[raw];
    return fill(typeof translated === 'string' && translated ? translated : raw, data);
}

/** Язык, на который переведено: исходный — без словаря */
export const clientLang = () => loadedLang;
export const translating = () => !!dictionary;

/** Язык клиента до запуска Foundry: настройка core.language (клиентская — в localStorage), иначе язык страницы */
function initialLang() {
    try {
        const stored = globalThis.localStorage?.getItem('core.language');
        if (stored) return JSON.parse(stored);
    } catch { /* нет хранилища или не JSON — язык страницы */ }
    return globalThis.document?.documentElement?.lang || SOURCE_LANG;
}

/** Словарь, только переведённые фразы; синхронно — до init, иначе fetch */
function parse(json) {
    const out = Object.fromEntries(Object.entries(json ?? {}).filter(([, v]) => typeof v === 'string' && v));
    return Object.keys(out).length ? out : null;
}
function loadSync(lang) {
    if (!lang || lang === SOURCE_LANG || !globalThis.XMLHttpRequest) return null;
    try {
        const request = new XMLHttpRequest();
        request.open('GET', `modules/${MODULE_ID}/i18n/${lang}.json`, false);
        request.send();
        return request.status === 200 ? parse(JSON.parse(request.responseText)) : null;
    } catch (error) {
        console.warn(`${MODULE_ID} | словарь ${lang} не загрузился`, error);
        return null;
    }
}
async function loadAsync(lang) {
    if (!lang || lang === SOURCE_LANG) return null;
    try {
        const response = await fetch(`modules/${MODULE_ID}/i18n/${lang}.json`);
        return response.ok ? parse(await response.json()) : null;
    } catch (error) {
        console.warn(`${MODULE_ID} | словарь ${lang} не загрузился`, error);
        return null;
    }
}

/** Названия и подсказки настроек модуля — на i18nInit */
function relabelSettings() {
    if (!dictionary) return;
    for (const [key, config] of game.settings.settings) {
        if (!key.startsWith(`${MODULE_ID}.`)) continue;
        if (config.name) config.name = t(config.name);
        if (config.hint) config.hint = t(config.hint);
        if (config.choices && typeof config.choices === 'object') for (const c of Object.keys(config.choices)) if (typeof config.choices[c] === 'string') config.choices[c] = t(config.choices[c]);
    }
    for (const [key, menu] of game.settings.menus) {
        if (!key.startsWith(`${MODULE_ID}.`)) continue;
        for (const field of ['name', 'label', 'hint']) if (menu[field]) menu[field] = t(menu[field]);
    }
}

if (globalThis.Hooks) {
    loadedLang = initialLang();
    dictionary = loadSync(loadedLang);

    // Помощник шаблонов: {{t "Обмен"}}, {{t "Обмен {a} ⇄ {b}" a=first b=second}}
    Hooks.once('init', () => {
        Handlebars.registerHelper('t', (text, options) => t(text, options?.hash));
    });

    // Foundry выбрала другой язык, чем был в хранилище (первый запуск клиента), — словарь заново; настройки,
    // зарегистрированные русской фразой без t(), — переподписать (повторный t() переведённого не меняет)
    Hooks.once('i18nInit', async () => {
        const lang = game.i18n.lang;
        if (lang !== loadedLang) {
            loadedLang = lang;
            dictionary = await loadAsync(lang);
        }
        relabelSettings();
    });
}
