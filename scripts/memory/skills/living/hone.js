/**
 * Gacha Roguelike dnd5e — Набить руку (зелёный навык стали)
 *
 * Каждый попавший удар оружием — зарубка (до 4; ранги — 3 и 2). Удар при полном счёте — критическое
 * попадание, зарубки обнуляются. Держатся между боями до долгого отдыха.
 *
 * Попадание — бросок урона атакой оружия (как у всех срабатываний модуля: урон бросают после попадания).
 * Хуки броска идут у того клиента, кто бросает, — счёт ведёт он же (владелец персонажа).
 */

import { livingSkill, counterOf, counterMax, setCounter } from "./common.js";
import { t } from "../../../core/i18n.js";

const KIND = 'hone';
const isWeaponAttack = activity => activity?.type === 'attack' && activity.item?.type === 'weapon';

// Полный счёт: этот бросок урона — критический
const critical = new Set();
Hooks.on('dnd5e.preRollDamageV2', config => {
    const activity = config?.subject;
    const actor = activity?.actor;
    if (!actor?.isOwner || !isWeaponAttack(activity)) return;
    const skill = livingSkill(actor, KIND);
    if (!skill || counterOf(skill) < counterMax(skill, 4)) return;
    config.isCritical = true;
    for (const roll of config.rolls ?? []) {
        roll.options ??= {};
        roll.options.isCritical = true;
    }
    critical.add(activity.uuid);
    ui.notifications.info(t('{name}: рука набита — критическое попадание.', { name: skill.name }));
});

Hooks.on('dnd5e.rollDamageV2', async (rolls, { subject } = {}) => {
    const actor = subject?.actor;
    if (!actor?.isOwner || !isWeaponAttack(subject)) return;
    const skill = livingSkill(actor, KIND);
    if (!skill) return;
    if (critical.delete(subject.uuid)) return setCounter(skill, 0);
    await setCounter(skill, Math.min(counterMax(skill, 4), counterOf(skill) + 1));
});

// Долгий отдых — зарубки стираются
Hooks.on('dnd5e.restCompleted', (actor, result, config) => {
    const long = config?.type === 'long' || result?.longRest;
    const skill = long && actor?.isOwner ? actor.items.find(i => i.flags?.gachadnd?.living === KIND && counterOf(i) > 0) : null;
    if (skill && game.users.activeGM?.isSelf) setCounter(skill, 0);
});
