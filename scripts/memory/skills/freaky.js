/**
 * Gacha Roguelike dnd5e — Чумовая пятница (красный навык)
 *
 * Все существа в бою случайно перемешивают между собой долю оставшихся ПЗ: у каждого — доля
 * кого-то другого от его собственного максимума. Существа на 0 ПЗ и мёртвые не участвуют,
 * временные ПЗ не тасуются. Персонаж участвует всегда.
 *
 * У всех над токенами всплывают полоски здоровья и, как напёрстки, разлетаются к новым
 * владельцам; Мастер меняет ПЗ, когда полоски долетели.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { clamp01, easeInOut } from "../../cutscene/math.js";

const FLY_MS = 1400;
const isFreaky = item => !!item?.flags?.[MODULE_ID]?.freaky;

const hpOf = actor => actor?.system?.attributes?.hp;
const maxOf = hp => Math.max(1, hp?.effectiveMax ?? hp?.max ?? 1);
const alive = actor => {
    const hp = hpOf(actor);
    return !!hp && hp.value > 0 && !actor.statuses?.has?.('dead');
};

/** Участники: { tokenId, actor, ratio } — живые существа боя с токеном на сцене */
function participants(combat) {
    const out = [];
    for (const combatant of combat?.combatants ?? []) {
        const actor = combatant.actor, token = combatant.token;
        if (!token || !alive(actor) || combatant.defeated) continue;
        const hp = hpOf(actor);
        out.push({ tokenId: token.id, actor, ratio: hp.value / maxOf(hp) });
    }
    return out;
}

/**
 * Перестановка долей: случайная и не тождественная (если участников больше одного).
 * @returns {number[]} order[i] — чью долю получает участник i
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

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isFreaky(item) || !actor) return;
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id)) {
        ui.notifications.warn('Чумовая пятница работает только в бою, в котором участвует персонаж.');
        return false;
    }
    if (participants(combat).length < 2) {
        ui.notifications.warn('В бою некому меняться здоровьем.');
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
    const list = participants(combat);
    if (list.length < 2) return;
    const order = shuffle(list.length);
    const flights = list.map((p, i) => ({ from: list[order[i]].tokenId, to: p.tokenId, ratio: list[order[i]].ratio }));
    const flight = { sceneId: combat.scene?.id ?? canvas.scene?.id, flights };
    emit('freakyFly', flight);
    await playFly(flight);
    const rows = [];
    for (const [i, p] of list.entries()) {
        const hp = hpOf(p.actor);
        const ratio = list[order[i]].ratio;
        const value = Math.max(1, Math.min(maxOf(hp), Math.round(ratio * maxOf(hp))));
        rows.push(`${foundry.utils.escapeHTML?.(p.actor.name) ?? p.actor.name}: ${Math.round(p.ratio * 100)}% → ${Math.round(ratio * 100)}%`);
        if (value !== hp.value) await p.actor.update({ 'system.attributes.hp.value': value });
    }
    const caster = game.actors.get(actorId);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: `<div class="gd-freaky-card"><strong>Чумовая пятница</strong> — здоровье перемешалось:<br>${rows.join('<br>')}</div>`
    });
}

// ==========================================
// ПОЛЁТ ПОЛОСОК
// ==========================================

onSocket('freakyFly', data => playFly(data));

const barColor = ratio => {
    const r = ratio < 0.5 ? 255 : Math.round(255 * (1 - ratio) * 2);
    const g = ratio > 0.5 ? 220 : Math.round(220 * ratio * 2);
    return (r << 16) | (g << 8) | 60;
};

/** Полоски здоровья взлетают над токенами, тасуются и садятся на новых владельцев */
export function playFly({ sceneId, flights }) {
    if (!canvas?.ready || canvas.scene?.id !== sceneId) return new Promise(resolve => setTimeout(resolve, FLY_MS));
    const size = canvas.grid.size;
    const g = new PIXI.Graphics();
    g.eventMode = 'none';
    canvas.controls.addChild(g);
    // Скрытые от этого клиента токены не показываются: их полоски не видны
    const visible = id => {
        const token = canvas.tokens.get(id);
        return token && token.visible !== false ? token : null;
    };
    const top = token => ({ x: token.center.x, y: token.document.y - size * 0.35 });
    const bars = flights.map((f, n) => ({ ...f, a: visible(f.from), b: visible(f.to), n })).filter(f => f.a && f.b);
    const start = performance.now();
    return new Promise(resolve => {
        const frame = now => {
            const t = clamp01((now - start) / FLY_MS);
            g.clear();
            for (const bar of bars) {
                const from = top(bar.a), to = top(bar.b);
                // Взлёт (0–0.2), полёт дугой (0.2–0.85), посадка (0.85–1)
                const k = easeInOut(clamp01((t - 0.2) / 0.65));
                const lift = Math.sin(clamp01(t / 0.2) * Math.PI / 2) * size * 0.6 * (1 - clamp01((t - 0.85) / 0.15));
                const arc = Math.sin(k * Math.PI) * size * (1.2 + (bar.n % 3) * 0.4);
                const x = from.x + (to.x - from.x) * k, y = from.y + (to.y - from.y) * k - lift - arc;
                const w = size * 1.1, h = Math.max(8, size * 0.2);
                g.lineStyle(2, 0x000000, 0.8).beginFill(0x1a1a1a, 0.9).drawRoundedRect(x - w / 2, y - h / 2, w, h, h / 2).endFill();
                g.lineStyle(0).beginFill(barColor(bar.ratio), 1).drawRoundedRect(x - w / 2 + 1, y - h / 2 + 1, Math.max(0, (w - 2) * bar.ratio), h - 2, (h - 2) / 2).endFill();
            }
            if (t < 1) return requestAnimationFrame(frame);
            g.destroy();
            resolve();
        };
        requestAnimationFrame(frame);
    });
}
