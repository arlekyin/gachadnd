/**
 * Gacha Roguelike dnd5e — Прорыв Пожирателя
 *
 * Мастер нажимает «Здесь» в предвестиях и щёлкает точку на сцене. У всех на этой сцене идёт катсцена:
 * камера наезжает на точку, ткань узла трескается швом, шов раскрывается, в разрыве — Пожиратель и
 * его «ещё…», удар, разрыв схлопывается рябью, как от камня в воде. Токен Пожирателя Мастер ставит
 * в эту точку сразу, прозрачным: катсцена проявляет его из тумана после схлопывания. Предвестие
 * остаётся на стадии «Здесь»: бирюза, светящийся туман с искрами и размытие по краям.
 *
 * Токен — от актёра мира с флагом creature: devourer (туда Мастер вписывает Глубину и Насыщение);
 * если его нет — актёр импортируется из компендиума «Бестиарий Лабиринта».
 */

import { MODULE_ID } from "../core/constants.js";
import { emit, onSocket } from "../core/socket.js";
import { stageCamera, shaker } from "../cutscene/camera.js";
import { stageFilter } from "../cutscene/stage.js";
import { stowWindows } from "../cutscene/windows.js";
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
// Закрытие: разрыв схлопывается за SNAP, дальше по сцене идёт рябь, как от камня в воде
const T = { focus: 700, seam: 800, tear: 900, burst: 220, close: 1400 };
const SNAP = 180;
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
    // Разрыв схлопывается: глухой всплеск, как камень в глубокую воду, и расходящийся гул
    breachClose(ctx, bus, t0) {
        const at = t0 + SNAP / 1000;
        tone(ctx, bus, at, { freq: [220, 45], gain: [[0, 0.9], [0.35, 0.0001]], duration: 0.4, deep: true, send: 0.5 });
        noise(ctx, bus, at, { type: 'bandpass', freq: [900, 250], q: 2.5, gain: [[0, 0.5], [0.25, 0.0001]], duration: 0.3, send: 0.7 });
        bass(ctx, bus, at, 'drop', { pitch: 0.7, level: 0.7, length: 0.9 });
        for (const pan of [-0.6, 0.6]) noise(ctx, bus, at + 0.05, { type: 'lowpass', freq: [500, 90], q: 0.8, gain: [[0, 0.25], [1.0, 0.0001]], duration: 1.05, pan, send: 0.8 });
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

/**
 * Токен Пожирателя серединой в точку, по сетке — сразу, но прозрачным: флаг breach хранит его
 * прозрачность. Катсцена у каждого проявляет его из тумана, в конце Мастер делает его видимым.
 */
async function placeDevourer(point) {
    const actor = await devourerActor();
    if (!actor) { ui.notifications.warn('Актёр Пожирателя не найден ни в мире, ни в Бестиарии Лабиринта.'); return null; }
    const size = canvas.grid.size;
    const proto = actor.prototypeToken;
    const x = Math.round((point.x - (proto.width ?? 2) * size / 2) / size) * size;
    const y = Math.round((point.y - (proto.height ?? 2) * size / 2) / size) * size;
    const data = (await actor.getTokenDocument({ x, y })).toObject();
    data.flags = foundry.utils.mergeObject(data.flags ?? {}, { [MODULE_ID]: { breach: { alpha: data.alpha ?? 1 } } });
    data.alpha = 0;
    const [token] = await canvas.scene.createEmbeddedDocuments('Token', [data]);
    return token ?? null;
}

/** Прорыв: точка, катсцена у всех, токен. Только Мастер */
export async function startBreach() {
    if (!game.user.isGM) return ui.notifications.warn('Прорыв Пожирателя начинает Мастер.');
    if (playing) return;
    const point = await pickPoint();
    if (!point) return;
    const data = { sceneId: canvas.scene.id, point };
    emit('devourerBreach', data);
    // Токен ставится, пока идёт катсцена; проявляется он в ней
    const placed = placeDevourer(point).catch(error => { console.error(`${MODULE_ID} | токен Пожирателя`, error); return null; });
    await setOmen('here');
    await playBreach(data);
    const token = await placed;
    if (token) await token.update({ alpha: token.getFlag(MODULE_ID, 'breach')?.alpha ?? 1, [`flags.${MODULE_ID}.-=breach`]: null });
}

// Токен, который катсцена уже проявила, остаётся видимым, пока не придёт его обновление от Мастера:
// перерисовка токена иначе вернула бы прозрачность из документа
const revealed = new Set();
const breachAlpha = token => token.document?.flags?.[MODULE_ID]?.breach?.alpha ?? 1;
function showToken(token, k) {
    const a = breachAlpha(token) * k;
    token.alpha = a;
    if (token.mesh) token.mesh.alpha = a;
}
Hooks.on('refreshToken', token => {
    if (revealed.has(token.id) && token.document.flags?.[MODULE_ID]?.breach) showToken(token, 1);
});
Hooks.on('updateToken', doc => {
    if (!doc.flags?.[MODULE_ID]?.breach) revealed.delete(doc.id);
});
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

// Рябь по сцене: кольца бегут от точки, за фронтом гаснут; изображение колышется вдоль радиуса,
// на гребнях — бирюзовый отсвет
const RIPPLE_SHADER = `
precision highp float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 inputSize;
uniform vec4 outputFrame;
uniform vec4 inputClamp;
uniform vec2 uCenter;
uniform float uFront;
uniform float uWave;
uniform float uAmp;
uniform float uGlow;
void main() {
    vec2 screen = vTextureCoord * inputSize.xy + outputFrame.xy;
    vec2 d = screen - uCenter;
    float r = length(d);
    vec2 dir = r > 0.001 ? d / r : vec2(0.0);
    float shift = 0.0, crest = 0.0;
    if (r < uFront) {
        float phase = (r - uFront) / uWave;
        float body = exp(phase * 0.55) * smoothstep(0.0, uWave * 0.6, r);
        shift = uAmp * sin(phase * 6.2831853) * body;
        crest = body * smoothstep(0.55, 1.0, cos(phase * 6.2831853));
    }
    vec4 color = texture2D(uSampler, clamp(vTextureCoord - dir * shift * inputSize.zw, inputClamp.xy, inputClamp.zw));
    color.rgb += vec3(0.1, 0.85, 0.8) * crest * uGlow * color.a;
    gl_FragColor = color;
}`;

// ==========================================
// ГЕОМЕТРИЯ РАЗРЫВА
// ==========================================

/**
 * Ломаная молнии от a к b: середина каждого отрезка смещается поперёк, рекурсивно. decay < 1
 * гасит мелкие изломы: крупные остаются, линия не рябит
 */
function bolt(a, b, depth, rough, rnd, decay = 1) {
    if (depth <= 0) return [a, b];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const off = (rnd() - 0.5) * rough * len;
    const mid = { x: (a.x + b.x) / 2 - dy / len * off, y: (a.y + b.y) / 2 + dx / len * off };
    return [...bolt(a, mid, depth - 1, rough * decay, rnd, decay).slice(0, -1), ...bolt(mid, b, depth - 1, rough * decay, rnd, decay)];
}

/**
 * Шов и рваные края разрыва в долях высоты шва (y от −0,5 до 0,5). Края у каждой стороны свои:
 * зубцы ткани разной глубины. Ответвления — молнии с отростками, у каждого своя задержка роста.
 */
function tearShape(rnd) {
    const seam = bolt({ x: 0, y: -0.5 }, { x: 0, y: 0.5 }, 6, 0.45, rnd, 0.6);
    // Рваный край: плавная волна ширины и редкие глубокие зазубрины
    const teeth = () => {
        const raw = seam.map(() => 0.8 + rnd() * 0.4);
        const smooth = raw.map((v, i) => (raw[Math.max(0, i - 1)] + v * 2 + raw[Math.min(raw.length - 1, i + 1)]) / 4);
        return smooth.map(v => v * (rnd() < 0.1 ? 0.75 : rnd() < 0.08 ? 1.15 : 1));
    };
    const branches = [];
    for (let i = 0; i < 9; i++) {
        const at = Math.floor(6 + rnd() * (seam.length - 12));
        const side = i % 2 ? 1 : -1;
        const angle = side > 0 ? (rnd() - 0.5) * 1.3 : Math.PI + (rnd() - 0.5) * 1.3;
        const len = 0.07 + rnd() * 0.16;
        const root = seam[at];
        const tip = { x: root.x + Math.cos(angle) * len, y: root.y + Math.sin(angle) * len * 0.8 };
        const main = bolt({ x: 0, y: 0 }, { x: tip.x - root.x, y: tip.y - root.y }, 4, 0.55, rnd);
        const forks = rnd() < 0.7 ? [main[Math.floor(main.length * (0.35 + rnd() * 0.3))]].map(f => {
            const a = angle + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.5), l = len * (0.35 + rnd() * 0.3);
            return bolt(f, { x: f.x + Math.cos(a) * l, y: f.y + Math.sin(a) * l * 0.8 }, 3, 0.6, rnd);
        }) : [];
        branches.push({ at, side, lines: [main, ...forks], delay: rnd() * 0.45 });
    }
    // Клочья ткани: где на кромке и куда полетят
    const shards = Array.from({ length: 18 }, () => ({
        at: Math.floor(4 + rnd() * (seam.length - 8)), side: rnd() < 0.5 ? -1 : 1,
        speed: 0.25 + rnd() * 0.5, lift: (rnd() - 0.6) * 0.3, spin: (rnd() - 0.5) * 9, size: 0.008 + rnd() * 0.016,
        delay: rnd() * 0.5, form: [rnd(), rnd(), rnd()]
    }));
    return { seam, left: teeth(), right: teeth(), branches, shards };
}

const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

// Клуб светящегося тумана — мягкое пятно, нарисованное один раз
let puff = null;
function puffSprite() {
    if (puff) return puff;
    puff = document.createElement('canvas');
    puff.width = puff.height = 128;
    const g = puff.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(90, 230, 220, 0.32)');
    grad.addColorStop(0.4, 'rgba(30, 140, 135, 0.16)');
    grad.addColorStop(1, 'rgba(0, 50, 48, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return puff;
}

/** Катсцена прорыва. @returns {Promise<boolean>} false — на этой сцене не показана */
export async function playBreach({ sceneId, point }) {
    if (playing || !canvas?.ready || canvas.scene?.id !== sceneId || !point) return false;
    playing = true;
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const slow = Math.max(1, Number(game.settings.get(MODULE_ID, 'impactSlow')) || 1);
    const art = await loadArt();
    // Окна Foundry сворачиваются на время катсцены
    const restoreWindows = stowWindows();
    const cam = stageCamera();
    const bars = letterbox(0.1);
    const { ctx, W, H, remove } = overlay();
    const shake = shaker(22);
    const rnd = seeded(Math.round(Math.abs(point.x * 31 + point.y * 17)) % 2147483646 + 1);
    const shape = tearShape(rnd);
    const sprite = puffSprite();
    const tilt = -0.12;
    const sF = T.focus, sS = sF + T.seam, sT = sS + T.tear, sB = sT + T.burst, end = sB + T.close;
    const cued = new Set();
    const once = (name, t, at, options) => { if (t >= at && !cued.has(name)) { cued.add(name); cue(name, options); } };
    // Туман и искры живут в координатах разрыва: камера едет — они вместе с ним
    const fog = [], sparks = [];
    let lastT = 0, fogDebt = 0, sparkDebt = 0;

    return new Promise(resolve => {
        let ripple = null;
        const finish = () => {
            if (!playing) return;
            clearTimeout(watchdog);
            ripple?.remove();
            restoreWindows();
            const risen = canvas.tokens?.placeables?.find(tk => tk.document?.flags?.[MODULE_ID]?.breach);
            if (risen) { showToken(risen, 1); revealed.add(risen.id); }
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
                const inK = easeOut(clamp01(t / T.focus)), outK = smooth(clamp01((t - sB - 350) / (T.close - 350)));
                const k = inK * (1 - outK);
                const sh = shake.offset(t, 420);
                cam?.place({ k, scale: cam.saved.sx * ZOOM, center: point, rot: -0.03 * k, dx: sh.x, dy: sh.y });
                bars.show(k);

                // Камень в воду: от точки схлопывания по сцене бегут кольца
                if (t >= sB + SNAP && globalThis.PIXI) {
                    ripple ??= stageFilter(new PIXI.Filter(undefined, RIPPLE_SHADER, { uCenter: [0, 0], uFront: 0, uWave: 1, uAmp: 0, uGlow: 0 }));
                    const age = clamp01((t - sB - SNAP) / (T.close - SNAP));
                    const c = cam ? cam.screenOf(point) : { x: W / 2, y: H / 2 };
                    const w = W / devicePixelRatio, h = H / devicePixelRatio;
                    const u = ripple.filter.uniforms;
                    u.uCenter = [c.x / devicePixelRatio, c.y / devicePixelRatio];
                    u.uFront = Math.hypot(w, h) * 0.75 * easeOut(age);
                    u.uWave = h * 0.075;
                    u.uAmp = (calm ? 5 : 16) * (1 - age) ** 1.4;
                    u.uGlow = (calm ? 0.15 : 0.45) * (1 - age) ** 1.2;
                }

                // Токен Пожирателя проявляется из тумана, когда разрыв схлопнулся
                const risen = canvas.tokens?.placeables?.find(tk => tk.document?.flags?.[MODULE_ID]?.breach);
                if (risen) {
                    const rise = smooth(clamp01((t - sB - SNAP * 0.5) / 700));
                    showToken(risen, rise);
                    if (rise >= 1) revealed.add(risen.id);
                }

                simulate(t, Math.max(0, Math.min(50, t - lastT)) / 1000);
                lastT = t;
                draw(t, k);
            } catch (error) {
                console.error(`${MODULE_ID} | прорыв`, error);
                return finish();
            }
            requestAnimationFrame(frame);
        };

        // Раскрытие разрыва 0…1: растёт до удара, после — схлопывается
        const openAt = t => t < sS ? 0 : t < sT ? easeIn(clamp01((t - sS) / T.tear)) : t < sB ? 1 : 1 - easeIn(clamp01((t - sB) / SNAP));
        const len = H * SEAM;
        // Полуширина разрыва в точке шва s (−0,5…0,5), пиксели
        const halfWidth = (s, open, grow) => GAP * H * 0.8 * open * Math.pow(Math.max(0, Math.cos(s * Math.PI)), 0.8) * (0.5 + 0.5 * Math.min(1, grow * 1.2));

        // Туман и искры: рождаются в разрыве, вылетают в стороны и вверх
        const simulate = (t, dt) => {
            const open = openAt(t);
            const burst = t >= sT && !cued.has('burstFx');
            const emitting = t >= sS && t < sB + SNAP;
            const shut = t >= sB + SNAP && !cued.has('shutFx');
            if (shut) cued.add('shutFx');
            if (burst) cued.add('burstFx');
            const spawnFog = n => {
                for (let i = 0; i < n && fog.length < 90; i++) {
                    const side = rnd() < 0.5 ? -1 : 1, s = (rnd() - 0.5) * 0.8;
                    fog.push({ x: side * rnd() * GAP * H * 0.3 * Math.max(open, 0.3), y: s * len, vx: side * (0.05 + rnd() * 0.12) * H, vy: (-0.04 - rnd() * 0.06) * H,
                        size: (0.12 + rnd() * 0.12) * H, grow: (0.2 + rnd() * 0.2) * H, age: 0, life: 1.3 + rnd() * 1.3, spin: rnd() * 6 });
                }
            };
            const spawnSparks = (n, power = 1) => {
                for (let i = 0; i < n && sparks.length < 320; i++) {
                    const side = rnd() < 0.5 ? -1 : 1, s = (rnd() - 0.5) * 0.9, a = (side > 0 ? 0 : Math.PI) + (rnd() - 0.5) * 2.2;
                    const v = (0.15 + rnd() * 0.45) * H * power;
                    sparks.push({ x: side * halfWidth(s, Math.max(open, 0.2), 1) * rnd(), y: s * len, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.1 * H,
                        age: 0, life: 0.6 + rnd() * 1.1, size: 1.5 + rnd() * 2.5, twinkle: rnd() * 20 });
                }
            };
            if (burst) { spawnFog(calm ? 12 : 26); spawnSparks(calm ? 50 : 160, 1.6); }
            // Схлопнулся: брызги искр кольцом из точки, как всплеск
            if (shut) for (let i = 0; i < (calm ? 24 : 70) && sparks.length < 360; i++) {
                const a = rnd() * Math.PI * 2, v = (0.35 + rnd() * 0.5) * H;
                sparks.push({ x: 0, y: 0, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7, age: 0, life: 0.5 + rnd() * 0.7, size: 1.5 + rnd() * 2, twinkle: rnd() * 20 });
            }
            if (emitting) {
                fogDebt += dt * 22 * Math.max(0.25, open);
                sparkDebt += dt * (t < sT ? 70 : 35) * Math.max(0.3, open);
                const nf = Math.floor(fogDebt), ns = Math.floor(sparkDebt);
                fogDebt -= nf; sparkDebt -= ns;
                spawnFog(nf); spawnSparks(ns);
            } else if (t >= sF && t < sS) {
                // Пока шов растёт — редкие искры из трещины
                sparkDebt += dt * 25;
                const ns = Math.floor(sparkDebt);
                sparkDebt -= ns;
                spawnSparks(ns, 0.6);
            }
            for (const f of fog) { f.age += dt; f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 1 - dt * 0.6; f.vy *= 1 - dt * 0.4; }
            for (const p of sparks) { p.age += dt; p.px = p.x; p.py = p.y; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 1.8; p.vy = p.vy * (1 - dt * 1.8) - H * 0.12 * dt; }
            for (const list of [fog, sparks]) for (let i = list.length - 1; i >= 0; i--) if (list[i].age >= list[i].life) list.splice(i, 1);
        };

        // Кадр: затемнение, туман, разрыв с Пожирателем, кромка, ответвления, клочья, искры, вспышка
        const draw = (t, k) => {
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = `rgba(0, 12, 12, ${0.45 * k})`;
            ctx.fillRect(0, 0, W, H);
            const c = cam ? cam.screenOf(point) : { x: W / 2, y: H / 2 };
            const grow = easeOut(clamp01((t - sF) / T.seam));
            const open = openAt(t);
            const fade = 1 - smooth(clamp01((t - sB - SNAP) / 450));
            const flicker = 0.75 + 0.25 * Math.sin(t * 0.05) * Math.sin(t * 0.017);
            const dpr = devicePixelRatio;

            ctx.save();
            ctx.translate(c.x, c.y);
            ctx.rotate(tilt);

            // Туман и искры гаснут к концу катсцены, а не пропадают разом
            const linger = 1 - smooth(clamp01((t - end + 650) / 650));
            // Светящийся туман — под разрывом и вокруг
            ctx.globalCompositeOperation = 'lighter';
            for (const f of fog) {
                const a = Math.sin(Math.PI * clamp01(f.age / f.life)) * 0.45 * linger;
                const size = f.size + f.grow * f.age;
                ctx.globalAlpha = a;
                ctx.drawImage(sprite, f.x - size / 2, f.y - size / 2, size, size);
            }
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';

            if (grow > 0 && fade > 0) {
                const visible = shape.seam.map((p, i) => ({ ...p, i })).filter(p => Math.abs(p.y) <= grow / 2 + 1e-6);
                const at = p => ({ x: p.x * len, y: p.y * len });
                const left = visible.map(p => ({ x: p.x * len - halfWidth(p.y, open, grow) * shape.left[p.i], y: p.y * len }));
                const right = visible.map(p => ({ x: p.x * len + halfWidth(p.y, open, grow) * shape.right[p.i], y: p.y * len }));
                const outline = () => {
                    ctx.beginPath();
                    left.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
                    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
                    ctx.closePath();
                };
                const path = points => {
                    ctx.beginPath();
                    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
                };

                // Внутри — тьма и Пожиратель, проступающий из глубины
                if (open > 0.01) {
                    ctx.save();
                    outline();
                    ctx.clip();
                    ctx.fillStyle = '#010606';
                    ctx.fillRect(-len, -len, len * 2, len * 2);
                    if (art) {
                        ctx.save();
                        ctx.rotate(-tilt);
                        const size = H * 0.95, lift = (1 - open) * H * 0.06;
                        ctx.globalAlpha = smooth(clamp01((t - sS - T.tear * 0.25) / (T.tear * 0.6))) * fade;
                        ctx.drawImage(art, -size * FACE.x, -size * FACE.y + lift, size, size);
                        ctx.globalCompositeOperation = 'color';
                        ctx.fillStyle = rgba(DEEP, 0.55);
                        ctx.fillRect(-size, -size, size * 2, size * 2);
                        ctx.restore();
                    }
                    // Свет от рваных краёв внутрь
                    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, GAP * H * 0.9);
                    glow.addColorStop(0, 'rgba(0, 0, 0, 0)');
                    glow.addColorStop(1, rgba(TEAL, 0.4 * open));
                    ctx.fillStyle = glow;
                    ctx.fillRect(-len, -len, len * 2, len * 2);
                    ctx.restore();
                }

                ctx.globalCompositeOperation = 'lighter';
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                // Кромка: от широкого бледного свечения к тонкой белой сердцевине
                const edges = open > 0.01 ? [left, right] : [visible.map(at)];
                for (const [w, a, col] of [[30, 0.05, TEAL], [14, 0.12, TEAL], [6, 0.35, TEAL], [2.2, 0.95, [210, 255, 252]]]) {
                    ctx.strokeStyle = rgba(col, a * flicker * fade);
                    ctx.lineWidth = w * dpr;
                    for (const edge of edges) { path(edge); ctx.stroke(); }
                }
                // Разряды ползут по кромке
                for (const [n, edge] of edges.entries()) {
                    for (let j = 0; j < 5; j++) {
                        const u = ((t * 0.00045 * (1 + j * 0.3) + j * 0.21 + n * 0.5) % 1) * (edge.length - 1);
                        const i = Math.floor(u), f = u - i, a = edge[i], b = edge[Math.min(edge.length - 1, i + 1)];
                        if (!a || !b) continue;
                        const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
                        ctx.fillStyle = rgba([220, 255, 252], 0.9 * fade);
                        ctx.beginPath();
                        ctx.arc(x, y, (2 + 1.5 * Math.sin(t * 0.03 + j)) * dpr, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }

                // Ответвления-молнии: растут от кромки с задержкой, тоньше к концу
                for (const b of shape.branches) {
                    const root = shape.seam[b.at];
                    if (Math.abs(root.y) > grow / 2) continue;
                    const g = clamp01((grow - 0.25 - b.delay) / 0.45) * (1 - open * 0.5);
                    if (g <= 0) continue;
                    const ox = root.x * len + b.side * halfWidth(root.y, open, grow) * (b.side > 0 ? shape.right[b.at] : shape.left[b.at]), oy = root.y * len;
                    for (const [li, line] of b.lines.entries()) {
                        const n = Math.max(2, Math.ceil(line.length * g));
                        const pts = line.slice(0, n).map(p => ({ x: ox + p.x * len, y: oy + p.y * len }));
                        for (const [w, a] of [[8, 0.08], [3, 0.3], [1.2, 0.9]]) {
                            ctx.strokeStyle = rgba(w > 2 ? TEAL : [210, 255, 252], a * fade * flicker);
                            ctx.lineWidth = w * dpr * (li ? 0.6 : 1);
                            path(pts);
                            ctx.stroke();
                        }
                    }
                }
                ctx.globalCompositeOperation = 'source-over';

                // Клочья ткани отрываются от краёв, когда разрыв раскрывается
                for (const sh of shape.shards) {
                    const life = clamp01((open - sh.delay) / 0.6);
                    if (life <= 0 || life >= 1 || !visible.some(p => p.i === sh.at)) continue;
                    const root = shape.seam[sh.at];
                    const x = root.x * len + sh.side * (halfWidth(root.y, open, grow) + sh.speed * life * H * 0.25), y = root.y * len + sh.lift * life * H * 0.25;
                    const r = sh.size * H;
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(sh.spin * life);
                    ctx.globalAlpha = (1 - life) * fade;
                    ctx.beginPath();
                    ctx.moveTo(-r, -r * sh.form[0]);
                    ctx.lineTo(r * sh.form[1], -r);
                    ctx.lineTo(r * sh.form[2], r);
                    ctx.closePath();
                    ctx.fillStyle = '#071615';
                    ctx.fill();
                    ctx.strokeStyle = rgba(TEAL, 0.9);
                    ctx.lineWidth = 1.2 * dpr;
                    ctx.stroke();
                    ctx.restore();
                }
            }

            // Искры: короткие светящиеся черточки, мерцают
            ctx.globalCompositeOperation = 'lighter';
            ctx.lineCap = 'round';
            for (const p of sparks) {
                const life = 1 - p.age / p.life;
                const a = life * (0.6 + 0.4 * Math.sin(p.twinkle + t * 0.04)) * linger;
                // Хвост — по скорости: быстрые искры тянут длинный след
                const tx = p.x - p.vx * 0.035, ty = p.y - p.vy * 0.035;
                for (const [w, k, col] of [[3.2, 0.25, TEAL], [1, 1, [215, 255, 252]]]) {
                    ctx.strokeStyle = rgba(col, a * k);
                    ctx.lineWidth = p.size * w * dpr * 0.6;
                    ctx.beginPath();
                    ctx.moveTo(tx, ty);
                    ctx.lineTo(p.x, p.y);
                    ctx.stroke();
                }
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

            // Схлопнулся: точка света на месте разрыва гаснет
            const spark = t >= sB + SNAP ? 1 - clamp01((t - sB - SNAP) / 350) : 0;
            if (spark > 0) {
                const c = cam ? cam.screenOf(point) : { x: W / 2, y: H / 2 }, r = H * 0.12 * (0.4 + 0.6 * spark);
                const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
                g.addColorStop(0, rgba([220, 255, 252], 0.95 * spark));
                g.addColorStop(0.3, rgba(TEAL, 0.5 * spark));
                g.addColorStop(1, rgba(TEAL, 0));
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = g;
                ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
                ctx.globalCompositeOperation = 'source-over';
            }

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
