/**
 * Gacha Roguelike dnd5e — «Сыграем... в гвинт?» (красный навык)
 *
 * Колода из 12 карт, рука из трёх. Колода тасуется в начале каждого боя; в начале своего хода
 * персонаж добирает руку до трёх (колода кончилась — сброс тасуется обратно). Одна карта за ход —
 * бонусным действием, в свой ход, в бою. Карты разыгрываются из панели (gwent-panel.js): клик по
 * карте, при нужде — выбор цели на сцене; эффект выполняет Мастер.
 *
 * Состояние — во флаге персонажа: { combatId, deck, hand, discard, played }.
 */

import { MODULE_ID } from "../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { addTurnEffect } from "./turn-effects.js";
import { placeToken } from "./pick.js";

export const HAND = 3;
const RANGE = 30;
const ZONE = 15;
const ICON = 'systems/dnd5e/icons/svg';
const attackBonus = (key, value) => ['mwak', 'rwak', 'msak', 'rsak'].map(k => ({ key: `system.bonuses.${k}.${key}`, mode: 2, value }));

/**
 * Карты. target: null — без цели; 'point' — точка в пределах 30 футов; 'ally' — союзник в 30 футах;
 * 'discard' — карта из сброса.
 */
export const CARDS = {
    scorch: { name: 'Казнь', icon: 'fa-fire', count: 1, target: null,
        text: 'Существо с наибольшими ПЗ в 30 футах получает (бонус мастерства)d8 урона силовым полем.' },
    frost: { name: 'Трескучий мороз', icon: 'fa-snowflake', count: 2, target: 'point',
        text: 'Зона 15 футов: враги в ней — скорость вдвое меньше до конца своего следующего хода.' },
    fog: { name: 'Непроглядный туман', icon: 'fa-smog', count: 1, target: 'point',
        text: 'Зона 15 футов до конца боя: дальнобойные атаки в неё и из неё — с помехой.' },
    clear: { name: 'Ясное небо', icon: 'fa-sun', count: 1, target: null,
        text: 'Снимает все зоны погоды.' },
    horn: { name: 'Командирский рог', icon: 'fa-bullhorn', count: 2, target: 'ally',
        text: 'Союзник в 30 футах: +1d6 к броскам атаки и урону до конца его следующего хода.' },
    decoy: { name: 'Чучело', icon: 'fa-people-arrows', count: 2, target: 'ally',
        text: 'Вы и союзник в 30 футах меняетесь местами.' },
    spy: { name: 'Шпион', icon: 'fa-user-secret', count: 1, target: null,
        text: 'Возьмите 2 карты. До конца вашего следующего хода атаки по вам — с преимуществом.' },
    medic: { name: 'Медик', icon: 'fa-kit-medical', count: 1, target: 'discard',
        text: 'Верните в руку карту из сброса.' },
    witcher: { name: 'Ведьмак', icon: 'fa-paw', count: 1, target: null,
        text: 'Ваши атаки до конца этого хода наносят +2d6 урона.' }
};

export const SKILL_NAME = 'Сыграем... в гвинт?';
// Флаг из компендиума; навык, собранный без флага (старый компендиум), узнаётся по имени
export const isGwent = item => {
    const flags = item?.flags?.[MODULE_ID];
    if (!flags || flags.is_crystal_item) return false;
    return !!flags.gwent || (flags.skill_name ?? item.name) === SKILL_NAME;
};
export const gwentSkill = actor => actor?.items?.find(i => isGwent(i) && i.flags[MODULE_ID].is_active) ?? null;

const shuffled = list => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};
export const freshDeck = () => shuffled(Object.entries(CARDS).flatMap(([key, card]) => Array(card.count).fill(key)));

/** Состояние колоды персонажа (копия) */
export function stateOf(actor) {
    const saved = actor?.getFlag?.(MODULE_ID, 'gwent');
    return saved ? foundry.utils.deepClone(saved) : null;
}

/** Взять n карт: из колоды; кончилась — сброс тасуется в колоду */
function draw(state, n) {
    for (let i = 0; i < n; i++) {
        if (!state.deck.length) {
            if (!state.discard.length) break;
            state.deck = shuffled(state.discard);
            state.discard = [];
        }
        state.hand.push(state.deck.shift());
    }
    return state;
}

/** Колода на этот бой: новая, если бой другой */
export function ensureState(actor, combat) {
    const state = stateOf(actor);
    const combatId = combat?.id ?? null;
    if (state && state.combatId === combatId) return state;
    return draw({ combatId, deck: freshDeck(), hand: [], discard: [], played: null }, HAND);
}

const saveState = (actor, state) => actor.update({ [`flags.${MODULE_ID}.gwent`]: state });
const turnKey = combat => combat ? `${combat.id}.${combat.round}.${combat.turn}` : null;

// ==========================================
// ХОДЫ: ДОБОР, КОЛОДА НА БОЙ
// ==========================================

// Начало хода персонажа — добор до трёх; первый ход боя — новая колода
Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const actor = combat.combatant?.actor;
    if (!gwentSkill(actor)) return;
    const state = ensureState(actor, combat);
    draw(state, Math.max(0, HAND - state.hand.length));
    await saveState(actor, state);
});

// ==========================================
// РОЗЫГРЫШ
// ==========================================

/** Можно ли разыграть карту сейчас: бой, ход персонажа, ещё не играл в этот ход */
export function canPlay(actor) {
    const combat = game.combat;
    if (!combat?.started) return 'Карты играются только в бою.';
    if (combat.combatant?.actor?.id !== actor.id) return 'Карту можно сыграть только в свой ход.';
    if (stateOf(actor)?.played === turnKey(combat)) return 'В этот ход карта уже сыграна.';
    return null;
}

onSocket('gwentPlay', ({ payload }) => {
    if (!isActiveGM()) return;
    playCard(payload).catch(error => console.error(`${MODULE_ID} | Гвинт`, error));
});

/** Мастер: эффект карты, рука → сброс, запись в чат */
export async function playCard({ actorId, tokenId, sceneId, index, target = null }) {
    const scene = game.scenes.get(sceneId);
    const token = scene?.tokens.get(tokenId);
    const actor = token?.actor ?? game.actors.get(actorId);
    const combat = game.combat;
    const state = ensureState(actor, combat);
    const key = state.hand[index];
    const card = CARDS[key];
    if (!actor || !card) return;
    state.hand.splice(index, 1);
    state.discard.push(key);
    state.played = turnKey(combat);
    const esc = text => foundry.utils.escapeHTML?.(String(text)) ?? String(text);
    let result = '';
    const size = scene.grid.size;
    const center = t => ({ x: t.x + (t.width || 1) * size / 2, y: t.y + (t.height || 1) * size / 2 });
    const feet = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / size * (scene.grid.distance ?? 5);

    if (key === 'scorch') {
        const alive = t => t.id !== token.id && (t.actor?.system?.attributes?.hp?.value ?? 0) > 0 && feet(center(t), center(token)) <= RANGE;
        const near = scene.tokens.filter(alive);
        const top = Math.max(...near.map(t => t.actor.system.attributes.hp.value));
        const victims = near.filter(t => t.actor.system.attributes.hp.value === top);
        if (victims.length) {
            const prof = actor.system?.attributes?.prof ?? 2;
            const roll = await new Roll(`${prof}d8`).evaluate();
            for (const t of victims) await t.actor.applyDamage([{ value: roll.total, type: 'force' }]);
            result = `Казнь: ${esc(victims.map(t => t.name).join(', '))} — ${roll.total} урона силовым полем (${prof}d8).`;
        } else result = 'Казнь: в 30 футах никого.';
    } else if (key === 'frost' || key === 'fog') {
        await scene.createEmbeddedDocuments('MeasuredTemplate', [{
            t: 'circle', x: target.x, y: target.y, distance: ZONE, direction: 0,
            fillColor: key === 'frost' ? '#9fe3ff' : '#8a8f99', borderColor: key === 'frost' ? '#d6f4ff' : '#c4c8cf',
            flags: { [MODULE_ID]: { gwentWeather: key, actorId: actor.id } }
        }]);
        if (key === 'frost') {
            const disposition = token.disposition;
            const inside = scene.tokens.filter(t => t.disposition !== disposition && Math.hypot(center(t).x - target.x, center(t).y - target.y) <= ZONE / (scene.grid.distance ?? 5) * size + size / 2);
            for (const t of inside) {
                await addTurnEffect(t.actor, combat, {
                    name: 'Гвинт: Трескучий мороз', img: 'icons/svg/frozen.svg',
                    description: '<p>Скорость всех видов вдвое меньше.</p><p><em>Гвинт: до конца следующего хода этого существа.</em></p>',
                    changes: ['walk', 'fly', 'swim', 'climb', 'burrow'].map(m => ({ key: `system.attributes.movement.${m}`, mode: 1, value: '0.5' }))
                }, { tokenId: t.id });
            }
            result = `Трескучий мороз: ${inside.length ? `замедлены ${esc(inside.map(t => t.name).join(', '))}` : 'в зоне врагов нет'}.`;
        } else result = 'Непроглядный туман: дальнобойные атаки в зону и из неё — с помехой, до конца боя.';
    } else if (key === 'clear') {
        const ids = scene.templates.filter(t => t.flags?.[MODULE_ID]?.gwentWeather).map(t => t.id);
        if (ids.length) await scene.deleteEmbeddedDocuments('MeasuredTemplate', ids);
        result = `Ясное небо: снято зон — ${ids.length}.`;
    } else if (key === 'horn') {
        const ally = scene.tokens.get(target.tokenId);
        await addTurnEffect(ally.actor, combat, {
            name: 'Гвинт: Командирский рог', img: 'icons/svg/upgrade.svg',
            description: '<p>+1d6 к броскам атаки и урону.</p><p><em>Гвинт: до конца следующего хода этого существа.</em></p>',
            changes: [...attackBonus('attack', '+1d6'), ...attackBonus('damage', '+1d6')]
        }, { tokenId: ally.id });
        result = `Командирский рог: ${esc(ally.name)} — +1d6 к атакам и урону.`;
    } else if (key === 'decoy') {
        const ally = scene.tokens.get(target.tokenId);
        const a = { x: token.x, y: token.y }, b = { x: ally.x, y: ally.y };
        await placeToken(token, b.x, b.y);
        await placeToken(ally, a.x, a.y);
        result = `Чучело: ${esc(token.name)} и ${esc(ally.name)} поменялись местами.`;
    } else if (key === 'spy') {
        draw(state, 2);
        await addTurnEffect(actor, combat, {
            name: 'Гвинт: Шпион', img: `${ICON}/statuses/marked.svg`,
            description: '<p>Атаки по вам — с преимуществом.</p><p><em>Гвинт: до конца вашего следующего хода.</em></p>'
        }, { tokenId: token.id });
        result = 'Шпион: +2 карты в руку, атаки по персонажу — с преимуществом до конца его следующего хода.';
    } else if (key === 'medic') {
        // Сама «Медик» уже в сбросе — вернуть можно другую
        const i = state.discard.lastIndexOf(target.card);
        if (target.card && i >= 0 && target.card !== 'medic') {
            state.discard.splice(i, 1);
            state.hand.push(target.card);
            result = `Медик: в руку вернулась «${CARDS[target.card].name}».`;
        } else result = 'Медик: возвращать нечего.';
    } else if (key === 'witcher') {
        await addTurnEffect(actor, combat, {
            name: 'Гвинт: Ведьмак', img: 'icons/svg/sword.svg',
            description: '<p>Атаки наносят +2d6 урона.</p><p><em>Гвинт: до конца этого хода.</em></p>',
            changes: attackBonus('damage', '+2d6')
        }, { until: 'thisTurn', tokenId: token.id });
        result = 'Ведьмак: атаки до конца хода — +2d6 урона.';
    }

    await saveState(actor, state);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token }),
        content: `<div class="gd-gwent-card-msg"><i class="fas ${card.icon}"></i> <strong>${card.name}</strong><br><small>${card.text}</small><br>${result}</div>`
    });
}

/** Игрок: разыграть карту из руки (выбор цели — в панели) */
export function requestPlay(actor, token, index, target = null) {
    requestGM('gwentPlay', { actorId: actor.id, tokenId: token.document?.id ?? token.id, sceneId: canvas.scene.id, index, target });
}

// Конец боя — зоны погоды убираются
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    const scene = combat.scene ?? canvas?.scene;
    const ids = scene?.templates?.filter(t => t.flags?.[MODULE_ID]?.gwentWeather).map(t => t.id) ?? [];
    if (ids.length) await scene.deleteEmbeddedDocuments('MeasuredTemplate', ids);
});
