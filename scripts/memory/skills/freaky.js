/**
 * Gacha Roguelike dnd5e — Чумовая пятница (красный навык)
 *
 * Все живые существа в бою случайно меняются местами — союзники, враги и сам персонаж. Меняются
 * между собой существа одного размера (места остаются по сетке, никто не встаёт в другого);
 * у единственного существа своего размера место не меняется. Существа на 0 ПЗ и мёртвые не
 * участвуют.
 *
 * У всех токены взлетают, как напёрстки, разлетаются дугами по новым местам и садятся; Мастер
 * переставляет их в момент посадки (v13 — перемещением «displace»).
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { clamp01, easeInOut } from "../../cutscene/math.js";
import { placeToken } from "./pick.js";

const FLY_MS = 1300;
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

/** Новые места: { id, x, y, from: {x, y} } — перестановка внутри каждого размера */
export function plan(tokens, random = Math.random) {
    const groups = new Map();
    for (const token of tokens) {
        const size = `${token.width || 1}×${token.height || 1}`;
        if (!groups.has(size)) groups.set(size, []);
        groups.get(size).push(token);
    }
    const moves = [];
    for (const group of groups.values()) {
        const order = shuffle(group.length, random);
        group.forEach((token, i) => {
            const spot = group[order[i]];
            if (spot !== token) moves.push({ id: token.id, x: spot.x, y: spot.y, from: { x: token.x, y: token.y } });
        });
    }
    return moves;
}

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isFreaky(item) || !actor) return;
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id)) {
        ui.notifications.warn('Чумовая пятница работает только в бою, в котором участвует персонаж.');
        return false;
    }
    if (!plan(participants(combat)).length) {
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
    const moves = plan(participants(combat));
    if (!scene || !moves.length) return;
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
    const names = moves.map(m => scene.tokens.get(m.id)?.name).filter(Boolean);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: game.actors.get(actorId) }),
        content: `<div class="gd-freaky-card"><strong>Чумовая пятница</strong> — все перепутались местами: ${foundry.utils.escapeHTML?.(names.join(', ')) ?? names.join(', ')}.</div>`
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
