/**
 * Gacha Roguelike dnd5e — Идентификаторы на русском (docs/i18n.md)
 *
 * Теги и категории навыков — не подписи, а идентификаторы: они записаны в флагах предметов в мирах игроков,
 * в YAML навыков и синергий, по ним работают синергии, Огранка, голоса Эха. Они остаются русскими при любом
 * языке клиента; показывать их — только через tagLabel / categoryLabel (и {{tagLabel}} в шаблонах).
 * tools/i18n/check.mjs считает эти строки идентификаторами, а не текстом для перевода.
 */

import { t } from "./i18n.js";

/** Теги навыков */
export const TAGS = ['огонь', 'кровь', 'взрыв', 'свет', 'движение', 'сталь', 'щит', 'яд', 'проклятье', 'казнь', 'память', 'разум', 'аномалия'];

/** Категории навыков (флаг category; build.mjs, CATEGORIES) и запасные подписи без категории */
export const CATEGORIES = ['АНОМАЛИЯ', 'УРОН', 'ЗАЩИТА', 'ПАМЯТЬ', 'МОБИЛЬНОСТЬ', 'РЕСУРС', 'СИНЕРГИЯ', 'УТИЛИТА', 'ВСАДНИК', 'ШРАМ', 'НАВЫК'];

/** Подпись тега для показа */
export const tagLabel = tag => t(tag);
/** Подпись категории для показа */
export const categoryLabel = category => t(category);
/** Теги списком через запятую — для строк в карточках и окнах */
export const tagsLabel = tags => (tags ?? []).map(tagLabel).join(', ');

if (globalThis.Hooks) Hooks.once('init', () => {
    Handlebars.registerHelper('tagLabel', tag => tagLabel(tag));
    Handlebars.registerHelper('categoryLabel', category => categoryLabel(category));
});
