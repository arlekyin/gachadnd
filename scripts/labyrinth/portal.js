/**
 * Gacha Roguelike dnd5e — Портал в Предел
 *
 * На узле Привал ткань узла тонкая: отряд может сжечь кристаллы и открыть портал в Якорь и обратно.
 * Плата — вероятность: суммарный вес сожжённых кристаллов не меньше 2 + номер этажа (вес тот же, что у
 * Запаха). Каждый игрок кладёт в разрыв кристаллы своего персонажа; Мастер открывает портал, когда плата
 * набрана. Портал открывает Якорь, а первый шаг по карте возвращает отряд на этот же Привал.
 *
 * Состояние — на узле карты (node.portal.pledges: { actorId: { itemId: количество } }); пишет его Мастер.
 */

import { MODULE_ID } from "../core/constants.js";
import { mapScene, anchorScene, preloadScene, arrival } from "./scene-travel.js";
import { isActiveGM, onSocket, emit, notifyUser, requestGM } from "../core/socket.js";
import { partyActors } from "./horsemen.js";
import { getFloor } from "./economy.js";
import { isCrystalItem } from "../memory/inventory.js";
import { crystalWeight, setAnchor, isAnchorOpen } from "./anchor.js";
import { overlay } from "../cutscene/overlay.js";
import { fogLayer } from "../cutscene/fog.js";
import { letterbox } from "../cutscene/letterbox.js";
import { stowWindows } from "../cutscene/windows.js";
import { clamp01, smooth, easeIn } from "../cutscene/math.js";
import { registerCues, playCue, tone, noise } from "../cutscene/audio.js";
import { bass, crackle, glass } from "../cutscene/instruments.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const PORTAL_ID = 'gachadnd-portal';
const RARITY_COLORS = { gray: '#9d9d9d', green: '#1eff00', blue: '#0070dd', purple: '#a335ee', red: '#ff003c' };
const RARITY_ORDER = ['gray', 'green', 'blue', 'purple', 'red'];

// ==========================================
// РИТУАЛЬНЫЙ КРУГ: руны и вязь
// ==========================================

const CENTER = 150, RUNE_RING = 111, TICK_RING = 136.5;

function seededRandom(seed) {
    let s = seed % 2147483647 || 1;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Руна: ствол и две-три ветви, как у старших рун; у каждого номера — своя */
function runePath(index) {
    const rnd = seededRandom(index * 7919 + 13);
    const h = 9, parts = [`M0 ${-h}L0 ${h}`];
    const branches = 2 + Math.floor(rnd() * 2);
    for (let b = 0; b < branches; b++) {
        const y = -h + 3 + rnd() * (2 * h - 6), side = rnd() < 0.5 ? -1 : 1, len = 4 + rnd() * 3, tilt = (rnd() - 0.5) * 10;
        parts.push(`M0 ${y.toFixed(1)}L${(side * len).toFixed(1)} ${(y + tilt).toFixed(1)}`);
    }
    if (rnd() < 0.35) parts.push(`M-4 ${-h + 2}L4 ${-h + 6}`);
    return parts.join('');
}

/** Мелкая вязь внешнего кольца: короткие штрихи разной формы по окружности */
const TICKS = (() => {
    const rnd = seededRandom(4242), out = [];
    for (let i = 0; i < 72; i++) {
        const a = i / 72 * Math.PI * 2, r = TICK_RING;
        const x = CENTER + Math.cos(a) * r, y = CENTER + Math.sin(a) * r;
        const tx = -Math.sin(a), ty = Math.cos(a), nx = Math.cos(a), ny = Math.sin(a);
        const kind = Math.floor(rnd() * 3), s = 2.2;
        if (kind === 0) out.push(`M${(x - nx * s).toFixed(1)} ${(y - ny * s).toFixed(1)}L${(x + nx * s).toFixed(1)} ${(y + ny * s).toFixed(1)}`);
        else if (kind === 1) out.push(`M${(x - nx * s).toFixed(1)} ${(y - ny * s).toFixed(1)}L${(x + tx * s).toFixed(1)} ${(y + ty * s).toFixed(1)}L${(x + nx * s).toFixed(1)} ${(y + ny * s).toFixed(1)}`);
        else out.push(`M${(x - tx * s).toFixed(1)} ${(y - ty * s).toFixed(1)}L${(x + tx * s).toFixed(1)} ${(y + ty * s).toFixed(1)}`);
    }
    return out;
})();

/** Руны платы по кругу: цвета — по порядку вклада, одна единица веса — одна руна */
function circleRunes(toll, colors, kindleFrom) {
    return Array.from({ length: toll }, (_, i) => {
        const a = -Math.PI / 2 + i / toll * Math.PI * 2;
        const lit = i < colors.length;
        return {
            x: (CENTER + Math.cos(a) * RUNE_RING).toFixed(1), y: (CENTER + Math.sin(a) * RUNE_RING).toFixed(1),
            angle: (a * 180 / Math.PI + 90).toFixed(1), path: runePath(i), lit,
            color: lit ? colors[i] : '#c9d4e6', kindle: lit && i >= kindleFrom, kindleIndex: Math.max(0, i - kindleFrom)
        };
    });
}

/** Плата за портал на этаже */
export const portalToll = (floor = getFloor()) => 2 + floor;

// Кристаллы, которыми можно платить: оранжевые всадники платой быть не могут
const payable = item => isCrystalItem(item) && (item.flags?.[MODULE_ID]?.rarity ?? 'gray') !== 'orange';
const quantity = item => Math.max(0, Number(item.system?.quantity ?? 1));

function currentRestNode(scene = mapScene()) {
    const map = scene?.getFlag(MODULE_ID, 'floorMap');
    const node = map?.nodes?.find(n => n.id === map.currentNodeId);
    return node?.type === 'rest' ? { map, node } : null;
}

async function savePortal(found, portal) {
    const copy = foundry.utils.deepClone(found.map);
    copy.nodes.find(n => n.id === found.node.id).portal = portal;
    await mapScene().setFlag(MODULE_ID, 'floorMap', copy);
}

// Вклад в плату с поправкой на то, что кристаллы могли потратить после того, как их положили
function pledgedTotal(pledges = {}) {
    let total = 0;
    for (const [actorId, items] of Object.entries(pledges)) {
        const actor = game.actors.get(actorId);
        for (const [itemId, count] of Object.entries(items ?? {})) {
            const item = actor?.items.get(itemId);
            if (item && payable(item)) total += crystalWeight(item) * Math.min(count, quantity(item));
        }
    }
    return total;
}

// ==========================================
// ОПЕРАЦИИ (выполняет Мастер)
// ==========================================

async function performPortalOp({ op, actorId, itemId, delta, userId }) {
    const found = currentRestNode();
    if (!found) return notifyUser(userId, 'Портал открывается только на Привале.');
    const user = game.users.get(userId);
    const portal = foundry.utils.deepClone(found.node.portal ?? { pledges: {} });
    portal.pledges ??= {};

    if (op === 'pledge') {
        const actor = game.actors.get(actorId);
        const item = actor?.items.get(itemId);
        if (!actor || !item || !payable(item)) return;
        if (!user?.isGM && !actor.testUserPermission(user, 'OWNER')) return notifyUser(userId, 'Класть в разрыв можно только кристаллы своего персонажа.');
        const mine = portal.pledges[actorId] ??= {};
        const next = Math.max(0, Math.min(quantity(item), (mine[itemId] ?? 0) + Math.sign(delta)));
        if (next) mine[itemId] = next;
        else delete mine[itemId];
        if (!Object.keys(mine).length) delete portal.pledges[actorId];
        return savePortal(found, portal);
    }

    if (op === 'open' && user?.isGM) {
        const toll = portalToll();
        const total = pledgedTotal(portal.pledges);
        if (total < toll) return notifyUser(userId, `Плата не набрана: ${total} из ${toll}.`);
        // Сцена открытия у всех: руны — цветами вклада, как в круге
        const colors = [];
        for (const [id, items] of Object.entries(portal.pledges)) {
            const actor = game.actors.get(id);
            for (const [crystalId, count] of Object.entries(items ?? {})) {
                const item = actor?.items.get(crystalId);
                if (item && payable(item)) colors.push(...Array(crystalWeight(item) * Math.min(count, quantity(item))).fill(RARITY_COLORS[item.flags[MODULE_ID]?.rarity] ?? '#c9d4e6'));
            }
        }
        emit('closePortal');
        PortalWindow.close();
        // Сцена Якоря загружается у всех, пока круг раскручивается; переход — когда туман закрыл экран
        const anchor = anchorScene();
        const sceneId = anchor && anchor.id !== canvas.scene?.id ? anchor.id : null;
        if (sceneId) preloadScene(anchor);
        emit('portalOpening', { colors: colors.slice(0, Math.max(toll, 12)), sceneId });
        await playPortalOpening(colors.slice(0, Math.max(toll, 12)), sceneId);
        const burned = [];
        for (const [id, items] of Object.entries(portal.pledges)) {
            const actor = game.actors.get(id);
            if (!actor) continue;
            const updates = [], deletions = [];
            for (const [crystalId, count] of Object.entries(items)) {
                const item = actor.items.get(crystalId);
                if (!item || !payable(item)) continue;
                const spent = Math.min(count, quantity(item));
                if (!spent) continue;
                burned.push(`${actor.name}: <span style="color: ${RARITY_COLORS[item.flags[MODULE_ID]?.rarity] ?? '#aaa'}">${item.name.replace(/^Кристалл:\s*/, '')}</span>${spent > 1 ? ` ×${spent}` : ''}`);
                if (spent >= quantity(item)) deletions.push(item.id);
                else updates.push({ _id: item.id, 'system.quantity': quantity(item) - spent });
            }
            if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
            if (deletions.length) await actor.deleteEmbeddedDocuments('Item', deletions);
        }
        await savePortal(found, { pledges: {} });
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: 'Разрыв' }),
            content: `<div class="gd-scent-chat"><i class="fas fa-hurricane"></i> Кристаллы гаснут один за другим — вероятность рвёт ткань узла. Портал в Предел открыт.<br><small>${burned.join(' · ')}</small></div>`
        });
        if (!isAnchorOpen()) await setAnchor(true, { travel: false });
    }
}

let queue = Promise.resolve();
onSocket('portalOp', message => {
    if (!isActiveGM()) return;
    queue = queue.then(() => performPortalOp(message.payload)).catch(err => console.error('[GachaDND] Портал:', err));
    return queue;
});
onSocket('openPortal', () => PortalWindow.show());
onSocket('portalOpening', ({ colors, sceneId }) => playPortalOpening(colors, sceneId));
onSocket('closePortal', () => PortalWindow.close());

const request = payload => requestGM('portalOp', payload);

// ==========================================
// ОКНО ПОРТАЛА
// ==========================================

export class PortalWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: PORTAL_ID,
        classes: ['gachadnd-portal'],
        tag: 'div',
        window: { title: 'Портал в Предел', icon: 'fas fa-hurricane', resizable: true },
        position: { width: 560, height: 640 },
        actions: {
            pledge: PortalWindow.#onPledge,
            open: () => request({ op: 'open' })
        }
    };

    static PARTS = { body: { template: 'modules/gachadnd/templates/portal/body.hbs', scrollable: ['.gd-portal-party'] } };

    #lit = 0;

    // Мастер открывает окно платы у всех
    static open() {
        if (!currentRestNode()) return ui.notifications.warn('Портал открывается только на Привале.');
        if (isAnchorOpen()) return ui.notifications.warn('Отряд уже в Якоре.');
        if (game.user.isGM) emit('openPortal');
        return PortalWindow.show();
    }

    static show() {
        const existing = foundry.applications.instances?.get(PORTAL_ID);
        if (existing) return existing.render({ force: true });
        return new PortalWindow().render({ force: true });
    }

    static close() {
        foundry.applications.instances?.get(PORTAL_ID)?.close();
    }

    async _prepareContext() {
        const found = currentRestNode();
        const pledges = found?.node.portal?.pledges ?? {};
        const toll = portalToll();
        const total = pledgedTotal(pledges);
        const party = partyActors().map(actor => {
            const mine = pledges[actor.id] ?? {};
            const crystals = actor.items.filter(payable)
                .map(item => {
                    const rarity = item.flags[MODULE_ID]?.rarity ?? 'gray';
                    const pledged = Math.min(mine[item.id] ?? 0, quantity(item));
                    return {
                        id: item.id, rarity, color: RARITY_COLORS[rarity] ?? '#aaa',
                        name: item.name.replace(/^Кристалл:\s*/, ''), weight: crystalWeight(item), skillId: item.flags[MODULE_ID]?.skill_id ?? '',
                        quantity: quantity(item), pledged, img: item.img
                    };
                })
                .sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || a.name.localeCompare(b.name));
            const given = crystals.reduce((sum, c) => sum + c.weight * c.pledged, 0);
            return { id: actor.id, name: actor.name, img: actor.img, crystals, given, editable: game.user.isGM || actor.isOwner };
        });
        // Руны загораются по порядку вклада: персонаж за персонажем, кристалл за кристаллом
        const colors = party.flatMap(m => m.crystals.flatMap(c => Array(c.weight * c.pledged).fill(c.color))).slice(0, toll);
        // Новые руны вспыхивают один раз: этот клиент помнит, сколько горело в прошлый раз
        const kindleFrom = Math.min(this.#lit, colors.length);
        this.#lit = colors.length;
        return {
            atRest: !!found, toll, total, ready: total >= toll, missing: Math.max(0, toll - total), over: Math.max(0, total - toll),
            isGM: game.user.isGM, party, ticks: TICKS, runes: circleRunes(toll, colors, kindleFrom)
        };
    }

    // Левый щелчок кладёт кристалл в разрыв, правый — забирает
    _onRender(context, options) {
        super._onRender(context, options);
        this.element.querySelectorAll('[data-action="pledge"]').forEach(el => el.addEventListener('contextmenu', event => {
            event.preventDefault();
            PortalWindow.#pledge(el, -1);
        }));
    }

    static #onPledge(event, target) {
        PortalWindow.#pledge(target, 1);
    }

    static #pledge(target, delta) {
        const { actorId, itemId } = target.dataset;
        if (delta > 0) PortalWindow.#fly(target);
        request({ op: 'pledge', actorId, itemId, delta });
    }

    // Кристалл летит с полки в круг и тает в нём
    static #fly(target) {
        const img = target.querySelector('img'), circle = target.closest('.gd-portal')?.querySelector('.gd-circle-svg');
        if (!img || !circle || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const from = img.getBoundingClientRect(), to = circle.getBoundingClientRect();
        const ghost = img.cloneNode();
        Object.assign(ghost.style, { position: 'fixed', left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, zIndex: 10040, pointerEvents: 'none', filter: `drop-shadow(0 0 8px ${getComputedStyle(target).getPropertyValue('--rarity')})` });
        document.body.append(ghost);
        const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
        const flight = ghost.animate([
            { transform: 'translate(0, 0) scale(1)', opacity: 1 },
            { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 40}px) scale(1.15)`, opacity: 1, offset: 0.55 },
            { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0 }
        ], { duration: 520, easing: 'cubic-bezier(0.45, 0, 0.6, 1)' });
        flight.onfinish = flight.oncancel = () => ghost.remove();
    }
}

// Плата изменилась — окно перерисовывается у всех; кристаллы персонажей — тоже
Hooks.on('updateScene', (scene, changes) => {
    if (scene.id !== mapScene()?.id || !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) return;
    const app = foundry.applications.instances?.get(PORTAL_ID);
    if (app?.rendered) app.render();
});
const refresh = item => {
    if (!item?.parent?.hasPlayerOwner) return;
    const app = foundry.applications.instances?.get(PORTAL_ID);
    if (app?.rendered) app.render();
};
for (const hook of ['createItem', 'updateItem', 'deleteItem']) Hooks.on(hook, refresh);


// ==========================================
// СЦЕНА ОТКРЫТИЯ
// ==========================================

// Мс: затемнение, раскрутка, туман Предела закрывает экран, туман отступает
const OPEN = { dim: 250, spin: 1050, white: 600, out: 1000 };

registerCues({
    // Раскрутка: нарастающий гул и хор звенящих тонов
    portalSpin(ctx, bus, t0, { duration = 1.05 } = {}) {
        bass(ctx, bus, t0, 'swell', { pitch: 0.9, level: 0.8, length: duration });
        for (const [f, g] of [[440, 0.08], [660, 0.06], [990, 0.05]]) tone(ctx, bus, t0, { freq: [f, f * 1.5], gain: [[0, 0.0001], [duration, g], [duration + 0.1, 0.0001]], duration: duration + 0.1, send: 0.7 });
        crackle(ctx, bus, t0 + duration * 0.3, { count: 40, spread: duration * 0.7, level: 0.3, freq: [3000, 8000], send: 0.6 });
    },
    // Открытие: вдох-провал и звон
    portalOpen(ctx, bus, t0) {
        noise(ctx, bus, t0, { type: 'lowpass', freq: [4000, 200], q: 0.7, gain: [[0, 0.6], [0.8, 0.0001]], duration: 0.85, send: 0.8 });
        bass(ctx, bus, t0, 'drop', { pitch: 0.9, level: 0.7, length: 1 });
        glass(ctx, bus, t0 + 0.02, { level: 0.25 });
    }
});

const cue = (name, options = {}) => {
    if (!game.settings.get(MODULE_ID, 'soundsEnabled')) return;
    playCue(name, { volume: game.settings.get(MODULE_ID, 'soundsVolume'), ...options });
};

let opening = false;

/**
 * Сцена открытия портала: круг раскручивается, кристаллы сгорают искрами, туман Предела закрывает экран.
 * sceneId — сцена Якоря: под туманом Мастер её активирует, и туман держится у каждого, пока она не дорисуется.
 */
export function playPortalOpening(colors = [], sceneId = null) {
    if (opening) return Promise.resolve(false);
    opening = true;
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const slow = Math.max(1, Number(game.settings.get(MODULE_ID, 'impactSlow')) || 1);
    const restoreWindows = stowWindows();
    const bars = letterbox(0.1);
    const { ctx, W, H, remove } = overlay();
    // Туман Предела поверх круга: на пике он закрывает экран, под ним меняется сцена
    const fog = fogLayer();
    fog.render(0, 0);
    const n = Math.max(colors.length, 3);
    const glyphs = Array.from({ length: n }, (_, i) => new Path2D(runePath(i)));
    const ticks = new Path2D();
    for (const d of TICKS) ticks.addPath(new Path2D(d));
    const sparks = [];
    const sS = OPEN.dim, sW = sS + OPEN.spin, sO = sW + OPEN.white, end = sO + OPEN.out;
    const cued = new Set();
    const once = (name, t, at, options) => { if (t >= at && !cued.has(name)) { cued.add(name); cue(name, options); } };

    return new Promise(resolve => {
        const t0 = performance.now();
        let lastT = 0, angle = 0, watchdog = null, last = t0;
        // Ожидание сцены Якоря: время катсцены стоит, пока экран закрыт туманом
        let paused = 0, travel = sceneId ? 'pending' : 'none';
        const finish = () => {
            if (!opening) return;
            clearTimeout(watchdog);
            bars.remove();
            remove();
            fog.remove();
            restoreWindows();
            opening = false;
            resolve(true);
        };
        const guard = () => {
            if (!opening) return;
            if (performance.now() - t0 - paused > (end + 4000) * slow) return finish();
            watchdog = setTimeout(guard, 1000);
        };
        watchdog = setTimeout(guard, 1000);

        const frame = now => {
            if (!opening) return;
            try {
                if (travel === 'waiting') paused += now - last;
                last = now;
                let t = (now - t0 - paused) / slow;
                // Туман закрыл экран: переход на сцену Якоря
                if (t >= sO && travel === 'pending') {
                    travel = 'waiting';
                    t = sO;
                    if (game.user.isGM) game.scenes.get(sceneId)?.activate();
                    arrival(sceneId).then(() => { travel = 'done'; });
                }
                if (travel === 'waiting') t = sO;
                const dt = Math.max(0, Math.min(50, t - lastT)) / 1000;
                lastT = t;
                if (t >= end) return finish();
                once('portalSpin', t, sS, { duration: OPEN.spin / 1000 * slow });
                once('portalOpen', t, sW);
                const k = clamp01((t - sS) / OPEN.spin);
                // Скорость растёт к пику: от четверти оборота в секунду до трёх оборотов
                angle += dt * Math.PI * 2 * (0.25 + 2.75 * easeIn(k)) * (calm ? 0.5 : 1);
                draw(t, k, dt);
            } catch (error) {
                console.error(`${MODULE_ID} | открытие портала`, error);
                return finish();
            }
            requestAnimationFrame(frame);
        };

        const draw = (t, k, dt) => {
            const dpr = devicePixelRatio, cx = W / 2, cy = H / 2, R = H * 0.3;
            const dim = smooth(clamp01(t / OPEN.dim)) * (1 - smooth(clamp01((t - sO) / OPEN.out)));
            bars.show(dim);
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = `rgba(4, 7, 16, ${0.8 * dim})`;
            ctx.fillRect(0, 0, W, H);
            const fade = 1 - smooth(clamp01((t - sW) / OPEN.white));
            if (fade > 0) {
                // К развязке круг разрастается
                const scale = R / 140 * (1 + 0.35 * easeIn(k));
                ctx.save();
                ctx.translate(cx, cy);
                ctx.globalAlpha = dim * fade;
                // Кольца и вязь: вязь крутится навстречу рунам
                ctx.strokeStyle = `rgba(201, 212, 230, ${0.45 + 0.4 * k})`;
                ctx.lineWidth = 1.2 * dpr;
                for (const r of [140, 133, 124, 98]) { ctx.beginPath(); ctx.arc(0, 0, r * scale, 0, Math.PI * 2); ctx.stroke(); }
                ctx.save();
                ctx.rotate(-angle * 0.6);
                ctx.scale(scale, scale);
                ctx.translate(-150, -150);
                ctx.lineWidth = 0.9;
                ctx.stroke(ticks);
                ctx.restore();
                // Руны цветами вклада; кристаллы сгорают — от рун к центру летят искры
                ctx.globalCompositeOperation = 'lighter';
                for (let i = 0; i < n; i++) {
                    const a = -Math.PI / 2 + i / n * Math.PI * 2 + angle;
                    const x = Math.cos(a) * 111 * scale, y = Math.sin(a) * 111 * scale, color = colors[i] ?? '#c9d4e6';
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(a + Math.PI / 2);
                    const gs = scale * 2.1;
                    ctx.scale(gs, gs);
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    for (const [w, al] of [[16, 0.12], [8, 0.3], [3.5, 0.9], [1.6, 1]]) {
                        ctx.strokeStyle = w > 2 ? color : '#ffffff';
                        ctx.globalAlpha = dim * fade * al * (0.75 + 0.25 * k);
                        ctx.lineWidth = w / gs * dpr;
                        ctx.stroke(glyphs[i]);
                    }
                    ctx.restore();
                    if (Math.random() < dt * (8 + 40 * k)) sparks.push({ x, y, color, age: 0, life: 0.45 + Math.random() * 0.3 });
                }
                ctx.globalAlpha = 1;
                // Искры с хвостом тянутся к центру: кристалл сгорает в круге
                ctx.lineCap = 'round';
                for (const p of sparks) {
                    p.age += dt;
                    const q = easeIn(clamp01(p.age / p.life)), q0 = easeIn(clamp01((p.age - 0.08) / p.life));
                    ctx.strokeStyle = p.color;
                    ctx.globalAlpha = (1 - q * 0.4) * fade;
                    ctx.lineWidth = (4 - 2.5 * q) * dpr;
                    ctx.beginPath();
                    ctx.moveTo(p.x * (1 - q0), p.y * (1 - q0));
                    ctx.lineTo(p.x * (1 - q), p.y * (1 - q));
                    ctx.stroke();
                }
                for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].age >= sparks[i].life) sparks.splice(i, 1);
                // Сердце круга разгорается
                const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 98 * scale);
                core.addColorStop(0, `rgba(220, 230, 255, ${0.15 + 0.8 * easeIn(k)})`);
                core.addColorStop(1, 'rgba(120, 150, 255, 0)');
                ctx.globalAlpha = fade;
                ctx.fillStyle = core;
                ctx.fillRect(-98 * scale, -98 * scale, 196 * scale, 196 * scale);
                ctx.restore();
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1;
            }
            // Туман Предела: наползает от краёв, пока круг на пике, закрывает экран и отступает
            const cover = t < sO ? smooth(clamp01((t - sW + 350) / (OPEN.white + 350))) : 1 - smooth(clamp01((t - sO) / OPEN.out));
            fog.render(cover, t / 1000);
        };
        requestAnimationFrame(frame);
    });
}
