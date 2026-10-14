/**
 * Gacha Roguelike dnd5e — Чумовая пятница (красный навык)
 *
 * Все живые существа в бою случайно меняются местами — союзники, враги и сам персонаж, любого
 * размера: огр встаёт на место гоблина (верхним левым углом в его клетку). Кого огр
 * накрыл, того придавило: оно выталкивается в ближайшую свободную клетку и получает дробящий
 * урон. Крупные встают первыми — давит больший. Существа на 0 ПЗ и мёртвые не участвуют
 * (но и их сдвигает, если на них встали).
 *
 * У всех токены взлетают, как напёрстки, разлетаются дугами по новым местам и садятся; Мастер
 * переставляет их в момент посадки (v13 — перемещением «displace»).
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { clamp01, easeInOut } from "../../cutscene/math.js";
import { placeToken } from "./pick.js";
import { key, cellOf, footprint, nearestFree } from "./grid.js";
import { CARDS, dealCards, applyCards, shuffleInitiative, broadcastCards } from "./freaky-cards.js";

const FLY_MS = 1300;
// Урон придавленному
const CRUSH = '2d6';
const isFreaky = item => !!item?.flags?.[MODULE_ID]?.freaky;

const alive = actor => {
    const hp = actor?.system?.attributes?.hp;
    return !!hp && hp.value > 0 && !actor.statuses?.has?.('dead');
};

/** Участники: токены живых существ боя */
function participants(combat) {
    return (combat?.combatants ?? []).filter(c => c.token && !c.defeated && alive(c.actor)).map(c => c.token);
}

/**
 * Случайная перестановка, не тождественная, если элементов больше одного.
 * @returns {number[]} order[i] — чьё место получает элемент i
 */
export function shuffle(n, random = Math.random) {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let attempt = 0; attempt < 20; attempt++) {
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        if (n < 2 || order.some((v, i) => v !== i)) break;
    }
    return order;
}

/**
 * Новые места. Каждый встаёт верхним левым углом туда, где стоял тот, чьё место ему выпало.
 * Крупные встают первыми; кого накрыли — тот придавлен и выталкивается в ближайшую свободную клетку.
 * @param {object} scene
 * @param {object[]} tokens  Участники (документы токенов).
 * @returns {{moves: {id, x, y, from: {x, y}}[], crushed: string[]}}
 */
export function plan(scene, tokens, random = Math.random) {
    const size = scene.grid.size;
    const order = shuffle(tokens.length, random);
    // Верхний левый угол — на угол чужого места: без округлений, места не «уползают» от тасовки к тасовке
    const target = tokens.map((t, i) => cellOf(tokens[order[i]], size));
    const ids = new Set(tokens.map(t => t.id));
    const area = t => (t.width || 1) * (t.height || 1);
    // Сначала крупные: давит больший
    const queue = tokens.map((t, i) => i).sort((a, b) => area(tokens[b]) - area(tokens[a]));
    const taken = new Set();
    // Блоки Тетриса — тоже препятствие
    for (const tile of scene.tiles ?? []) if (tile.flags?.[MODULE_ID]?.tetris) taken.add(key(...cellOf(tile, size)));
    const placed = new Map(), crushed = [];
    for (const i of queue) {
        const t = tokens[i];
        let [gx, gy] = target[i];
        // У края сцены — внутрь
        const w = Math.floor((scene.dimensions?.width ?? Infinity) / size), h = Math.floor((scene.dimensions?.height ?? Infinity) / size);
        gx = Math.max(0, Math.min(gx, w - (t.width || 1))); gy = Math.max(0, Math.min(gy, h - (t.height || 1)));
        if (!footprint(t, gx, gy).every(k => !taken.has(k))) {
            crushed.push(t.id);
            [gx, gy] = nearestFree(scene, size, t, gx, gy, taken, 12) ?? [gx, gy];
        }
        footprint(t, gx, gy).forEach(k => taken.add(k));
        placed.set(t.id, [gx, gy]);
    }
    // Не участники (мёртвые, вне боя), на которых встали, — сдвигаются
    for (const t of scene.tokens) {
        if (ids.has(t.id)) continue;
        const [gx, gy] = cellOf(t, size);
        if (footprint(t, gx, gy).every(k => !taken.has(k))) { footprint(t, gx, gy).forEach(k => taken.add(k)); continue; }
        const spot = nearestFree(scene, size, t, gx, gy, taken, 12);
        if (!spot) continue;
        footprint(t, ...spot).forEach(k => taken.add(k));
        placed.set(t.id, spot);
    }
    const all = [...tokens, ...scene.tokens.filter(t => !ids.has(t.id))];
    const moves = [];
    for (const [id, [gx, gy]] of placed) {
        const t = all.find(x => x.id === id);
        if (t.x !== gx * size || t.y !== gy * size) moves.push({ id, x: gx * size, y: gy * size, from: { x: t.x, y: t.y } });
    }
    return { moves, crushed };
}

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isFreaky(item) || !actor) return;
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id)) {
        ui.notifications.warn('Чумовая пятница работает только в бою, в котором участвует персонаж.');
        return false;
    }
    if (participants(combat).length < 2) {
        ui.notifications.warn('В бою некому меняться местами.');
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isFreaky(item) || !actor || !game.combat) return;
    requestGM('freakyFriday', { combatId: game.combat.id, actorId: actor.id });
});

onSocket('freakyFriday', ({ payload }) => {
    if (!isActiveGM()) return;
    freakyFriday(payload).catch(error => console.error(`${MODULE_ID} | Чумовая пятница`, error));
});

async function freakyFriday({ combatId, actorId }) {
    const combat = game.combats.get(combatId);
    const scene = combat?.scene ?? canvas.scene;
    if (!scene) return;
    const { moves, crushed } = plan(scene, participants(combat));
    if (!moves.length) return;
    const shuffleData = { sceneId: scene.id, moves };
    emit('freakyShuffle', shuffleData);
    const landed = playShuffle(shuffleData);
    // Перестановка — в момент посадки: всё сразу, без анимации движения
    await new Promise(resolve => setTimeout(resolve, FLY_MS));
    await Promise.all(moves.map(m => {
        const token = scene.tokens.get(m.id);
        return token ? placeToken(token, m.x, m.y) : null;
    }));
    await landed;
    // Придавленные — дробящий урон (живым)
    let crush = '';
    if (crushed.length) {
        const roll = await new Roll(CRUSH).evaluate();
        const hurt = crushed.map(id => scene.tokens.get(id)).filter(t => t?.actor && alive(t.actor));
        for (const token of hurt) await token.actor.applyDamage([{ value: roll.total, type: 'bludgeoning' }]);
        const who = hurt.map(t => t.name).join(', ');
        crush = who ? `<br>Придавило: ${foundry.utils.escapeHTML?.(who) ?? who} — ${roll.total} дробящего урона (${CRUSH}).` : '';
    }
    // Карты: каждому участнику, заклинателю — баф
    const dealt = dealCards(participants(combat), actorId);
    broadcastCards({ sceneId: scene.id, dealt });
    await applyCards(scene, combat, dealt);
    // Очередь: инициатива ещё не ходивших перемешивается
    const order = shuffleInitiative(combat);
    if (order.length) await combat.updateEmbeddedDocuments('Combatant', order.map(u => ({ _id: u.id, initiative: u.initiative })));
    const esc = text => foundry.utils.escapeHTML?.(text) ?? text;
    const names = moves.map(m => scene.tokens.get(m.id)?.name).filter(Boolean).join(', ');
    const cards = dealt.map(d => `${esc(scene.tokens.get(d.tokenId)?.name ?? '?')} — <span class="${CARDS[d.card].buff ? 'buff' : 'debuff'}">${CARDS[d.card].name}</span>${CARDS[d.card].text ? ` (${CARDS[d.card].text})` : ''}`).join('<br>');
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: game.actors.get(actorId) }),
        content: `<div class="gd-freaky-card"><strong>Чумовая пятница</strong> — все перепутались местами: ${esc(names)}.${crush}`
            + `<br><strong>Карты</strong> (до конца следующего хода):<br>${cards}`
            + (order.length ? '<br><strong>Очередь перепуталась</strong> у тех, кто ещё не ходил.' : '')
            + '</div>'
    });
}

// ==========================================
// ПОЛЁТ ТОКЕНОВ
// ==========================================

onSocket('freakyShuffle', data => playShuffle(data));

/**
 * Токены взлетают, летят дугами к новым местам и садятся. На время полёта сам токен скрыт,
 * вместо него летит его картинка; после посадки (когда Мастер переставил) токен снова виден.
 */
export function playShuffle({ sceneId, moves }) {
    if (!canvas?.ready || canvas.scene?.id !== sceneId) return Promise.resolve();
    const size = canvas.grid.size;
    const layer = new PIXI.Container();
    layer.eventMode = 'none';
    canvas.controls.addChild(layer);
    const flights = [];
    for (const [n, m] of moves.entries()) {
        const token = canvas.tokens.get(m.id);
        // Скрытые от этого клиента токены не летят: их не видно
        if (!token || token.visible === false || !token.mesh?.texture) continue;
        const doc = token.document;
        const w = (doc.width || 1) * size, h = (doc.height || 1) * size;
        const sprite = new PIXI.Sprite(token.mesh.texture);
        sprite.anchor.set(0.5);
        sprite.width = Math.abs(token.mesh.width) || w;
        sprite.height = Math.abs(token.mesh.height) || h;
        const scale = { x: sprite.scale.x, y: sprite.scale.y };
        layer.addChild(sprite);
        token.renderable = false;
        flights.push({ token, sprite, scale, n, from: { x: m.from.x + w / 2, y: m.from.y + h / 2 }, to: { x: m.x + w / 2, y: m.y + h / 2 } });
    }
    const start = performance.now();
    return new Promise(resolve => {
        const frame = now => {
            const t = clamp01((now - start) / FLY_MS);
            for (const f of flights) {
                // Взлёт (0–0.15), полёт дугой (0.15–0.85), посадка (0.85–1); дуги у всех разные
                const k = easeInOut(clamp01((t - 0.15) / 0.7));
                const up = Math.sin(clamp01(t / 0.15) * Math.PI / 2) * (1 - clamp01((t - 0.85) / 0.15));
                const arc = Math.sin(k * Math.PI) * size * (1 + (f.n % 3) * 0.5) * (f.n % 2 ? 1 : -1);
                const dx = f.to.x - f.from.x, dy = f.to.y - f.from.y, len = Math.hypot(dx, dy) || 1;
                f.sprite.position.set(f.from.x + dx * k - dy / len * arc, f.from.y + dy * k + dx / len * arc - up * size * 0.3);
                const grow = 1 + up * 0.25;
                f.sprite.scale.set(f.scale.x * grow, f.scale.y * grow);
                f.sprite.rotation = Math.sin(k * Math.PI) * 0.35 * (f.n % 2 ? 1 : -1);
            }
            if (t < 1) return requestAnimationFrame(frame);
            // Мастер переставляет токены в момент посадки — картинка держится, пока они не встали
            setTimeout(() => {
                for (const f of flights) f.token.renderable = true;
                layer.destroy({ children: true });
                resolve();
            }, 400);
        };
        requestAnimationFrame(frame);
    });
}
