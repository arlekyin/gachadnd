/**
 * Gacha Roguelike dnd5e — Счётчик ауры (красный навык)
 *
 * Включается бонусным действием на минуту (10 раундов) или до конца боя, как ярость. Аура — от 0 до 5.
 *
 * Набор: позёрство (трюк с ценой, объявленный до броска: удался — аура растёт, провалился — падает),
 * критическое попадание и добивание врага (+1), натуральная 1 (−1). Если с начала прошлого хода
 * персонаж не получил ауры, в начале хода аура −1; на 0 навык гаснет.
 *
 * Пороги: 2 — +1 к атакам и Запугиванию; 4 — враги в 10 футах совершают спасброски с помехой;
 * 5 — враг, начинающий ход в 15 футах, проходит спасбросок Мудрости или испуган до конца своего хода.
 * Финал «Не в этой арке»: урон по персонажу при ауре 3+ — владелец может потратить всю ауру, и урон
 * не проходит (навык гаснет).
 *
 * Состояние — флаг персонажа aura { active, value, gained, combatId, round, last }; меняет его Мастер.
 * Объявленная поза — флаг auraPose { id, price, text, combatId, round, status }; его ставит владелец.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { onRenderChatMessage } from "../../core/chat-hooks.js";
import { addTurnEffect } from "./turn-effects.js";

export const MAX = 5;
export const ROUNDS = 10;
export const FINALE = 3;
const PRESSURE_FT = 10;
const FEAR_FT = 15;
const ASK_MS = 45000;

export const TIERS = [
    { at: 2, name: 'Уверенность', text: '+1 к броскам атаки и к проверкам Запугивания.' },
    { at: 4, name: 'Давление', text: `Враги в ${PRESSURE_FT} футах от вас совершают спасброски с помехой.` },
    { at: 5, name: 'Главный герой', text: `Враг, начинающий ход в ${FEAR_FT} футах от вас, совершает спасбросок Мудрости (Сл 8 + бонус мастерства + модификатор Харизмы); провал — испуган до конца своего хода.` }
];

export const PRICES = {
    casual: { label: 'Небрежно', hint: 'помеха на бросок', dis: true, gain: 1, loss: 1 },
    onehand: { label: 'Одной левой', hint: '−5 к броску', penalty: 5, gain: 1, loss: 1 },
    open: { label: 'Открыться', hint: 'КД −2 до начала вашего следующего хода, бросок обычный', ac: 2, gain: 1, loss: 0 },
    allin: { label: 'Ва-банк', hint: 'помеха и КД −2', dis: true, ac: 2, gain: 2, loss: 2 }
};

const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '');
export const auraText = delta => `${delta > 0 ? '+' : '−'}${Math.abs(delta) * 1000} aura`;

export const isAura = item => {
    const flags = item?.flags?.[MODULE_ID];
    return !!flags?.aura && !flags.is_crystal_item;
};
export const auraSkill = actor => actor?.items?.find(i => isAura(i) && i.flags[MODULE_ID].is_active) ?? null;
/** Включённая аура персонажа или null */
export const auraOf = actor => {
    const state = actor?.getFlag?.(MODULE_ID, 'aura');
    return state?.active ? state : null;
};
export const poseOf = actor => actor?.getFlag?.(MODULE_ID, 'auraPose') ?? null;

/** Токен персонажа на текущей сцене */
const tokenOf = actor => actor?.getActiveTokens?.()[0] ?? null;
function actorFrom({ actorId, tokenId, sceneId }) {
    const token = tokenId ? game.scenes.get(sceneId)?.tokens.get(tokenId) : null;
    return token?.actor ?? game.actors.get(actorId);
}
const ref = actor => {
    const token = tokenOf(actor);
    return { actorId: actor.id, tokenId: token?.document?.id ?? null, sceneId: token?.document?.parent?.id ?? canvas?.scene?.id ?? null };
};

/** Расстояние между токенами в футах: по клеткам, от края до края */
export function feetBetween(a, b) {
    const size = canvas.grid.size, distance = canvas.scene?.grid?.distance ?? canvas.dimensions?.distance ?? 5;
    const box = t => {
        const d = t.document;
        return { x0: d.x, y0: d.y, x1: d.x + (d.width || 1) * size, y1: d.y + (d.height || 1) * size };
    };
    const p = box(a), q = box(b);
    const dx = Math.max(0, q.x0 - p.x1, p.x0 - q.x1) / size, dy = Math.max(0, q.y0 - p.y1, p.y0 - q.y1) / size;
    return Math.max(Math.round(dx), Math.round(dy)) * distance;
}
/** Враги друг другу: отношение токенов противоположное */
const hostile = (a, b) => {
    const x = a.document.disposition, y = b.document.disposition;
    return !!x && !!y && x === -y;
};
/** Токены с аурой не ниже level на сцене */
function auraTokens(level) {
    return (canvas?.tokens?.placeables ?? []).filter(t => (auraOf(t.actor)?.value ?? 0) >= level);
}

// ==========================================
// МАСТЕР: ИЗМЕНЕНИЯ АУРЫ
// ==========================================

const save = (actor, state) => actor.update({ [`flags.${MODULE_ID}.aura`]: state });
const stamp = (delta, reason) => ({ delta, reason, at: Date.now() + Math.random() });

async function gmStart(actor, combat) {
    const state = { active: true, value: 1, gained: true, combatId: combat?.id ?? null, round: combat?.round ?? 0, last: stamp(1, 'Аура включена') };
    await save(actor, state);
    await syncTier(actor, state.value);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-aura-card"><div class="gd-aura-title"><i class="fas fa-crown"></i> Счётчик ауры включён</div><p>Аура: 1 из ${MAX}. Каждый ход без ауры стоит −1; на 0 навык гаснет.</p></div>`
    });
}

async function gmEnd(actor, reason) {
    const state = actor.getFlag(MODULE_ID, 'aura');
    if (!state?.active) return;
    await save(actor, { ...state, active: false, value: 0, last: stamp(0, reason) });
    await syncTier(actor, 0);
    if (poseOf(actor)) await actor.unsetFlag(MODULE_ID, 'auraPose');
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-aura-card off"><div class="gd-aura-title"><i class="fas fa-crown"></i> Аура погасла</div><p>${esc(reason)}.</p></div>`
    });
}

/** Мастер: аура +delta (с пределами); на 0 — гаснет */
export async function gmChange(actor, delta, reason) {
    const state = auraOf(actor);
    if (!state || !delta) return;
    const value = Math.max(0, Math.min(MAX, state.value + delta));
    const next = { ...state, value, last: stamp(delta, reason) };
    if (delta > 0) next.gained = true;
    await save(actor, next);
    if (value <= 0) return gmEnd(actor, `${reason} — аура упала до нуля`);
    await syncTier(actor, value);
}

/** Порог 2: активный эффект «Уверенность» */
async function syncTier(actor, value) {
    const effects = [...(actor.effects ?? [])].filter(e => e.flags?.[MODULE_ID]?.auraTier);
    if (value >= TIERS[0].at) {
        if (effects.length) return;
        const changes = ['mwak', 'rwak', 'msak', 'rsak'].map(k => ({ key: `system.bonuses.${k}.attack`, mode: 2, value: '+1' }));
        changes.push({ key: 'system.skills.itm.bonuses.check', mode: 2, value: '+1' });
        await actor.createEmbeddedDocuments('ActiveEffect', [{
            name: 'Аура: Уверенность', img: 'icons/svg/aura.svg', showIcon: 2, changes,
            description: TIERS[0].text, flags: { [MODULE_ID]: { auraTier: true } }
        }]);
    } else if (effects.length) {
        await actor.deleteEmbeddedDocuments('ActiveEffect', effects.map(e => e.id));
    }
}

onSocket('auraStart', ({ payload }) => {
    if (!isActiveGM()) return;
    const actor = actorFrom(payload);
    if (actor && !auraOf(actor)) gmStart(actor, game.combat).catch(error => console.error(`${MODULE_ID} | Аура`, error));
});
onSocket('auraChange', ({ payload }) => {
    if (!isActiveGM()) return;
    const actor = actorFrom(payload);
    if (actor) gmChange(actor, payload.delta, payload.reason).catch(error => console.error(`${MODULE_ID} | Аура`, error));
});
onSocket('auraFinale', ({ payload }) => {
    if (!isActiveGM()) return;
    const actor = actorFrom(payload);
    const state = auraOf(actor);
    if (!state) return;
    ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-aura-card finale"><div class="gd-aura-title"><i class="fas fa-crown"></i> Не в этой арке</div><p>${esc(actor.name)} тратит всю ауру (${state.value}) — урон ${payload.amount} не прошёл.</p></div>`
    });
    gmEnd(actor, 'Не в этой арке: аура потрачена').catch(error => console.error(`${MODULE_ID} | Аура`, error));
});

export const requestStart = actor => requestGM('auraStart', ref(actor));
export const requestChange = (actor, delta, reason) => requestGM('auraChange', { ...ref(actor), delta, reason });

// ==========================================
// ХОДЫ: УБЫВАНИЕ, СРОК, СТРАХ
// ==========================================

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const current = combat.combatant;
    const actor = current?.actor;
    const state = auraOf(actor);
    if (state) {
        if (state.combatId && state.combatId !== combat.id) await gmEnd(actor, 'Бой окончен');
        else if (combat.round >= (state.round ?? 0) + ROUNDS) await gmEnd(actor, 'Минута прошла');
        else if (!state.gained) await gmChange(actor, -1, 'Ход без ауры');
        else await save(actor, { ...state, gained: false });
    }
    await fear(combat, current);
});

/** Порог 5: враг, начинающий ход рядом с «главным героем», — спасбросок Мудрости */
async function fear(combat, combatant) {
    const enemy = combatant?.token?.object ?? canvas?.tokens?.get?.(combatant?.tokenId);
    const actor = enemy?.actor;
    if (!actor || (actor.system?.attributes?.hp?.value ?? 1) <= 0) return;
    for (const hero of auraTokens(MAX)) {
        if (hero === enemy || !hostile(hero, enemy) || feetBetween(hero, enemy) > FEAR_FT) continue;
        const source = hero.actor;
        const dc = 8 + (source.system?.attributes?.prof ?? 2) + (source.system?.abilities?.cha?.mod ?? 0);
        const success = await wisdomSave(actor, dc);
        if (success) continue;
        await addTurnEffect(actor, combat, {
            name: 'Испуган аурой', img: 'icons/svg/terror.svg', statuses: ['frightened'],
            description: `Аура ${source.name}: испуган до конца своего хода.`
        }, { until: 'thisTurn', tokenId: enemy.document.id });
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: source }),
            content: `<div class="gd-aura-card"><div class="gd-aura-title"><i class="fas fa-crown"></i> Главный герой</div><p>${esc(enemy.name)} проваливает спасбросок Мудрости (Сл ${dc}) — испуган до конца своего хода.</p></div>`
        });
        return;
    }
}

async function wisdomSave(actor, dc) {
    try {
        if (typeof actor.rollSavingThrow === 'function') {
            const rolls = await actor.rollSavingThrow({ ability: 'wis', target: dc }, { configure: false }, {});
            const roll = Array.isArray(rolls) ? rolls[0] : rolls;
            if (roll) return roll.isSuccess ?? roll.total >= dc;
        }
    } catch (error) {
        console.warn(`${MODULE_ID} | Аура: спасбросок`, error);
    }
    const save = actor.system?.abilities?.wis?.save;
    const mod = Number(typeof save === 'object' ? save?.value : save) || actor.system?.abilities?.wis?.mod || 0;
    const roll = await new Roll('1d20 + @mod', { mod }).evaluate();
    await roll.toMessage?.({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `Спасбросок Мудрости (Сл ${dc}) против ауры` });
    return roll.total >= dc;
}

// Добивание врага в ход персонажа с аурой: +1
const killed = new Set();
Hooks.on('updateActor', (actor, changes) => {
    const hp = changes?.system?.attributes?.hp?.value;
    if (hp === undefined || !isActiveGM()) return;
    const key = actor.uuid ?? actor.id;
    if (hp > 0) { killed.delete(key); return; }
    if (killed.has(key)) return;
    const combat = game.combat;
    const owner = combat?.started ? combat.combatant?.actor : null;
    if (!owner || owner === actor || !auraOf(owner)) return;
    const hero = tokenOf(owner), victim = tokenOf(actor);
    if (!hero || !victim || !hostile(hero, victim)) return;
    killed.add(key);
    gmChange(owner, 1, 'Добивание').catch(error => console.error(`${MODULE_ID} | Аура`, error));
});

Hooks.on('deleteCombat', async combat => {
    killed.clear();
    if (!isActiveGM()) return;
    for (const combatant of combat.combatants) {
        const actor = combatant.actor;
        if (auraOf(actor)) await gmEnd(actor, 'Бой окончен');
    }
});

// ==========================================
// ПОЗЁРСТВО: ЦЕНА ДО БРОСКА
// ==========================================

/** Можно ли объявить позу: причина отказа или null */
export function canPose(actor) {
    if (!auraOf(actor)) return 'Аура не включена.';
    const combat = game.combat;
    if (!combat?.started) return 'Позёрство — только в бою.';
    const pose = poseOf(actor);
    if (pose?.status === 'ready') return 'Поза уже объявлена — ждёт броска.';
    if (pose && pose.combatId === combat.id && pose.round === combat.round) return 'В этом раунде поза уже была.';
    return null;
}

export async function declarePose(actor, price, text) {
    const reason = canPose(actor);
    if (reason) return ui.notifications.warn(reason);
    if (!PRICES[price]) return;
    const combat = game.combat;
    await actor.setFlag(MODULE_ID, 'auraPose', { id: foundry.utils.randomID(), price, text: String(text ?? '').trim(), combatId: combat.id, round: combat.round, status: 'ready' });
}

export async function cancelPose(actor) {
    if (poseOf(actor)?.status === 'ready') await actor.unsetFlag(MODULE_ID, 'auraPose');
}

// Субъект броска: персонаж (проверка, спасбросок) или активность (атака)
const subjectActor = subject => subject?.documentName === 'Actor' || typeof subject?.getActiveTokens === 'function' ? subject : (subject?.actor ?? subject?.item?.actor ?? null);
// Поза, которую уже забрал бросок (флаг обновляется не сразу)
const spent = new Set();

Hooks.on('dnd5e.preRollD20TestV2', (config) => {
    const actor = subjectActor(config?.subject);
    const hooks = config?.hookNames ?? [];
    if (!actor || hooks.includes('initiativeDialog')) return;
    const rolls = config.rolls ??= [{}];

    // Поза: цена на этот бросок
    const pose = auraOf(actor) ? poseOf(actor) : null;
    if (pose?.status === 'ready' && !spent.has(pose.id)) {
        const price = PRICES[pose.price];
        spent.add(pose.id);
        for (const roll of rolls) {
            roll.options ??= {};
            roll.options.gachadndPose = pose.id;
            if (price.dis) roll.options.disadvantage = true;
            if (price.penalty) roll.parts = [...(roll.parts ?? []), `-${price.penalty}`];
        }
        if (price.dis) config.disadvantage = true;
        actor.setFlag(MODULE_ID, 'auraPose', { ...pose, status: 'rolled' });
        if (price.ac) {
            const combat = game.combat;
            addTurnEffect(actor, combat, {
                name: `Позёрство: ${price.label}`, img: 'icons/svg/downgrade.svg',
                changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: `-${price.ac}` }],
                description: `КД −${price.ac} до начала вашего следующего хода.`
            }, { until: 'nextStart', tokenId: tokenOf(actor)?.document?.id ?? null });
        }
    }

    // Порог 4: враги рядом с аурой — спасброски с помехой
    if (hooks.includes('savingThrow')) {
        const token = tokenOf(actor);
        if (token && auraTokens(TIERS[1].at).some(hero => hero !== token && hostile(hero, token) && feetBetween(hero, token) <= PRESSURE_FT)) {
            for (const roll of rolls) (roll.options ??= {}).disadvantage = true;
            config.disadvantage = true;
        }
    }
});

// ==========================================
// ИТОГ БРОСКА
// ==========================================

/** Цель броска атаки: КД единственной цели */
function attackTarget(roll) {
    if (Number.isFinite(Number(roll.options?.target)) && roll.options.target !== null) return Number(roll.options.target);
    const targets = [...(game.user.targets ?? [])];
    return targets.length === 1 ? targets[0].actor?.system?.attributes?.ac?.value ?? null : null;
}

/** true / false — удался ли бросок; null — сложность неизвестна */
function outcome(roll, kind) {
    if (kind === 'attack') {
        if (roll.isCritical) return true;
        if (roll.isFumble) return false;
        const ac = attackTarget(roll);
        return ac === null ? null : roll.total >= ac;
    }
    const target = roll.options?.target;
    if (target === undefined || target === null || !Number.isFinite(Number(target))) return null;
    return roll.total >= Number(target);
}

function poseCard(actor, pose, result) {
    const price = PRICES[pose.price];
    const text = pose.text ? `<blockquote>${esc(pose.text)}</blockquote>` : '';
    const line = result === null
        ? '<p class="gd-aura-wait">Сложность броска неизвестна — итог за Мастером.</p><div class="gd-aura-buttons"><button type="button" data-aura-pose="win">Удалось</button><button type="button" data-aura-pose="fail">Не удалось</button></div>'
        : `<p class="gd-aura-result ${result ? 'win' : 'fail'}">${result ? `Удалось: ${auraText(price.gain)}` : (price.loss ? `Не удалось: ${auraText(-price.loss)}` : 'Не удалось — но аура не упала')}</p>`;
    return `<div class="gd-aura-card pose"><div class="gd-aura-title"><i class="fas fa-crown"></i> Позёрство — ${price.label}</div>${text}<p class="gd-aura-price">Цена: ${price.hint}.</p>${line}</div>`;
}

function onRoll(rolls, data, kind) {
    const roll = rolls?.[0];
    const actor = kind === 'attack' ? subjectActor(data?.subject) : data?.subject;
    if (!roll || !auraOf(actor)) return;
    const poseId = roll.options?.gachadndPose;
    const pose = poseId ? poseOf(actor) : null;
    if (pose && pose.id === poseId) {
        const price = PRICES[pose.price];
        const result = outcome(roll, kind);
        actor.setFlag(MODULE_ID, 'auraPose', { ...pose, status: 'done' });
        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: poseCard(actor, pose, result),
            flags: { [MODULE_ID]: { auraPose: { ...ref(actor), price: pose.price, text: pose.text, resolved: result !== null } } }
        });
        if (result === true) requestChange(actor, price.gain, `Позёрство: ${price.label}`);
        else if (result === false && price.loss) requestChange(actor, -price.loss, `Позёрство не удалось: ${price.label}`);
        return;
    }
    if (kind === 'attack' && roll.isCritical) requestChange(actor, 1, 'Критическое попадание');
    else if (roll.isFumble) requestChange(actor, -1, 'Натуральная 1');
}

Hooks.on('dnd5e.rollAttackV2', (rolls, data) => onRoll(rolls, data, 'attack'));
Hooks.on('dnd5e.rollAbilityCheckV2', (rolls, data) => onRoll(rolls, data, 'check'));
Hooks.on('dnd5e.rollSkillV2', (rolls, data) => onRoll(rolls, data, 'check'));
Hooks.on('dnd5e.rollToolCheckV2', (rolls, data) => onRoll(rolls, data, 'check'));
Hooks.on('dnd5e.rollSavingThrowV2', (rolls, data) => onRoll(rolls, data, 'save'));

// Итог позы, когда сложность неизвестна: кнопки на карточке — у Мастера
onRenderChatMessage((message, html) => {
    const flag = message.flags?.[MODULE_ID]?.auraPose;
    if (!flag || !html) return;
    const buttons = html.querySelectorAll?.('[data-aura-pose]') ?? [];
    for (const button of buttons) {
        if (!game.user.isGM || flag.resolved) { button.disabled = true; continue; }
        button.addEventListener('click', () => resolvePoseCard(message, button.dataset.auraPose === 'win'));
    }
});

export async function resolvePoseCard(message, win) {
    const flag = message.flags?.[MODULE_ID]?.auraPose;
    if (!flag || flag.resolved || !game.user.isGM) return;
    const actor = actorFrom(flag);
    const price = PRICES[flag.price];
    if (!actor || !price) return;
    await message.update({
        content: poseCard(actor, { price: flag.price, text: flag.text }, win),
        [`flags.${MODULE_ID}.auraPose.resolved`]: true
    });
    if (win) await gmChange(actor, price.gain, `Позёрство: ${price.label}`);
    else if (price.loss) await gmChange(actor, -price.loss, `Позёрство не удалось: ${price.label}`);
}

// ==========================================
// ФИНАЛ: «НЕ В ЭТОЙ АРКЕ»
// ==========================================

const passing = new Set();
const asking = new Set();

Hooks.on('dnd5e.preApplyDamage', (actor, amount) => {
    if (!(amount > 0)) return;
    const key = actor.uuid ?? actor.id;
    if (passing.delete(key)) return;
    const state = auraOf(actor);
    if (!state || state.value < FINALE || asking.has(key)) return;
    asking.add(key);
    askFinale(actor, amount, state.value)
        .then(yes => {
            if (yes) return requestGM('auraFinale', { ...ref(actor), amount });
            passing.add(key);
            return actor.applyDamage(amount, { ignore: true });
        })
        .catch(error => console.error(`${MODULE_ID} | Аура: финал`, error))
        .finally(() => asking.delete(key));
    return false;
});

/** Кто решает: игрок-владелец в игре, иначе активный Мастер */
function ownerUser(actor) {
    const player = game.users.find(u => !u.isGM && u.active && actor.testUserPermission?.(u, 'OWNER'));
    return player ?? game.users.activeGM ?? game.user;
}

const answers = new Map();
onSocket('auraAnswer', ({ askId, yes }) => answers.get(askId)?.(yes));
onSocket('auraAsk', async data => {
    if (data.userId !== game.user.id) return;
    const actor = actorFrom(data);
    const yes = actor ? await finaleDialog(actor, data.amount, data.value) : false;
    emit('auraAnswer', { askId: data.askId, yes });
});

function askFinale(actor, amount, value) {
    const user = ownerUser(actor);
    if (!user || user.id === game.user.id) return finaleDialog(actor, amount, value);
    const askId = foundry.utils.randomID();
    return new Promise(resolve => {
        const done = yes => { answers.delete(askId); clearTimeout(timer); resolve(!!yes); };
        const timer = setTimeout(() => done(false), ASK_MS);
        answers.set(askId, done);
        emit('auraAsk', { askId, userId: user.id, ...ref(actor), amount, value });
    });
}

function finaleDialog(actor, amount, value) {
    return foundry.applications.api.DialogV2.confirm({
        window: { title: `Не в этой арке — ${actor.name}` },
        content: `<p>${esc(actor.name)} получает <strong>${amount}</strong> урона.</p><p>Потратить всю ауру (${value}), чтобы урон не прошёл? Навык погаснет.</p>`,
        yes: { label: 'Не в этой арке' }, no: { label: 'Принять урон' },
        rejectClose: false
    }).then(yes => !!yes).catch(() => false);
}
