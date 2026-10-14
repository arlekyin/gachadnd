/**
 * Gacha Roguelike dnd5e — Чумовая пятница: карты и перепутанная очередь
 *
 * Карты: каждому участнику тасовки — одна случайная из 12 (6 бафов, 6 дебафов); заклинателю —
 * только баф. Карта — активный эффект на существе: штатное состояние dnd5e или числовые изменения;
 * держится до конца следующего хода этого существа и снимается сама (у Мастера).
 *
 * Очередь: значения инициативы тех, кто ещё не ходил в этом раунде, перемешиваются между ними —
 * кто уже походил, уже походил; текущий ход не сдвигается.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket, isActiveGM } from "../../core/socket.js";

const ICON = 'systems/dnd5e/icons/svg';
const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];
const ADD = 2, MULTIPLY = 1, OVERRIDE = 5;
const attack = value => ['mwak', 'rwak', 'msak', 'rsak'].map(k => ({ key: `system.bonuses.${k}.attack`, mode: ADD, value }));

export const CARDS = {
    // Бафы
    invisible: { buff: true, name: 'Невидимость', img: `${ICON}/statuses/invisible.svg`, statuses: ['invisible'] },
    dash: { buff: true, name: 'Рывок', img: `${ICON}/statuses/hovering.svg`, text: 'скорость ×2',
        changes: ['walk', 'fly', 'swim', 'climb', 'burrow'].map(m => ({ key: `system.attributes.movement.${m}`, mode: MULTIPLY, value: '2' })) },
    breath: { buff: true, name: 'Второе дыхание', img: `${ICON}/hit-points.svg`, text: 'временные ПЗ 2d8', temp: '2d8' },
    nerve: { buff: true, name: 'Кураж', img: 'icons/svg/upgrade.svg', text: '+2 к атакам', changes: attack('+2') },
    armor: { buff: true, name: 'Броня', img: `${ICON}/checked-shield.svg`, text: '+2 к КД', changes: [{ key: 'system.attributes.ac.bonus', mode: ADD, value: '+2' }] },
    tough: { buff: true, name: 'Неуязвимость', img: `${ICON}/trait-damage-resistances.svg`, text: 'сопротивление всему урону',
        changes: DAMAGE_TYPES.map(type => ({ key: 'system.traits.dr.value', mode: ADD, value: type })) },
    // Дебафы
    trip: { buff: false, name: 'Подножка', img: `${ICON}/statuses/prone.svg`, statuses: ['prone'] },
    sick: { buff: false, name: 'Тошнота', img: `${ICON}/statuses/poisoned.svg`, statuses: ['poisoned'] },
    tangle: { buff: false, name: 'Запутался', img: `${ICON}/statuses/restrained.svg`, statuses: ['restrained'] },
    dark: { buff: false, name: 'Тьма в глазах', img: `${ICON}/statuses/blinded.svg`, statuses: ['blinded'] },
    legs: { buff: false, name: 'Ватные ноги', img: `${ICON}/statuses/grappled.svg`, text: 'скорость 0',
        changes: ['walk', 'fly', 'swim', 'climb', 'burrow'].map(m => ({ key: `system.attributes.movement.${m}`, mode: OVERRIDE, value: '0' })) },
    open: { buff: false, name: 'Раскрылся', img: 'icons/svg/downgrade.svg', text: '−2 к КД', changes: [{ key: 'system.attributes.ac.bonus', mode: ADD, value: '-2' }] }
};
const BUFFS = Object.keys(CARDS).filter(k => CARDS[k].buff);
const ALL = Object.keys(CARDS);

/**
 * Карты участникам: заклинателю — баф, остальным — любая.
 * @returns {{tokenId: string, card: string}[]}
 */
export function dealCards(tokens, casterActorId, random = Math.random) {
    const pick = list => list[Math.floor(random() * list.length)];
    return tokens.map(token => ({ tokenId: token.id, card: token.actor?.id === casterActorId ? pick(BUFFS) : pick(ALL) }));
}

/** Наложить карты (Мастер). Карта держится до конца следующего хода существа */
export async function applyCards(scene, combat, dealt) {
    for (const { tokenId, card } of dealt) {
        const token = scene.tokens.get(tokenId), actor = token?.actor, config = CARDS[card];
        if (!actor || !config) continue;
        const combatant = combat?.combatants?.find(c => c.tokenId === tokenId || c.token?.id === tokenId);
        await actor.createEmbeddedDocuments('ActiveEffect', [{
            name: `Чумовая пятница: ${config.name}`,
            img: config.img,
            statuses: config.statuses ?? [],
            changes: config.changes ?? [],
            // Срок — чтобы эффект считался временным и его иконка была на токене; снимает его модуль
            duration: { rounds: 1, startRound: combat?.round ?? 0, startTurn: combat?.turn ?? 0, combat: combat?.id ?? null },
            flags: { [MODULE_ID]: { freakyCard: { card, combatantId: combatant?.id ?? null, from: `${combat?.round}.${combat?.turn}`, started: false } } }
        }]);
        if (config.temp) {
            const roll = await new Roll(config.temp).evaluate();
            const hp = actor.system.attributes.hp;
            if (roll.total > (hp.temp ?? 0)) await actor.update({ 'system.attributes.hp.temp': roll.total });
        }
    }
}

/** Снять карты, срок которых вышел: в начале своего хода карта «взводится», с его концом — снимается */
Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM()) return;
    const now = `${combat.round}.${combat.turn}`;
    for (const combatant of combat.combatants) {
        const actor = combatant.actor;
        for (const effect of actor?.effects ?? []) {
            const flag = effect.flags?.[MODULE_ID]?.freakyCard;
            if (!flag || (flag.combatantId && flag.combatantId !== combatant.id)) continue;
            const current = combat.combatant?.id === combatant.id;
            if (current && now !== flag.from && !flag.started) await effect.update({ [`flags.${MODULE_ID}.freakyCard.started`]: true });
            else if (!current && flag.started) await effect.delete();
        }
    }
});

/** Конец боя — все карты снимаются */
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    for (const combatant of combat.combatants) {
        const ids = (combatant.actor?.effects ?? []).filter(e => e.flags?.[MODULE_ID]?.freakyCard).map(e => e.id);
        if (ids.length) await combatant.actor.deleteEmbeddedDocuments('ActiveEffect', ids);
    }
});

// ==========================================
// ПЕРЕПУТАННАЯ ОЧЕРЕДЬ
// ==========================================

/**
 * Инициатива тех, кто ещё не ходил в этом раунде (после текущего хода), перемешивается между ними.
 * @returns {{id, initiative}[]} обновления участников боя
 */
export function shuffleInitiative(combat, random = Math.random) {
    const turns = combat?.turns ?? [];
    const waiting = turns.slice((combat.turn ?? 0) + 1)
        .filter(c => c.initiative !== null && c.initiative !== undefined && !c.defeated && c.actor?.system?.attributes?.hp?.value > 0);
    if (waiting.length < 2) return [];
    const values = waiting.map(c => c.initiative);
    for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [values[i], values[j]] = [values[j], values[i]];
    }
    return waiting.map((c, i) => ({ id: c.id, initiative: values[i] })).filter((u, i) => u.initiative !== waiting[i].initiative);
}

// ==========================================
// КАРТЫ НАД ТОКЕНАМИ
// ==========================================

onSocket('freakyCards', data => showCards(data));

/** Над каждым токеном вспыхивает его карта: название, зелёное — баф, красное — дебаф */
export function showCards({ sceneId, dealt }) {
    if (!canvas?.ready || canvas.scene?.id !== sceneId) return;
    for (const { tokenId, card } of dealt) {
        const token = canvas.tokens.get(tokenId), config = CARDS[card];
        if (!token || token.visible === false || !config) continue;
        const text = `${config.buff ? '▲' : '▼'} ${config.name}`;
        const style = { fontSize: 26, fill: config.buff ? '#7dff8a' : '#ff6b6b', stroke: '#000000', strokeThickness: 5, jitter: 0.1, duration: 2600, distance: canvas.grid.size * 0.8 };
        const top = CONST.TEXT_ANCHOR_POINTS?.TOP ?? 2;
        canvas.interface?.createScrollingText?.(token.center, text, { anchor: top, direction: top, ...style });
    }
}

export function broadcastCards(data) {
    emit('freakyCards', data);
    showCards(data);
}
