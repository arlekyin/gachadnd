/**
 * Gacha Roguelike dnd5e — Автоматизация синергий (триггеры)
 *
 * Синергия с полем trigger (src/synergies/*.yaml) срабатывает сама, без кнопки:
 *   damage_roll — перед броском урона атакой или заклинанием 1 раз в ход: добавляет кость урона
 *                 (bonus) или после броска лечит носителя (heal_self). Хук dnd5e.preRollDamageV2
 *                 есть в dnd5e 4.4 и 5.1.
 *   damaged     — после получения урона (хук dnd5e.applyDamage) владелец получает предложение
 *                 потратить реакцию и заряд способности синергии: бросок reduce возвращает ПЗ.
 *
 * Ограничения, о которых знает Мастер:
 *   - попадание не проверяется: бросок урона считается попаданием;
 *   - «1 раз в ход» считается по раунду и ходу текущего боя, вне боя — без ограничения;
 *   - кость добавляется к первому подходящему броску в ход; переброс урона тратит срабатывание;
 *   - источник полученного урона не известен: реакция предлагается на любой урон.
 * Отключается настройкой «Автоматизация синергий».
 */

import { MODULE_ID } from "./constants.js";
import { getSynergyDictionary } from "./synergy-data.js";
import { onSocket, emit } from "./socket.js";

const SETTING = 'automation';
const HOSTILE = -1;

export function registerTriggerSettings() {
    game.settings.register(MODULE_ID, SETTING, {
        name: 'Автоматизация синергий',
        hint: 'Синергии «1 раз в ход доп. урон» добавляют кость к броску урона сами, «Жажда» лечит после броска, реакции на урон предлагаются владельцу. Выключите, чтобы пользоваться только кнопками.',
        scope: 'world', config: true, type: Boolean, default: true
    });
}

function enabled() {
    try {
        return !!game.settings.get(MODULE_ID, SETTING);
    } catch (err) {
        return false;
    }
}

// Синергии персонажа, у которых есть триггер: порог достигнут по счётчикам тегов
export function activeTriggers(actor, on) {
    const counts = actor?.getFlag?.(MODULE_ID, 'counts') ?? {};
    const result = [];
    for (const [tag, config] of Object.entries(getSynergyDictionary())) {
        const count = counts[config.key] ?? 0;
        for (const tier of config.thresholds) {
            if (tier.trigger?.on === on && count >= tier.count) result.push({ id: `${config.key}:${tier.count}`, tag, ...tier });
        }
    }
    return result;
}

// ==========================================
// УСЛОВИЯ И «1 РАЗ В ХОД»
// ==========================================

const hp = actor => actor?.system?.attributes?.hp ?? {};
const firstTarget = () => game.user?.targets?.first?.() ?? [...(game.user?.targets ?? [])][0] ?? null;

const CONDITIONS = {
    self_wounded: ({ actor }) => hp(actor).value < hp(actor).max,
    self_bloodied: ({ actor }) => hp(actor).value < hp(actor).max / 2,
    target_bloodied: ({ target }) => !!target?.actor && hp(target.actor).value < hp(target.actor).max / 2,
    hostile_target: ({ target }) => (target?.document?.disposition ?? target?.disposition) === HOSTILE
};

function conditionsMet(when = [], ctx) {
    return when.every(name => CONDITIONS[name]?.(ctx));
}

// Ход текущего боя персонажа; вне боя — null (ограничения нет)
function turnKey(actor) {
    const combat = game.combats?.find?.(c => c.started && c.combatants?.some(cb => cb.actor?.id === actor.id));
    return combat ? `${combat.id}:${combat.round}:${combat.turn}` : null;
}

// Срабатывания в этом ходу — в памяти клиента того, кто бросает урон
const usedThisTurn = new Map();
function usedNow(actor, trigger, key) {
    return key !== null && usedThisTurn.get(`${actor.id}:${trigger.id}`) === key;
}
function markUsed(actor, trigger, key) {
    if (key !== null) usedThisTurn.set(`${actor.id}:${trigger.id}`, key);
}

// Урон атакой или заклинанием — не лечение и не кнопки самих синергий и кристаллов
function isOffensiveDamage(activity) {
    const item = activity?.item;
    if (!item || activity.type === 'heal') return false;
    const flags = item.flags?.[MODULE_ID] ?? {};
    if (flags.is_synergy_item || flags.is_crystal_item) return false;
    return activity.type === 'attack' || item.type === 'spell';
}

// ==========================================
// БРОСОК УРОНА: ДОП. КОСТЬ И ЛЕЧЕНИЕ
// ==========================================

// Подготовленные срабатывания ждут, пока бросок состоится: отменённый бросок их не тратит
const pending = new Map();

Hooks.on('dnd5e.preRollDamageV2', (config) => {
    if (!enabled()) return;
    const activity = config?.subject;
    const actor = activity?.actor;
    if (!actor?.isOwner || !isOffensiveDamage(activity)) return;

    const ctx = { actor, target: firstTarget() };
    const key = turnKey(actor);
    const fired = [];
    for (const trigger of activeTriggers(actor, 'damage_roll')) {
        if (usedNow(actor, trigger, key) || !conditionsMet(trigger.trigger.when, ctx)) continue;
        const { bonus } = trigger.trigger;
        if (bonus) {
            const doubled = bonus.double_when && CONDITIONS[bonus.double_when]?.(ctx);
            const formula = doubled ? `2 * (${bonus.formula})` : bonus.formula;
            config.rolls ??= [];
            config.rolls.push({ parts: [formula], data: actor.getRollData(), options: { type: bonus.type, types: [bonus.type] } });
            ui.notifications.info(`${trigger.name}: +${formula} (${CONFIG.DND5E?.damageTypes?.[bonus.type]?.label ?? bonus.type})`);
        }
        fired.push(trigger);
    }
    if (fired.length) pending.set(activity.uuid ?? activity.id, { actor, key, fired });
});

Hooks.on('dnd5e.rollDamageV2', async (rolls, { subject } = {}) => {
    const entry = subject && pending.get(subject.uuid ?? subject.id);
    if (!entry) return;
    pending.delete(subject.uuid ?? subject.id);
    const { actor, key, fired } = entry;
    for (const trigger of fired) {
        markUsed(actor, trigger, key);
        const heal = trigger.trigger.heal_self;
        if (!heal) continue;
        const roll = await new Roll(heal.formula, actor.getRollData()).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${trigger.name}: лечение` });
        await actor.applyDamage([{ value: roll.total, type: 'healing' }]);
    }
});

// ==========================================
// ПОЛУЧЕН УРОН: РЕАКЦИЯ
// ==========================================

// Способность синергии с зарядами — её заряд тратит реакция
function featureItem(actor, trigger) {
    return actor.items.find(i => i.flags?.[MODULE_ID]?.is_synergy_item && i.name === trigger.name) ?? null;
}

function usesLeft(item) {
    const max = parseInt(item?.system?.uses?.max) || 0;
    return max - (item?.system?.uses?.spent || 0);
}

// Кому предлагать реакцию: игроку-владельцу в игре, иначе Мастеру
function responder(actor) {
    const players = game.users?.filter?.(u => u.active && !u.isGM && actor.testUserPermission?.(u, 'OWNER')) ?? [];
    return (players.find(u => u.character?.id === actor.id) ?? players[0] ?? game.users?.activeGM ?? game.user)?.id;
}

Hooks.on('dnd5e.applyDamage', (actor, amount) => {
    if (!enabled() || !(amount > 0) || !actor) return;
    // Предложение рассылает один клиент — тот, кто применил урон
    for (const trigger of activeTriggers(actor, 'damaged')) {
        if (usesLeft(featureItem(actor, trigger)) <= 0) continue;
        const message = { actorId: actor.id, tokenUuid: actor.token?.uuid ?? null, triggerId: trigger.id, amount, userId: responder(actor) };
        if (message.userId === game.user.id) offerReaction(message, actor);
        else emit('triggerReaction', message);
    }
});

onSocket('triggerReaction', message => {
    if (message.userId === game.user.id) offerReaction(message);
});

async function offerReaction({ actorId, tokenUuid, triggerId, amount }, local = null) {
    const actor = local ?? ((tokenUuid && (await fromUuid(tokenUuid))?.actor) || game.actors.get(actorId));
    const trigger = actor && activeTriggers(actor, 'damaged').find(t => t.id === triggerId);
    const item = trigger && featureItem(actor, trigger);
    if (!item || usesLeft(item) <= 0) return;
    const { formula } = trigger.trigger.reduce;
    const yes = await foundry.applications.api.DialogV2.confirm({
        window: { title: trigger.name },
        content: `<p><strong>${actor.name}</strong> получает ${amount} урона.</p>
            <p>Реакцией уменьшить его на ${formula}? Осталось зарядов: ${usesLeft(item)}.</p>`,
        rejectClose: false
    });
    if (!yes) return;
    const roll = await new Roll(formula, actor.getRollData()).evaluate();
    const restored = Math.min(roll.total, amount);
    await item.update({ 'system.uses.spent': (item.system.uses.spent || 0) + 1 });
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${trigger.name}: урон уменьшен на ${restored}` });
    await actor.applyDamage([{ value: restored, type: 'healing' }]);
}
