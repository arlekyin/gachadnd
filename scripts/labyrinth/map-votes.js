/**
 * Gacha Roguelike dnd5e — Голоса игроков на карте этажа
 *
 * Игрок щелчком отмечает любой узел карты, куда хочет вести отряд, — даже если за один шаг туда не дойти; повторный
 * щелчок снимает отметку, щелчок по другому узлу — переносит.
 * Это только выбор: отряд по-прежнему ведёт Мастер.
 *
 * Голос лежит во флаге самого игрока — свой документ User игрок правит без Мастера, флаг сразу расходится всем.
 * К голосу приписан ход, на котором он поставлен: отряд шагнул или этаж начерчен заново — голос перестаёт действовать,
 * чистить ничего не нужно.
 *
 * Рисуют голоса сами карты: паутина — web-stage.js, ряды — paintVotes ниже.
 */

import { MODULE_ID } from "../core/constants.js";
import { getFloor } from "./economy.js";
import { mapScene } from "./scene-travel.js";

const FLAG = 'mapVote';
/** Оборот орбиты, мс — столько же, сколько у портретов на паутине (web-stage.js) */
const ORBIT_MS = 70000;

/** Какой сейчас ход: этаж, сама карта, положение отряда, число шагов */
function turnOf(map) {
    let shape = 0;
    for (const n of map.nodes) for (const ch of n.id + n.type) shape = (Math.imul(shape, 31) + ch.charCodeAt(0)) | 0;
    return `${getFloor()}|${shape}|${map.currentNodeId ?? ''}|${map.visitedNodes?.length ?? 0}|${map.web?.ticks ?? 0}`;
}

/** Можно ли голосовать за узел: за любой на карте, кроме того, где отряд уже стоит */
const canVote = (map, nodeId) => nodeId !== map?.currentNodeId && !!map?.nodes?.some(n => n.id === nodeId);

/** Узел, за который голосует пользователь на этом ходу, или null */
function voteOf(user, map, turn = turnOf(map)) {
    const vote = user.getFlag(MODULE_ID, FLAG);
    return vote?.turn === turn ? vote.node : null;
}

/**
 * Щелчок игрока по узлу: поставить, перенести или снять голос.
 * @returns {boolean} принят ли щелчок: Мастер не голосует, а за узел под отрядом голосовать незачем
 */
export function toggleVote(nodeId, map = mapScene()?.getFlag(MODULE_ID, 'floorMap')) {
    if (game.user.isGM || !canVote(map, nodeId)) return false;
    const turn = turnOf(map);
    game.user.setFlag(MODULE_ID, FLAG, voteOf(game.user, map, turn) === nodeId ? null : { node: nodeId, turn });
    return true;
}

/**
 * Голоса этого хода: кто из игроков в сети за какой узел. Портрет — назначенный игроку персонаж, без него — аватар.
 * @returns {Map<string, {id: string, name: string, img: string, color: string}[]>} узел → проголосовавшие
 */
export function mapVotes(map) {
    const votes = new Map();
    if (!map?.nodes?.length) return votes;
    const turn = turnOf(map);
    for (const user of game.users) {
        if (user.isGM || !user.active) continue;
        const node = voteOf(user, map, turn);
        if (!canVote(map, node)) continue;
        if (!votes.has(node)) votes.set(node, []);
        votes.get(node).push({
            id: user.id, name: user.character?.name ?? user.name,
            img: user.character?.img ?? user.avatar ?? 'icons/svg/mystery-man.svg',
            color: foundry.utils.Color.from(user.color).css
        });
    }
    return votes;
}

/** Голоса на бумажных рядах: на отмеченном узле — кольцо в цветах голосов и портреты на орбите */
export function paintVotes(root, map) {
    const seen = new Set();
    root.querySelectorAll('.gd-vote-orbit').forEach(el => {
        for (const face of el.querySelectorAll('[data-voter]')) seen.add(`${el.parentElement.dataset.nodeId}|${face.dataset.voter}`);
        el.remove();
    });
    // Перерисовка не должна возвращать портреты в начало оборота: фаза берётся от времени страницы
    const delay = `-${Math.round(performance.now() % ORBIT_MS)}ms`;
    for (const [nodeId, voters] of mapVotes(map)) {
        const node = root.querySelector(`.gd-map-node[data-node-id="${CSS.escape(nodeId)}"]`);
        if (!node) continue;
        const share = 100 / voters.length;
        const orbit = document.createElement('span');
        orbit.className = 'gd-vote-orbit';
        orbit.style.setProperty('--delay', delay);
        orbit.style.setProperty('--wash', voters[0].color);
        const arcs = voters.map((v, i) => `<circle r="40" pathLength="100" stroke="${v.color}" stroke-dasharray="${share} ${100 - share}" stroke-dashoffset="${-i * share}"/>`).join('');
        orbit.innerHTML = `<svg class="gd-vote-rim gd-ink" viewBox="-48 -48 96 96" aria-hidden="true">${arcs}</svg><span class="gd-vote-spin"></span>`;
        const spin = orbit.querySelector('.gd-vote-spin');
        voters.forEach((voter, i) => {
            const seat = document.createElement('span');
            seat.className = 'gd-vote-seat';
            seat.style.setProperty('--turn', `${i * 360 / voters.length}deg`);
            const face = document.createElement('span');
            face.className = `gd-vote-face${seen.has(`${nodeId}|${voter.id}`) ? '' : ' pop'}`;
            face.dataset.voter = voter.id;
            face.title = voter.name;
            face.style.setProperty('--voter', voter.color);
            const img = document.createElement('img');
            img.src = voter.img;
            img.alt = '';
            face.append(img);
            seat.append(face);
            spin.append(seat);
        });
        node.append(orbit);
    }
}

// Кто-то проголосовал, вошёл, вышел или сменил персонажа — карты обновляют только голоса, не всё поле
const changed = () => Hooks.callAll('gachadnd.mapVotes');
Hooks.on('updateUser', (user, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG}`) || ['character', 'color', 'avatar'].some(key => key in changes)) changed();
});
Hooks.on('userConnected', changed);
