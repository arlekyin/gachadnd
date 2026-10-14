/**
 * Gacha Roguelike dnd5e — Чумовая пятница: карты и перепутанная очередь
 *
 * Карты: каждому участнику тасовки — одна случайная из 12 (6 бафов, 6 дебафов); заклинателю —
 * только баф. Карта — активный эффект на существе: штатное состояние dnd5e или числовые изменения;
 * держится до конца следующего хода этого существа (turn-effects.js).
 *
 * Очередь: выставленные значения инициативы живых участников боя перемешиваются между ними.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket } from "../../core/socket.js";
import { addTurnEffect } from "./turn-effects.js";

const ICON = 'systems/dnd5e/icons/svg';
const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];
const ADD = 2, MULTIPLY = 1, OVERRIDE = 5;
const attack = value => ['mwak', 'rwak', 'msak', 'rsak'].map(k => ({ key: `system.bonuses.${k}.attack`, mode: ADD, value }));

export const CARDS = {
    // Бафы
    invisible: { buff: true, name: 'Невидимость', rules: 'Атаки по вам — с помехой, ваши атаки — с преимуществом. Вас нельзя увидеть без особых чувств.', img: `${ICON}/statuses/invisible.svg`, statuses: ['invisible'] },
    dash: { buff: true, name: 'Рывок', rules: 'Скорость всех видов удваивается.', img: `${ICON}/statuses/hovering.svg`, text: 'скорость ×2',
        changes: ['walk', 'fly', 'swim', 'climb', 'burrow'].map(m => ({ key: `system.attributes.movement.${m}`, mode: MULTIPLY, value: '2' })) },
    breath: { buff: true, name: 'Второе дыхание', rules: 'Вы получаете 2d8 временных ПЗ (не складываются с другими временными ПЗ).', img: `${ICON}/hit-points.svg`, text: 'временные ПЗ 2d8', temp: '2d8' },
    nerve: { buff: true, name: 'Кураж', rules: '+2 к броскам атаки.', img: 'icons/svg/upgrade.svg', text: '+2 к атакам', changes: attack('+2') },
    armor: { buff: true, name: 'Броня', rules: '+2 к КД.', img: `${ICON}/checked-shield.svg`, text: '+2 к КД', changes: [{ key: 'system.attributes.ac.bonus', mode: ADD, value: '+2' }] },
    tough: { buff: true, name: 'Неуязвимость', rules: 'Сопротивление всем видам урона: урон по вам вдвое меньше.', img: `${ICON}/trait-damage-resistances.svg`, text: 'сопротивление всему урону',
        changes: DAMAGE_TYPES.map(type => ({ key: 'system.traits.dr.value', mode: ADD, value: type })) },
    // Дебафы
    trip: { buff: false, name: 'Подножка', rules: 'Сбит с ног: двигаться можно только ползком (каждый фут стоит 2), встать — половина скорости. Ваши атаки — с помехой. Атаки по вам в пределах 5 футов — с преимуществом, издалека — с помехой.', img: `${ICON}/statuses/prone.svg`, statuses: ['prone'] },
    sick: { buff: false, name: 'Тошнота', rules: 'Отравлен: помеха на броски атаки и проверки характеристик.', img: `${ICON}/statuses/poisoned.svg`, statuses: ['poisoned'] },
    tangle: { buff: false, name: 'Запутался', rules: 'Опутан: скорость 0. Ваши атаки — с помехой, атаки по вам — с преимуществом. Помеха на спасброски Ловкости.', img: `${ICON}/statuses/restrained.svg`, statuses: ['restrained'] },
    dark: { buff: false, name: 'Тьма в глазах', rules: 'Ослеплён: вы ничего не видите, проверки, требующие зрения, проваливаются. Ваши атаки — с помехой, атаки по вам — с преимуществом.', img: `${ICON}/statuses/blinded.svg`, statuses: ['blinded'] },
    legs: { buff: false, name: 'Ватные ноги', rules: 'Скорость всех видов — 0.', img: `${ICON}/statuses/grappled.svg`, text: 'скорость 0',
        changes: ['walk', 'fly', 'swim', 'climb', 'burrow'].map(m => ({ key: `system.attributes.movement.${m}`, mode: OVERRIDE, value: '0' })) },
    open: { buff: false, name: 'Раскрылся', rules: '−2 к КД.', img: 'icons/svg/downgrade.svg', text: '−2 к КД', changes: [{ key: 'system.attributes.ac.bonus', mode: ADD, value: '-2' }] }
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
        // До конца следующего хода существа — снимает модуль (turn-effects.js)
        await addTurnEffect(actor, combat, {
            name: `Чумовая пятница: ${config.name}`,
            img: config.img,
            description: `<p>${config.rules}</p><p><em>Чумовая пятница: до конца следующего хода этого существа.</em></p>`,
            statuses: config.statuses ?? [],
            changes: config.changes ?? [],
            flags: { [MODULE_ID]: { freakyCard: { card } } }
        }, { tokenId });
        if (config.temp) {
            const roll = await new Roll(config.temp).evaluate();
            const hp = actor.system.attributes.hp;
            if (roll.total > (hp.temp ?? 0)) await actor.update({ 'system.attributes.hp.temp': roll.total });
        }
    }
}

// ==========================================
// ПЕРЕПУТАННАЯ ОЧЕРЕДЬ
// ==========================================

/**
 * Выставленная инициатива живых участников перемешивается между ними.
 * @returns {{id, initiative}[]} обновления участников боя
 */
export function shuffleInitiative(combat, random = Math.random) {
    const waiting = [...(combat?.combatants ?? [])]
        .filter(c => c.initiative !== null && c.initiative !== undefined && !c.defeated && c.actor?.system?.attributes?.hp?.value > 0);
    if (waiting.length < 2) return [];
    const values = waiting.map(c => c.initiative);
    // Не оставлять очередь как была, если в ней есть разные значения
    for (let attempt = 0; attempt < 20; attempt++) {
        for (let i = values.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [values[i], values[j]] = [values[j], values[i]];
        }
        if (values.some((v, i) => v !== waiting[i].initiative) || new Set(values).size < 2) break;
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
