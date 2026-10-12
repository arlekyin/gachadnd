/**
 * Gacha Roguelike dnd5e — Прорыв Пожирателя
 *
 * Мастер нажимает «Здесь» в предвестиях и щёлкает точку на сцене. У всех на этой сцене идёт катсцена:
 * камера наезжает на точку, ткань узла трескается швом, шов раскрывается, в разрыве — Пожиратель и
 * его «ещё…», удар, разрыв схлопывается. Затем Мастер ставит токен Пожирателя в эту точку, а
 * предвестие остаётся на стадии «Здесь»: бирюза, туман и размытие по краям.
 *
 * Токен — от актёра мира с флагом creature: devourer (туда Мастер вписывает Глубину и Насыщение);
 * если его нет — актёр импортируется из компендиума «Бестиарий Лабиринта».
 */

import { MODULE_ID } from "../core/constants.js";
import { emit, onSocket } from "../core/socket.js";
import { stageCamera, shaker } from "../cutscene/camera.js";
import { letterbox } from "../cutscene/letterbox.js";
import { overlay } from "../cutscene/overlay.js";
import { clamp01, smooth, easeOut, easeIn, seeded } from "../cutscene/math.js";
import { registerCues, playCue, tone, noise } from "../cutscene/audio.js";
import { crackle, bass, slam, glass, flutter } from "../cutscene/instruments.js";
import { setOmen } from "./omen.js";

const ART = new URL('../../assets/bestiary/devourer.webp', import.meta.url).href;
// Где на картинке морда: доля ширины и высоты — она встаёт в середину разрыва
const FACE = { x: 0.6, y: 0.45 };
const WHISPER = 'ещё…';

// Расписание, мс: наезд, шов, разрыв, удар, схлопывание
const T = { focus: 700, seam: 800, tear: 900, burst: 220, close: 800 };
// Наезд камеры (множитель масштаба), высота шва и наибольшая ширина разрыва — доли высоты экрана
const ZOOM = 1.6, SEAM = 0.6, GAP = 0.2;
const TEAL = [2, 251, 242], DEEP = [0, 105, 100];

// ==========================================
// ЗВУКИ
// ==========================================

registerCues({
    // Гул из-под пола: низкий нарастающий
    breachRumble(ctx, bus, t0, { duration = 0.7 } = {}) {
        bass(ctx, bus, t0, 'swell', { pitch: 0.7, level: 0.9, length: duration + 0.4 });
        for (const pan of [-0.5, 0.5]) noise(ctx, bus, t0, { type: 'lowpass', freq: [90, 260], q: 0.7, gain: [[0, 0.0001], [duration, 0.35], [duration + 0.5, 0.0001]], duration: duration + 0.5, pan, send: 0.5 });
    },
    // Шов: сухой треск ткани, идущий от середины
    breachSeam(ctx, bus, t0, { duration = 0.8 } = {}) {
        crackle(ctx, bus, t0, { count: 60, spread: duration, level: 0.55, freq: [1800, 6500], send: 0.4 });
        tone(ctx, bus, t0, { type: 'sawtooth', freq: [55, 70], gain: [[0, 0.0001], [duration, 0.18], [duration + 0.1, 0.0001]], duration: duration + 0.1, crushed: true, send: 0.3 });
    },
    // Разрыв раскрывается: рвущийся свист и шёпот изнутри
    breachTear(ctx, bus, t0, { duration = 0.9 } = {}) {
        flutter(ctx, bus, t0, { freq: [400, 1600], q: 1.4, rate: [9, 22], level: 0.6, duration, send: 0.5 });
        for (const pan of [-0.7, 0.7]) noise(ctx, bus, t0 + 0.25, { type: 'bandpass', freq: [900, 1400], q: 6, gain: [[0, 0.0001], [0.3, 0.12], [duration, 0.0001]], duration, pan, send: 0.7 });
        bass(ctx, bus, t0, 'swell', { pitch: 0.9, level: 0.8, length: duration });
    },
    // Выход: тяжёлый удар, звон осколков ткани
    breachBurst(ctx, bus, t0) {
        slam(ctx, bus, t0, { pitch: 0.75, body: 1.6, sub: 1.3, subLen: 1.4, rumble: 1.2, rumbleLen: 1.8, send: 0.6 });
        glass(ctx, bus, t0 + 0.02, { level: 0.3 });
    },
    // Разрыв схлопывается: глухой провал вниз
    breachClose(ctx, bus, t0) {
        bass(ctx, bus, t0, 'drop', { pitch: 0.8, level: 0.8, length: 0.7 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [1200, 120], q: 0.8, gain: [[0, 0.4], [0.5, 0.0001]], duration: 0.55, send: 0.6 });
    }
});

function cue(name, options = {}) {
    if (!game.settings.get(MODULE_ID, 'soundsEnabled')) return;
    playCue(name, { volume: game.settings.get(MODULE_ID, 'soundsVolume'), ...options });
}

// ==========================================
// ВЫБОР ТОЧКИ И ТОКЕН
// ==========================================

/** Мастер щёлкает точку на сцене. Правый щелчок или Esc — отмена. @returns {Promise<{x,y}|null>} */
function pickPoint() {
    const view = canvas?.app?.view ?? canvas?.app?.canvas;
    if (!canvas?.ready || !view) return Promise.resolve(null);
    ui.notifications.info('Прорыв: щёлкните точку на сцене, где появится Пожиратель. Правый щелчок или Esc — отмена.');
    const cursor = view.style.cursor;
    view.style.cursor = 'crosshair';
    return new Promise(resolve => {
        const done = point => {
            view.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('keydown', onKey, true);
            view.style.cursor = cursor;
            resolve(point);
        };
        const onDown = event => {
            // Щелчок не должен выделить токен или снять выделение
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.button !== 0) return done(null);
            const rect = view.getBoundingClientRect();
            const p = canvas.stage.worldTransform.applyInverse(new PIXI.Point(event.clientX - rect.left, event.clientY - rect.top));
            done({ x: Math.round(p.x), y: Math.round(p.y) });
        };
        const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); done(null); } };
        view.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey, true);
    });
}

async function devourerActor() {
    const world = game.actors.find(a => a.getFlag(MODULE_ID, 'creature') === 'devourer');
    if (world) return world;
    const pack = game.packs.get(`${MODULE_ID}.gacha-bestiary`);
    const index = await pack?.getIndex({ fields: [`flags.${MODULE_ID}.creature`] });
    const entry = index?.find(e => e.flags?.[MODULE_ID]?.creature === 'devourer');
    if (!entry) return null;
    ui.notifications.info('Пожирателя нет среди актёров мира — он импортирован из Бестиария Лабиринта.');
    return game.actors.importFromCompendium(pack, entry._id);
}

/** Токен Пожирателя серединой в точку, по сетке */
async function placeDevourer(point) {
    const actor = await devourerActor();
    if (!actor) return ui.notifications.warn('Актёр Пожирателя не найден ни в мире, ни в Бестиарии Лабиринта.');
    const size = canvas.grid.size;
    const proto = actor.prototypeToken;
    const x = Math.round((point.x - (proto.width ?? 2) * size / 2) / size) * size;
    const y = Math.round((point.y - (proto.height ?? 2) * size / 2) / size) * size;
    const data = (await actor.getTokenDocument({ x, y })).toObject();
    await canvas.scene.createEmbeddedDocuments('Token', [data]);
}

/** Прорыв: точка, катсцена у всех, токен. Только Мастер */
export async function startBreach() {
    if (!game.user.isGM) return ui.notifications.warn('Прорыв Пожирателя начинает Мастер.');
    if (playing) return;
    const point = await pickPoint();
    if (!point) return;
    const data = { sceneId: canvas.scene.id, point };
    emit('devourerBreach', data);
    await setOmen('here');
    await playBreach(data);
    await placeDevourer(point);
}
onSocket('devourerBreach', data => playBreach(data));

// ==========================================
// КАТСЦЕНА
// ==========================================

let playing = false;
let artImage = null;
function loadArt() {
    if (artImage) return Promise.resolve(artImage);
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(artImage = img);
        img.onerror = () => resolve(null);
        img.src = ART;
    });
}

/** Шов: ломаная сверху вниз с ответвлениями, координаты в долях высоты шва (−0,5…0,5) */
function seamShape(rnd) {
    const points = [];
    for (let i = 0; i <= 24; i++) {
        const s = i / 24 - 0.5;
        points.push({ s, x: (rnd() - 0.5) * 0.05 + Math.sin(s * 9 + rnd()) * 0.012 });
    }
    const branches = Array.from({ length: 5 }, () => {
        const at = Math.floor(3 + rnd() * 19), side = rnd() < 0.5 ? -1 : 1;
        return { at, side, len: 0.05 + rnd() * 0.07, bend: (rnd() - 0.5) * 0.06, delay: rnd() * 0.5 };
    });
    return { points, branches };
}

const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** Катсцена прорыва. @returns {Promise<boolean>} false — на этой сцене не показана */
export async function playBreach({ sceneId, point }) {
    if (playing || !canvas?.ready || canvas.scene?.id !== sceneId || !point) return false;
    playing = true;
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const slow = Math.max(1, Number(game.settings.get(MODULE_ID, 'impactSlow')) || 1);
    const art = await loadArt();
    const cam = stageCamera();
    const bars = letterbox(0.1);
    const { canvas: cv, ctx, W, H, remove } = overlay();
    const shake = shaker(22);
    const shape = seamShape(seeded(Math.round(point.x * 31 + point.y * 17) % 2147483646 + 1));
    const tilt = -0.12;
    const sF = T.focus, sS = sF + T.seam, sT = sS + T.tear, sB = sT + T.burst, end = sB + T.close;
    const cued = new Set();
    const once = (name, t, at, options) => { if (t >= at && !cued.has(name)) { cued.add(name); cue(name, options); } };

    return new Promise(resolve => {
        const finish = () => {
            if (!playing) return;
            clearTimeout(watchdog);
            cam?.restore();
            bars.remove();
            remove();
            playing = false;
            resolve(true);
        };
        // Сторож: если кадры перестали идти (вкладка свёрнута), катсцена не остаётся на экране.
        // Время — то же, что у кадров
        const t0 = performance.now();
        let watchdog = null;
        const guard = () => {
            if (!playing) return;
            if (performance.now() - t0 > (end + 4000) * slow) return finish();
            watchdog = setTimeout(guard, 1000);
        };
        watchdog = setTimeout(guard, 1000);
        const frame = now => {
            if (!playing) return;
            try {
                const t = (now - t0) / slow;
                if (t >= end || !canvas.ready) return finish();
                once('breachRumble', t, 0, { duration: T.focus / 1000 * slow });
                once('breachSeam', t, sF, { duration: T.seam / 1000 * slow });
                once('breachTear', t, sS, { duration: T.tear / 1000 * slow });
                once('breachBurst', t, sT);
                once('breachClose', t, sB);
                if (!calm) {
                    if (t >= sF && !cued.has('kick1')) { cued.add('kick1'); shake.kick(t, 6); }
                    if (t >= sS && !cued.has('kick2')) { cued.add('kick2'); shake.kick(t, 10); }
                    if (t >= sT && !cued.has('kick3')) { cued.add('kick3'); shake.kick(t, 34); }
                }

                // Камера: наезд к точке, после удара — обратно
                const inK = easeOut(clamp01(t / T.focus)), outK = smooth(clamp01((t - sB - 200) / (T.close - 200)));
                const k = inK * (1 - outK);
                const sh = shake.offset(t, 420);
                cam?.place({ k, scale: cam.saved.sx * ZOOM, center: point, rot: -0.03 * k, dx: sh.x, dy: sh.y });
                bars.show(k);

                draw(t, k);
            } catch (error) {
                console.error(`${MODULE_ID} | прорыв`, error);
                return finish();
            }
            requestAnimationFrame(frame);
        };

        // Кадр: затемнение, шов, разрыв с Пожирателем, вспышка
        const draw = (t, k) => {
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = `rgba(0, 12, 12, ${0.45 * k})`;
            ctx.fillRect(0, 0, W, H);
            const c = cam ? cam.screenOf(point) : { x: W / 2, y: H / 2 };
            const len = H * SEAM;
            // Рост шва от середины; раскрытие; схлопывание
            const grow = easeOut(clamp01((t - sF) / T.seam));
            const open = t < sS ? 0 : t < sT ? easeIn(clamp01((t - sS) / T.tear)) : t < sB ? 1 : 1 - easeIn(clamp01((t - sB) / (T.close * 0.45)));
            const fade = 1 - smooth(clamp01((t - sB - T.close * 0.4) / (T.close * 0.6)));
            if (grow <= 0 || fade <= 0) return;

            ctx.save();
            ctx.translate(c.x, c.y);
            ctx.rotate(tilt);
            const pts = shape.points.filter(p => Math.abs(p.s) <= grow / 2 + 1e-6).map(p => ({ x: p.x * len, y: p.s * len, s: p.s }));
            // Ширина разрыва по высоте: в середине шире, к концам сходится
            const width = s => GAP * H * open * Math.pow(Math.max(0, Math.cos(s * Math.PI)), 0.8) * (0.5 + 0.5 * Math.min(1, grow * 1.2));
            const left = pts.map(p => ({ x: p.x - width(p.s), y: p.y })), right = pts.map(p => ({ x: p.x + width(p.s), y: p.y }));
            const outline = () => {
                ctx.beginPath();
                left.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
                for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
                ctx.closePath();
            };

            // Внутри разрыва — тьма и Пожиратель, проступающий из глубины
            if (open > 0.01) {
                ctx.save();
                outline();
                ctx.clip();
                ctx.fillStyle = '#010606';
                ctx.fillRect(-len, -len, len * 2, len * 2);
                if (art) {
                    ctx.rotate(-tilt);
                    const size = H * 0.95, lift = (1 - open) * H * 0.06;
                    ctx.globalAlpha = smooth(clamp01((t - sS - T.tear * 0.25) / (T.tear * 0.6))) * fade;
                    ctx.drawImage(art, -size * FACE.x, -size * FACE.y + lift, size, size);
                    ctx.globalCompositeOperation = 'color';
                    ctx.fillStyle = rgba(DEEP, 0.55);
                    ctx.fillRect(-size, -size, size * 2, size * 2);
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = 1;
                }
                // Свет от краёв внутрь
                const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, GAP * H * 1.2);
                glow.addColorStop(0, 'rgba(0, 0, 0, 0)');
                glow.addColorStop(1, rgba(TEAL, 0.35 * open));
                ctx.fillStyle = glow;
                ctx.fillRect(-len, -len, len * 2, len * 2);
                ctx.restore();
            }

            // Кромка: несколько обводок от широкой бледной к тонкой яркой; мерцает
            const flicker = 0.75 + 0.25 * Math.sin(t * 0.05) * Math.sin(t * 0.017);
            ctx.globalCompositeOperation = 'lighter';
            ctx.lineJoin = 'round';
            for (const [w, a] of [[26, 0.06], [12, 0.14], [5, 0.4], [2, 0.95]]) {
                ctx.strokeStyle = rgba(w > 4 ? TEAL : [200, 255, 252], a * flicker * fade);
                ctx.lineWidth = w * devicePixelRatio;
                if (open > 0.01) { outline(); ctx.stroke(); }
                else {
                    ctx.beginPath();
                    pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
                    ctx.stroke();
                }
            }
            // Ответвления трещины
            for (const b of shape.branches) {
                const p = shape.points[b.at];
                const g = clamp01((grow - 0.3 - b.delay * 0.5) / 0.4) * (1 - open * 0.6);
                if (g <= 0 || Math.abs(p.s) > grow / 2) continue;
                const x0 = p.x * len + b.side * width(p.s), y0 = p.s * len;
                ctx.strokeStyle = rgba(TEAL, 0.5 * fade);
                ctx.lineWidth = 2 * devicePixelRatio;
                ctx.beginPath();
                ctx.moveTo(x0, y0);
                ctx.lineTo(x0 + b.side * b.len * len * g, y0 + b.bend * len * g);
                ctx.stroke();
            }
            ctx.globalCompositeOperation = 'source-over';

            // «ещё…» рядом с разрывом
            const word = clamp01((t - sS - T.tear * 0.45) / 250) * (1 - clamp01((t - sT) / 200));
            if (word > 0) {
                ctx.rotate(-tilt);
                ctx.font = `italic ${Math.round(H * 0.065)}px "GD Caveat", serif`;
                ctx.fillStyle = rgba([200, 255, 252], 0.85 * word * flicker);
                ctx.fillText(WHISPER, GAP * H * 0.9, -len * 0.18);
            }
            ctx.restore();

            // Удар: вспышка бирюзой
            const flash = t >= sT ? 1 - clamp01((t - sT) / (T.burst + 250)) : 0;
            if (flash > 0) {
                ctx.fillStyle = rgba(calm ? DEEP : [150, 255, 248], (calm ? 0.3 : 0.7) * flash * flash);
                ctx.fillRect(0, 0, W, H);
            }
        };
        requestAnimationFrame(frame);
    });
}
