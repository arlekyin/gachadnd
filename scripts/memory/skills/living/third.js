/**
 * Gacha Roguelike dnd5e — Третий раз — за правду (серый навык разума)
 *
 * Две проваленные проверки или два проваленных спасброска подряд — следующий бросок к20 (проверка,
 * спасбросок или атака) с преимуществом. Успех обнуляет счёт; преимущество тратится на следующем броске.
 *
 * Провал виден, только если у броска есть Сл (кнопки проверок и спасбросков в карточках, окна модуля):
 * бросок без Сл счёт не меняет. Хуки идут у того клиента, кто бросает.
 */

import { livingSkill, counterOf, setCounter } from "./common.js";

const KIND = 'third';
const READY = 2;

// Преимущество на следующий бросок к20 после двух провалов
const boosted = new Set();
function boost(actor, config) {
    if (!actor?.isOwner) return;
    const skill = livingSkill(actor, KIND);
    if (!skill || counterOf(skill) < READY) return;
    config.advantage = true;
    boosted.add(actor.id);
    ui.notifications.info(`${skill.name}: преимущество на этот бросок.`);
}
for (const hook of ['dnd5e.preRollSkillV2', 'dnd5e.preRollToolCheckV2', 'dnd5e.preRollAbilityCheckV2', 'dnd5e.preRollSavingThrowV2']) {
    Hooks.on(hook, config => boost(config?.subject, config));
}
Hooks.on('dnd5e.preRollAttackV2', config => boost(config?.subject?.actor, config));

async function settle(actor, roll, counts) {
    if (!actor?.isOwner) return;
    const skill = livingSkill(actor, KIND);
    if (!skill) return;
    // Преимущество потрачено — счёт заново
    if (boosted.delete(actor.id)) return setCounter(skill, 0);
    if (!counts || !roll?.options || !Number.isNumeric(roll.options.target)) return;
    if (roll.isSuccess) return counterOf(skill) ? setCounter(skill, 0) : null;
    if (roll.isFailure) await setCounter(skill, Math.min(READY, counterOf(skill) + 1));
}
const first = rolls => (Array.isArray(rolls) ? rolls[0] : rolls);
for (const hook of ['dnd5e.rollSkill', 'dnd5e.rollToolCheck', 'dnd5e.rollAbilityCheck', 'dnd5e.rollSavingThrow']) {
    Hooks.on(hook, (rolls, data) => settle(data?.subject, first(rolls), true));
}
// Атака проверкой и спасброском не считается, но тратит готовое преимущество
Hooks.on('dnd5e.rollAttackV2', (rolls, data) => settle(data?.subject?.actor, first(rolls), false));
