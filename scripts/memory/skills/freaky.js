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
import { clamp01, easeInOut, smooth } from "../../cutscene/math.js";
import { stageCamera } from "../../cutscene/camera.js";
import { stowWindows } from "../../cutscene/windows.js";
import { registerCues, playCue, noise, tone } from "../../cutscene/audio.js";
import { flutter } from "../../cutscene/instruments.js";
import { placeToken } from "./pick.js";
import { key, cellOf, footprint, nearestFree } from "./grid.js";
import { CARDS, dealCards, applyCards, shuffleInitiative, broadcastCards } from "./freaky-cards.js";

// Катсцена, мс: окна прячутся, фон темнеет и камера наезжает; полёт; пауза; всё возвращается
const T = { focus: 550, fly: 1300, hold: 450, back: 550 };
const FLY_MS = T.fly;
const LAND_MS = T.focus + T.fly;
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
    const shuffleData = { sceneId: scene.id, moves, crushed };
    emit('freakyShuffle', shuffleData);
    const landed = playShuffle(shuffleData);
    // Перестановка — в момент посадки: всё сразу, без анимации движения
    await new Promise(resolve => setTimeout(resolve, LAND_MS));
    await Promise.all(moves.map(m => {
        const token = scene.tokens.get(m.id);
        return token ? placeToken(token, m.x, m.y) : null;
    }));
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
    await landed;
    // Очередь: выставленная инициатива живых участников перемешивается; текущий ход остаётся за тем, чей он
    const order = shuffleInitiative(combat);
    if (order.length) {
        const current = combat.combatant?.id;
        await combat.updateEmbeddedDocuments('Combatant', order.map(u => ({ _id: u.id, initiative: u.initiative })));
        const turn = combat.turns.findIndex(c => c.id === current);
        if (turn >= 0 && turn !== combat.turn) await combat.update({ turn });
    }
    const esc = text => foundry.utils.escapeHTML?.(text) ?? text;
    const names = moves.map(m => scene.tokens.get(m.id)?.name).filter(Boolean).join(', ');
    const cards = dealt.map(d => `${esc(scene.tokens.get(d.tokenId)?.name ?? '?')} — <span class="${CARDS[d.card].buff ? 'buff' : 'debuff'}">${CARDS[d.card].name}</span>${CARDS[d.card].text ? ` (${CARDS[d.card].text})` : ''}`).join('<br>');
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: game.actors.get(actorId) }),
        content: `<div class="gd-freaky-card"><strong>Чумовая пятница</strong> — все перепутались местами: ${esc(names)}.${crush}`
            + `<br><strong>Карты</strong> (до конца следующего хода):<br>${cards}`
            + (order.length ? '<br><strong>Очередь перепуталась:</strong> инициатива перемешана.' : '')
            + '</div>'
    });
}

// ==========================================
// ПОЛЁТ ТОКЕНОВ
// ==========================================

onSocket('freakyShuffle', data => playShuffle(data));

registerCues({
    // Взлёт: мягкий вдох-свист
    freakyLift(ctx, bus, t0) {
        noise(ctx, bus, t0, { type: 'bandpass', freq: [500, 2400], q: 1.2, gain: [[0, 0.0001], [0.25, 0.35], [0.45, 0.0001]], duration: 0.5, send: 0.5 });
    },
    // Полёт: свист пролетающего токена
    freakyWhoosh(ctx, bus, t0, { pan = 0 } = {}) {
        flutter(ctx, bus, t0, { freq: [1800, 500], rate: [22, 10], level: 0.22, duration: 0.5, pan, send: 0.35 });
    },
    // Посадка: мягкий шлепок; придавил — глухой удар
    freakyLand(ctx, bus, t0, { heavy = false } = {}) {
        tone(ctx, bus, t0, { type: 'sine', freq: heavy ? [140, 45] : [260, 120], gain: [[0, heavy ? 0.7 : 0.35], [heavy ? 0.35 : 0.15, 0.0001]], duration: heavy ? 0.4 : 0.18, send: 0.2 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [1800, 300], q: 0.7, gain: [[0, heavy ? 0.4 : 0.15], [0.12, 0.0001]], duration: 0.15, send: 0.2 });
    }
});

const sound = (name, options = {}) => {
    try {
        if (!game.settings.get(MODULE_ID, 'soundsEnabled')) return;
        playCue(name, { volume: game.settings.get(MODULE_ID, 'soundsVolume'), ...options });
    } catch (error) { /* без настроек звука — тихо */ }
};
const setting = (key, fallback) => { try { return game.settings.get(MODULE_ID, key); } catch (error) { return fallback; } };

/**
 * Катсцена тасовки у всех: окна прячутся, фон темнеет, камера наезжает на середину группы;
 * токены взлетают, летят дугами к новым местам и садятся; затем всё возвращается. На время
 * полёта сами токены скрыты — летят их картинки; Мастер переставляет токены в момент посадки.
 */
export function playShuffle({ sceneId, moves, crushed = [] }) {
    if (!canvas?.ready || canvas.scene?.id !== sceneId) return new Promise(resolve => setTimeout(resolve, LAND_MS + T.hold + T.back));
    const size = canvas.grid.size;
    // Без кадров катсцен — только полёт; спокойный режим — без наезда камеры
    const cinematic = setting('impactFrames', true) !== false;
    const calm = !!setting('impactCalm', false);
    const restoreWindows = cinematic ? stowWindows() : () => {};
    const dim = new PIXI.Graphics();
    dim.eventMode = 'none';
    const rect = canvas.dimensions?.rect ?? canvas.dimensions?.sceneRect ?? { x: 0, y: 0, width: 1e4, height: 1e4 };
    dim.beginFill(0x000000, 1).drawRect(rect.x - 1e4, rect.y - 1e4, rect.width + 2e4, rect.height + 2e4).endFill();
    dim.alpha = 0;
    const layer = new PIXI.Container();
    layer.eventMode = 'none';
    canvas.controls.addChild(dim, layer);
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
        sprite.position.set(m.from.x + w / 2, m.from.y + h / 2);
        layer.addChild(sprite);
        token.renderable = false;
        flights.push({ token, sprite, scale, n, from: { x: m.from.x + w / 2, y: m.from.y + h / 2 }, to: { x: m.x + w / 2, y: m.y + h / 2 } });
    }
    // Камера: середина группы и масштаб, при котором видны все старые и новые места
    const camera = cinematic && !calm ? stageCamera() : null;
    let focus = null;
    if (camera && flights.length) {
        const points = flights.flatMap(f => [f.from, f.to]);
        const xs = points.map(p => p.x), ys = points.map(p => p.y);
        const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
        const half = { x: (Math.max(...xs) - Math.min(...xs)) / 2 + size * 1.5, y: (Math.max(...ys) - Math.min(...ys)) / 2 + size * 2.5 };
        const fit = Math.min(camera.rect.width * 0.8 / (2 * half.x), camera.rect.height * 0.8 / (2 * half.y));
        const max = Math.min(camera.saved.sx * 1.8, globalThis.CONFIG?.Canvas?.maxZoom ?? 3);
        focus = { center, scale: Math.max(0.2, Math.min(max, fit)) };
    }
    const span = canvas.app?.view?.getBoundingClientRect?.() ?? { left: 0, width: innerWidth };
    const panOf = p => {
        const screen = camera?.screenOf?.(p);
        return screen ? Math.max(-1, Math.min(1, ((screen.x / devicePixelRatio - span.left) / span.width) * 2 - 1)) : 0;
    };
    const start = performance.now(), end = LAND_MS + T.hold + T.back;
    const cues = { lift: false, whoosh: new Set(), land: false };
    return new Promise(resolve => {
        const frame = now => {
            const time = now - start;
            // Фон и камера: наезд, держим, отъезд
            const inK = smooth(clamp01(time / T.focus)), outK = smooth(clamp01((time - LAND_MS - T.hold) / T.back));
            const k = inK * (1 - outK);
            dim.alpha = 0.6 * k;
            if (camera && focus) camera.place({ k, scale: focus.scale, center: focus.center });
            // Полёт: взлёт (0–0.15), дуга (0.15–0.85), посадка (0.85–1); дуги у всех разные
            const t = clamp01((time - T.focus) / T.fly);
            if (time >= T.focus && !cues.lift) { cues.lift = true; sound('freakyLift'); }
            for (const f of layer.parent ? flights : []) {
                const fk = easeInOut(clamp01((t - 0.15) / 0.7));
                if (fk > 0 && !cues.whoosh.has(f.n) && f.n < 6) { cues.whoosh.add(f.n); setTimeout(() => sound('freakyWhoosh', { pan: panOf(f.from) }), f.n * 60); }
                const up = Math.sin(clamp01(t / 0.15) * Math.PI / 2) * (1 - clamp01((t - 0.85) / 0.15));
                const arc = Math.sin(fk * Math.PI) * size * (1 + (f.n % 3) * 0.5) * (f.n % 2 ? 1 : -1);
                const dx = f.to.x - f.from.x, dy = f.to.y - f.from.y, len = Math.hypot(dx, dy) || 1;
                f.sprite.position.set(f.from.x + dx * fk - dy / len * arc, f.from.y + dy * fk + dx / len * arc - up * size * 0.3);
                const grow = 1 + up * 0.25;
                f.sprite.scale.set(f.scale.x * grow, f.scale.y * grow);
                f.sprite.rotation = Math.sin(fk * Math.PI) * 0.35 * (f.n % 2 ? 1 : -1);
            }
            if (t >= 1 && !cues.land) { cues.land = true; sound('freakyLand', { heavy: crushed.length > 0 }); }
            // Мастер переставляет токены в момент посадки — картинки держатся, пока они не встали
            if (time >= LAND_MS + 400 && layer.parent) {
                for (const f of flights) f.token.renderable = true;
                layer.destroy({ children: true });
            }
            if (time < end) return requestAnimationFrame(frame);
            if (layer.parent) { for (const f of flights) f.token.renderable = true; layer.destroy({ children: true }); }
            dim.destroy();
            camera?.restore();
            restoreWindows();
            resolve();
        };
        requestAnimationFrame(frame);
    });
}
