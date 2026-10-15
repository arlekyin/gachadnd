/**
 * Gacha Roguelike dnd5e — Призма (зелёный навык света)
 *
 * Использование взводит призму: урон ближайшей атаки персонажа (в бою — до конца хода) делится на 7
 * равных частей по цветам радуги, остаток — к первой. Бросок урона помечается свойством gdPrism
 * (dnd5e переносит roll.options.properties в описание урона), а перед расчётом урона цели
 * (dnd5e.preCalculateDamage) помеченные части заменяются семью частями разных типов — сопротивления,
 * иммунитеты и уязвимости dnd5e считает уже по каждой. Так работает и кнопка применения в чате.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { isActiveGM } from "../../../core/socket.js";
import { isLight, lightCard } from "./common.js";

export const MARK = 'gdPrism';
/** Красный, оранжевый, жёлтый, зелёный, голубой, синий, фиолетовый */
export const SPECTRUM = ['fire', 'acid', 'lightning', 'poison', 'cold', 'thunder', 'force'];
const FLAG = 'prism';

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLight(item, 'prism') || !actor) return;
    const combat = game.combat?.started ? game.combat : null;
    actor.setFlag(MODULE_ID, FLAG, { combatId: combat?.id ?? null, round: combat?.round ?? null, turn: combat?.turn ?? null });
    lightCard(actor, 'Призма', '<p>Урон следующей атаки разложится на семь цветов радуги.</p>', { icon: 'fa-rainbow', cls: 'prism' });
});

// Бросок урона атаки взведённого персонажа: части урона помечаются, призма гаснет
Hooks.on('dnd5e.preRollDamageV2', (config) => {
    const activity = config?.subject;
    const actor = activity?.actor ?? activity?.item?.actor;
    if (activity?.type !== 'attack' || !actor?.getFlag(MODULE_ID, FLAG)) return;
    for (const roll of config.rolls ?? []) {
        roll.options ??= {};
        roll.options.properties = [...(roll.options.properties ?? []), MARK];
    }
    actor.unsetFlag(MODULE_ID, FLAG);
});

/** Разложить помеченный урон: сумма → 7 частей по цветам, остаток — к первой. @returns {boolean} */
export function split(damages) {
    const marked = damages.filter(d => d.properties?.has?.(MARK) && d.type !== 'healing' && d.type !== 'temphp');
    if (!marked.length) return false;
    const total = marked.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
    const properties = [...marked[0].properties].filter(p => p !== MARK);
    const base = Math.trunc(total / SPECTRUM.length);
    const rest = total - base * SPECTRUM.length;
    for (const d of marked) damages.splice(damages.indexOf(d), 1);
    for (const [i, type] of SPECTRUM.entries()) {
        const value = base + (i === 0 ? rest : 0);
        if (value) damages.push({ type, value, properties: new Set(properties) });
    }
    return true;
}

Hooks.on('dnd5e.preCalculateDamage', (actor, damages) => { split(damages); });

// В бою призма гаснет с концом хода, в котором её взвели
Hooks.on('updateCombat', (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM()) return;
    for (const c of combat.combatants) {
        const flag = c.actor?.getFlag(MODULE_ID, FLAG);
        if (flag?.combatId === combat.id && (flag.round !== combat.round || flag.turn !== combat.turn)) c.actor.unsetFlag(MODULE_ID, FLAG);
    }
});
