/**
 * Gacha Roguelike dnd5e — Синергии тегов
 *
 * Данные синергий — src/synergies/*.yaml; сборка (build.mjs) пишет их в scripts/memory/synergy/synergy-tiers.js.
 * Здесь — общий вид словаря для модуля, сборки и журналов правил.
 */

import { SYNERGIES } from "./synergy-tiers.js";

const ABILITY_MODS = ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(a => `@abilities.${a}.mod`).join(', ');

// Универсальная сложность: 8 + бонус мастерства + наивысший модификатор характеристики
// + бонус к Сложности от синергий (флаг dc_bonus пишет расчёт синергий; Разум I — +1)
export const UNIVERSAL_DC_FORMULA = `8 + @prof + max(${ABILITY_MODS}) + @flags.gachadnd.dc_bonus`;

const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
const EFFECT_MODES = { custom: 0, multiply: 1, add: 2, downgrade: 3, upgrade: 4, override: 5 };

/**
 * Словарь синергий: { тег: { key, thresholds: [{ count, name, icon, desc, changes, feature, trigger }] } }.
 * @param {object[]} synergies  Данные синергий (по умолчанию — собранные из YAML).
 */
export function makeSynergyDictionary(synergies = SYNERGIES) {
    return Object.fromEntries(synergies.map(s => {
        const label = s.tag.charAt(0).toUpperCase() + s.tag.slice(1);
        return [s.tag, {
            key: s.key,
            thresholds: s.tiers.map((t, i) => ({
                count: t.count,
                name: `${label} ${ROMAN[i]}: ${t.name}`,
                icon: s.icon,
                desc: t.description,
                changes: (t.changes ?? []).map(c => ({ key: c.key, mode: EFFECT_MODES[c.mode] ?? 2, value: String(c.value) })),
                feature: t.feature ?? null,
                trigger: t.trigger ?? null
            }))
        }];
    }));
}

// Совместимость: параметр dc больше не нужен — Сложность синергий всегда универсальная
export function getSynergyDictionary() {
    return makeSynergyDictionary();
}

// Латинские ключи тегов: формулы бросков не принимают кириллицу (@flags.gachadnd.counts.explosion)
export const TAG_KEYS = Object.fromEntries(SYNERGIES.map(s => [s.tag, s.key]));
