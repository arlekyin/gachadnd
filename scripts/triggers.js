/**
 * Gacha Roguelike dnd5e — Автоматизация синергий и навыков (триггеры)
 *
 * Порог синергии (src/synergies/*.yaml) или экипированный навык (src/packs/gacha-skills) с полем
 * trigger срабатывает сам, без кнопки:
 *   damage_roll  — перед броском урона атакой или заклинанием (хук dnd5e.preRollDamageV2, есть
 *                  в dnd5e 4.4 и 5.1): добавляет кость урона (bonus) или после броска лечит
 *                  носителя (heal_self). По умолчанию 1 раз в ход; once: none — каждый раз;
 *                  once: primed — следующая атака после использования навыка (Кровавая цена).
 *   damaged      — после получения урона (хук dnd5e.applyDamage) владельцу предлагается реакция:
 *                  reduce возвращает ПЗ (бросок, бросок навыка или половина урона), use — использует навык.
 *   turn_start   — в начале своего хода в бою владельцу предлагается использовать навык (use) или
 *                  заплатить уроном (pay) за преимущество на атаки до конца хода (advantage).
 *   combat_start — то же в начале боя.
 * У навыка формула может браться из его активности (from: damage | roll) — с учётом текущего ранга.
 * Заряды навыка (uses) проверяются и тратятся при срабатывании.
 *
 * Ограничения, о которых знает Мастер:
 *   - попадание не проверяется: бросок урона считается попаданием;
 *   - «1 раз в ход» считается по раунду и ходу текущего боя, вне боя — без ограничения;
 *   - кость добавляется к первому подходящему броску в ход; переброс урона тратит срабатывание;
 *   - источник полученного урона не известен: реакция предлагается на любой урон.
 * Общий выключатель — настройка мира «Автоматизация синергий и навыков» (Мастер). Кроме того,
 * у каждого игрока в настройках модуля окно «Срабатывания» (scripts/automation-settings.js): для
 * каждого срабатывания две галочки, как у реакций в Baldur's Gate 3, — «Вкл.» и «Спрашивать».
 * Галочки личные: Foundry v13 хранит их за пользователем, v12 — в браузере игрока. Решает тот
 * клиент, который срабатывание обрабатывает: бросающий урон, владелец при реакции и в начале хода.
 * Со «Спрашивать» доп. урон не добавляется к броску сам, а предлагается кнопкой в чате; остальное — окном.
 */

import { MODULE_ID } from "./constants.js";
import { onRenderChatMessage } from "./chat-hooks.js";
import { getSynergyDictionary } from "./synergy-data.js";
import { onSocket, emit } from "./socket.js";

const SETTING = 'automation';
const PREFS = 'automationPrefs';
const FRIENDLY = 1;
// Условия, которым нужна выделенная цель
const NEEDS_TARGET = ['target_bloodied', 'hostile_target', 'target_anomaly'];

export function registerTriggerSettings() {
    game.settings.register(MODULE_ID, SETTING, {
        name: 'Автоматизация синергий и навыков',
        hint: 'Доп. урон «1 раз в ход» добавляется к броску урона сам, лечение после броска применяется само, реакции на урон и действия в начале хода и боя предлагаются владельцу окном. Выключите, чтобы пользоваться только кнопками.',
        scope: 'world', config: true, type: Boolean, default: true
    });
    // Личные галочки игрока: в v13 — за пользователем на сервере, в v12 — в браузере
    game.settings.register(MODULE_ID, PREFS, {
        scope: (game.release?.generation ?? 12) >= 13 ? 'user' : 'client',
        config: false, type: Object, default: {}
    });
}

function enabled() {
    try {
        return !!game.settings.get(MODULE_ID, SETTING);
    } catch (err) {
        return false;
    }
}

// ==========================================
// ИСТОЧНИКИ: ПОРОГИ СИНЕРГИЙ И ЭКИПИРОВАННЫЕ НАВЫКИ
// ==========================================

// Способность синергии — её заряды тратит реакция синергии
function featureItem(actor, name) {
    return actor.items.find(i => i.flags?.[MODULE_ID]?.is_synergy_item && i.name === name) ?? null;
}

/**
 * Срабатывания персонажа для события: { id, name, trigger, item, skill }.
 * item — навык (skill: true) или способность синергии (может отсутствовать).
 */
export function activeTriggers(actor, on, { all = false } = {}) {
    const counts = actor?.getFlag?.(MODULE_ID, 'counts') ?? {};
    const result = [];
    for (const config of Object.values(getSynergyDictionary())) {
        const count = counts[config.key] ?? 0;
        for (const tier of config.thresholds) {
            if (tier.trigger?.on !== on || count < tier.count) continue;
            const id = `${config.key}:${tier.count}`;
            result.push({ id, prefKey: `syn-${config.key}-${tier.count}`, name: tier.name, trigger: tier.trigger, item: featureItem(actor, tier.name), skill: false });
        }
    }
    for (const item of actor?.items ?? []) {
        const flags = item.flags?.[MODULE_ID] ?? {};
        if (flags.trigger?.on !== on || !flags.is_active || flags.is_crystal_item) continue;
        result.push({ id: `skill:${item.id}`, prefKey: `skill-${flags.skill_id ?? item.id}`, name: item.name, trigger: flags.trigger, item, skill: true });
    }
    return all ? result : result.filter(source => getPref(source).enabled);
}

// ==========================================
// ЛИЧНЫЕ ГАЛОЧКИ ИГРОКА: «ВКЛ.» И «СПРАШИВАТЬ»
// ==========================================

export const TRIGGER_EVENTS = ['damage_roll', 'damaged', 'turn_start', 'combat_start'];
// По умолчанию доп. урон добавляется сам, остальное спрашивается
const DEFAULT_ASK = { damage_roll: false, damaged: true, turn_start: true, combat_start: true };
export const KIND_LABELS = {
    damage_roll: trigger => trigger.heal_self ? 'лечение после урона' : 'доп. урон',
    damaged: () => 'реакция на урон',
    turn_start: () => 'начало хода',
    combat_start: () => 'начало боя'
};

export function readPrefs() {
    try {
        return game.settings.get(MODULE_ID, PREFS) ?? {};
    } catch (err) {
        return {};
    }
}

/** Галочки этого клиента для срабатывания: { enabled, ask } */
export function getPref(source) {
    const saved = readPrefs()[source.prefKey] ?? {};
    return { enabled: saved.enabled ?? true, ask: saved.ask ?? DEFAULT_ASK[source.trigger.on] };
}

export async function savePrefs(prefs) {
    await game.settings.set(MODULE_ID, PREFS, prefs);
}

const activityOf = item => item?.system?.activities?.contents?.[0] ?? [...(item?.system?.activities?.values?.() ?? [])][0] ?? null;

// Заряды: null — у источника зарядов нет (без ограничения)
function usesLeft(item) {
    const max = parseInt(item?.system?.uses?.max) || 0;
    if (!max) return null;
    return max - (item.system.uses.spent || 0);
}
const hasUse = item => usesLeft(item) === null || usesLeft(item) > 0;

async function spendUse(item) {
    if (usesLeft(item) === null) return;
    await item.update({ 'system.uses.spent': (item.system.uses.spent || 0) + 1 });
}

// Кость урона: своя формула или формула активности навыка текущего ранга
function bonusRoll(source, ctx) {
    const bonus = source.trigger.bonus;
    let formula = bonus.formula;
    let type = bonus.type;
    if (bonus.from === 'damage') {
        const part = activityOf(source.item)?.damage?.parts?.[0];
        formula = part?.custom?.formula || part?.formula;
        type = [...(part?.types ?? [])][0];
    } else if (bonus.from === 'roll') {
        formula = activityOf(source.item)?.roll?.formula;
    }
    if (!formula || !type) return null;
    if (bonus.double_when && CONDITIONS[bonus.double_when]?.(ctx)) formula = `2 * (${formula})`;
    return { formula, type };
}

// ==========================================
// УСЛОВИЯ, ХОД, ВЗВОД
// ==========================================

const hp = actor => actor?.system?.attributes?.hp ?? {};
const firstTarget = () => game.user?.targets?.first?.() ?? [...(game.user?.targets ?? [])][0] ?? null;

// Аномалия: аберрация или существо, чей вид записан как «Аномалия» (свой тип или подтип)
function isAnomaly(actor) {
    const type = actor?.system?.details?.type ?? {};
    const text = `${type.custom ?? ''} ${type.subtype ?? ''}`.toLowerCase();
    return type.value === 'aberration' || text.includes('аномал');
}

const CONDITIONS = {
    self_wounded: ({ actor }) => hp(actor).value < hp(actor).max,
    self_bloodied: ({ actor }) => hp(actor).value < hp(actor).max / 2,
    target_bloodied: ({ target }) => !!target?.actor && hp(target.actor).value < hp(target.actor).max / 2,
    // Враждебной считается любая не дружественная цель: нейтральное существо, на которое напали, — тоже враг
    hostile_target: ({ actor, target }) => !!target?.actor && target.actor !== actor
        && (target.document?.disposition ?? target.disposition) !== FRIENDLY,
    target_anomaly: ({ target }) => isAnomaly(target?.actor),
    attack_only: ({ activity }) => activity?.type === 'attack'
};

function conditionsMet(when = [], ctx) {
    return when.every(name => CONDITIONS[name]?.(ctx));
}

function currentCombat(actor) {
    return game.combats?.find?.(c => c.started && c.combatants?.some(cb => cb.actor?.id === actor.id)) ?? null;
}

// Ход текущего боя персонажа; вне боя — null (ограничения нет)
function turnKey(actor) {
    const combat = currentCombat(actor);
    return combat ? `${combat.id}:${combat.round}:${combat.turn}` : null;
}

// Срабатывания в этом ходу — в памяти клиента того, кто бросает урон
const usedThisTurn = new Map();
const usedNow = (actor, source, key) => key !== null && usedThisTurn.get(`${actor.id}:${source.id}`) === key;

// Взвод (once: primed): навык использован — следующая подходящая атака в этом ходу получает кость
const primed = new Map();
const FREE = 'free';
function isPrimed(actor, source, key) {
    const value = primed.get(`${actor.id}:${source.id}`);
    return value === FREE || (value !== undefined && value === key);
}

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    const actor = item?.actor;
    const flags = item?.flags?.[MODULE_ID] ?? {};
    if (!enabled() || !actor?.isOwner || flags.trigger?.once !== 'primed' || !flags.is_active) return;
    primed.set(`${actor.id}:skill:${item.id}`, turnKey(actor) ?? FREE);
    ui.notifications.info(`${item.name}: следующая атака в этом ходу получит доп. урон.`);
});

// Урон атакой или заклинанием — не лечение и не кнопки самих синергий, навыков и кристаллов
function isOffensiveDamage(activity) {
    const item = activity?.item;
    if (!item || activity.type === 'heal') return false;
    const flags = item.flags?.[MODULE_ID] ?? {};
    if (flags.is_synergy_item || flags.is_crystal_item || flags.skill_name) return false;
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

    const ctx = { actor, activity, target: firstTarget() };
    const key = turnKey(actor);
    const fired = [];
    for (const source of activeTriggers(actor, 'damage_roll')) {
        const { trigger } = source;
        const once = trigger.once ?? 'turn';
        if (once === 'turn' && usedNow(actor, source, key)) continue;
        if (once === 'primed' && !isPrimed(actor, source, key)) continue;
        if (source.skill && !hasUse(source.item)) continue;
        if (!conditionsMet((trigger.when ?? []).filter(w => !NEEDS_TARGET.includes(w)), ctx)) continue;
        if (!ctx.target && (trigger.when ?? []).some(w => NEEDS_TARGET.includes(w))) {
            ui.notifications.info(`${source.name}: выделите цель перед броском урона, иначе срабатывание пропадёт.`);
            continue;
        }
        if (!conditionsMet(trigger.when, ctx)) continue;
        const ask = getPref(source).ask;
        if (trigger.bonus) {
            const bonus = bonusRoll(source, ctx);
            if (!bonus) continue;
            if (ask) {
                fired.push({ ...source, offer: bonus });
                continue;
            }
            config.rolls ??= [];
            config.rolls.push({ parts: [bonus.formula], data: actor.getRollData(), options: { type: bonus.type, types: [bonus.type] } });
            ui.notifications.info(`${source.name}: +${bonus.formula} (${CONFIG.DND5E?.damageTypes?.[bonus.type]?.label ?? bonus.type})`);
        }
        fired.push({ ...source, ask });
    }
    if (fired.length) pending.set(activity.uuid ?? activity.id, { actor, key, fired });
});

Hooks.on('dnd5e.rollDamageV2', async (rolls, { subject } = {}) => {
    const entry = subject && pending.get(subject.uuid ?? subject.id);
    if (!entry) return;
    pending.delete(subject.uuid ?? subject.id);
    const { actor, key, fired } = entry;
    for (const source of fired) {
        // «Спрашивать»: доп. урон ждёт кнопки в чате и тратится только по нажатию
        if (source.offer) {
            await offerBonusCard(actor, source, key);
            continue;
        }
        const heal = source.trigger.heal_self;
        if (heal && source.ask && !await confirm(source.name, `<p>${actor.name}: восстановить ${shownFormula(heal.formula, actor)} ПЗ?</p>`)) continue;
        await commitUse(actor, source, key);
        if (!heal) continue;
        try {
            const roll = await new Roll(heal.formula, actor.getRollData()).evaluate();
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${source.name}: лечение` });
            await actor.applyDamage([{ value: roll.total, type: 'healing' }]);
        } catch (err) {
            console.error(`${MODULE_ID} | ${source.name}:`, err);
            ui.notifications.error(`${source.name}: лечение не применилось — подробности в консоли (F12).`);
        }
    }
});

// Срабатывание состоялось: «1 раз в ход», взвод и заряд навыка
async function commitUse(actor, source, key) {
    if (key !== null) usedThisTurn.set(`${actor.id}:${source.id}`, key);
    if (source.trigger.once === 'primed') primed.delete(`${actor.id}:${source.id}`);
    if (source.skill) await spendUse(source.item);
}

// Карточка в чате с кнопкой доп. урона — видит только владелец
const offers = new Map();
async function offerBonusCard(actor, source, key) {
    const id = foundry.utils.randomID();
    offers.set(id, { actor, source, key, bonus: source.offer });
    const label = CONFIG.DND5E?.damageTypes?.[source.offer.type]?.label ?? source.offer.type;
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        whisper: [game.user.id],
        content: `<div class="gachadnd-trigger-offer"><p><strong>${source.name}</strong>: добавить ${shownFormula(source.offer.formula, actor)} (${label})?</p>
            <button type="button" data-gd-offer="${id}"><i class="fas fa-dice-d20"></i> Бросить урон</button></div>`
    });
}

async function acceptOffer(id, button) {
    const offer = offers.get(id);
    if (!offer) return ui.notifications.warn('Предложение устарело — оно действует до перезагрузки и только в своём ходу.');
    const { actor, source, key, bonus } = offer;
    if (source.trigger.once !== 'none' && key !== null && key !== turnKey(actor)) return ui.notifications.warn(`${source.name}: ход уже закончился.`);
    if (usedNow(actor, source, key) && (source.trigger.once ?? 'turn') === 'turn') return ui.notifications.warn(`${source.name}: уже использовано в этом ходу.`);
    offers.delete(id);
    if (button) button.disabled = true;
    await commitUse(actor, source, key);
    await CONFIG.Dice.DamageRoll.build(
        { rolls: [{ parts: [bonus.formula], data: actor.getRollData(), options: { type: bonus.type, types: [bonus.type] } }] },
        { configure: false },
        { data: { speaker: ChatMessage.getSpeaker({ actor }), flavor: source.name, flags: { dnd5e: { messageType: 'roll', roll: { type: 'damage' } } } } }
    );
}

function bindOffers(message, html) {
    const root = html;
    root?.querySelectorAll?.('[data-gd-offer]:not([data-bound])').forEach(button => {
        button.dataset.bound = '1';
        button.addEventListener('click', () => acceptOffer(button.dataset.gdOffer, button));
    });
}
onRenderChatMessage(bindOffers);

// ==========================================
// ОКНА ВЛАДЕЛЬЦУ
// ==========================================

// Кому предлагать: игроку-владельцу в игре, иначе Мастеру. Одинаково на всех клиентах
function responder(actor) {
    const players = game.users?.filter?.(u => u.active && !u.isGM && actor.testUserPermission?.(u, 'OWNER')) ?? [];
    return (players.find(u => u.character?.id === actor.id) ?? players[0] ?? game.users?.activeGM ?? game.user)?.id;
}

// Окна идут по одному: несколько срабатываний сразу не накрывают друг друга
let queue = Promise.resolve();
function enqueue(task) {
    queue = queue.then(task).catch(err => console.error(`${MODULE_ID} | триггер:`, err));
    return queue;
}

async function confirm(title, content) {
    return foundry.applications.api.DialogV2.confirm({ window: { title }, content, rejectClose: false });
}

const shownFormula = (formula, actor) => Roll.replaceFormulaData(formula, actor.getRollData(), { missing: '0' });

async function actorFrom({ actorId, tokenUuid }) {
    return (tokenUuid && (await fromUuid(tokenUuid))?.actor) || game.actors.get(actorId);
}

// ==========================================
// ПОЛУЧЕН УРОН: РЕАКЦИЯ
// ==========================================

// Реакции синергии нужна способность с зарядами; навык без зарядов — без ограничения
function reactionReady(source) {
    if (!source.skill) return !!source.item && (usesLeft(source.item) ?? 0) > 0;
    return hasUse(source.item);
}

Hooks.on('dnd5e.applyDamage', (actor, amount) => {
    if (!enabled() || !(amount > 0) || !actor) return;
    // Предложение рассылает один клиент — тот, кто применил урон
    for (const source of activeTriggers(actor, 'damaged', { all: true })) {
        if (!reactionReady(source)) continue;
        const message = { actorId: actor.id, tokenUuid: actor.token?.uuid ?? null, sourceId: source.id, amount, userId: responder(actor) };
        if (message.userId === game.user.id) enqueue(() => offerReaction(message, actor));
        else emit('triggerReaction', message);
    }
});

onSocket('triggerReaction', message => {
    if (message.userId === game.user.id) enqueue(() => offerReaction(message));
});

async function offerReaction(message, local = null) {
    const actor = local ?? await actorFrom(message);
    const source = actor && activeTriggers(actor, 'damaged').find(s => s.id === message.sourceId);
    if (!source || !reactionReady(source)) return;
    const { amount } = message;
    const { reduce, use } = source.trigger;
    const left = usesLeft(source.item);
    const charges = left === null ? '' : ` Осталось зарядов: ${left}.`;

    const ask = getPref(source).ask;
    // Навык, который просто используется реакцией (Блинк)
    if (use) {
        if (ask && !await confirm(source.name, `<p><strong>${actor.name}</strong> получает ${amount} урона.</p><p>Использовать «${source.name}» реакцией?${charges}</p>`)) return;
        await source.item.use();
        return;
    }

    const formula = reduce.from === 'roll' ? activityOf(source.item)?.roll?.formula : reduce.formula;
    const what = reduce.half ? `половину урона (${Math.floor(amount / 2)})` : shownFormula(formula, actor);
    if (ask && !await confirm(source.name, `<p><strong>${actor.name}</strong> получает ${amount} урона.</p><p>Реакцией уменьшить его на ${what}?${charges}</p>`)) return;

    let restored;
    if (reduce.half) {
        restored = Math.floor(amount / 2);
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<strong>${source.name}:</strong> ${actor.name} перенаправляет ${restored} урона атакующему — примените его к атакующему.`
        });
    } else {
        const roll = await new Roll(formula, actor.getRollData()).evaluate();
        restored = Math.min(roll.total, amount);
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${source.name}: урон уменьшен на ${restored}` });
    }
    await spendUse(source.item);
    if (restored > 0) await actor.applyDamage([{ value: restored, type: 'healing' }]);
}

// ==========================================
// НАЧАЛО ХОДА И НАЧАЛО БОЯ
// ==========================================

// Смена хода приходит всем клиентам; окно открывает только тот, кому оно адресовано
Hooks.on('updateCombat', (combat, changes) => {
    if (!enabled() || !combat.started || !('turn' in changes || 'round' in changes)) return;
    const started = changes.round === 1 && (combat.previous?.round ?? 0) === 0;
    if (started) {
        for (const actor of combat.combatants.map(c => c.actor).filter(Boolean)) {
            if (responder(actor) === game.user.id) enqueue(() => offerTurnTriggers(actor, 'combat_start'));
        }
    }
    const actor = combat.combatant?.actor;
    if (actor && responder(actor) === game.user.id) enqueue(() => offerTurnTriggers(actor, 'turn_start'));
});

async function offerTurnTriggers(actor, on) {
    for (const source of activeTriggers(actor, on)) {
        const { use, pay, advantage } = source.trigger;
        const ask = getPref(source).ask;
        if (use) {
            if (!hasUse(source.item)) continue;
            const drawback = source.item.flags?.[MODULE_ID]?.drawback_lifted ? null : source.item.flags?.[MODULE_ID]?.drawback;
            const when = on === 'combat_start' ? 'Начало боя' : 'Начало хода';
            const ok = !ask || await confirm(source.name, `<p>${when}: использовать «${source.name}»?</p>${drawback ? `<p><strong>Штраф:</strong> ${drawback}</p>` : ''}`);
            if (ok) await source.item.use();
            continue;
        }
        if (pay) {
            const shown = shownFormula(pay.formula, actor);
            const gain = advantage === 'attacks' ? ' Тогда до конца хода ваши броски атаки совершаются с преимуществом.' : '';
            if (ask && !await confirm(source.name, `<p>${actor.name}: получить ${shown} урона (его нельзя уменьшить или предотвратить)?${gain}</p>`)) continue;
            const roll = await new Roll(pay.formula, actor.getRollData()).evaluate();
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${source.name}: плата` });
            // Число без типа: dnd5e применяет его без сопротивлений и иммунитетов
            await actor.applyDamage(roll.total);
            if (advantage === 'attacks') await actor.setFlag(MODULE_ID, 'advantage_turn', turnKey(actor) ?? FREE);
        }
    }
}

// Преимущество на атаки до конца хода, в котором заплачено
Hooks.on('dnd5e.preRollAttackV2', (config) => {
    const actor = config?.subject?.actor;
    const flag = actor?.getFlag?.(MODULE_ID, 'advantage_turn');
    if (!enabled() || !flag) return;
    const key = turnKey(actor);
    if (flag !== key && !(flag === FREE && key === null)) return;
    config.advantage = true;
});
