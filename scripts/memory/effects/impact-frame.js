/**
 * Gacha Roguelike dnd5e — Импакт-кадр навыка
 *
 * Навык с полем impact (Мегумин) при использовании на долю секунды подменяет экран у всех игроков
 * двумя кадрами удара из снимка сцены, как её видит каждый игрок:
 *  1. светлое — чёрное, пробитое белыми штрихами от точки удара; остальное — белое в чёрных штрихах;
 *  2. инверсия: что было чёрным — сплошь белое, что было белым — чёрное с проблесками белых штрихов.
 * Границы светлого размазаны к точке удара, как в рисованных импакт-кадрах. Без сцены кадры
 * собираются из арта навыка. «Без вспышек» оставляет только первый кадр — каждый игрок у себя.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket } from "../../core/socket.js";

// Хронометраж, мс. Рисунок импакт-кадра в аниме держится 1–3 кадра при 24 к/с (≈42–125 мс):
// первый кадр — 2 кадра анимации, второй — 3, затем резкий возврат к сцене
const T = { first: 84, end: 210, calm: 170 };
// Ширина снимка для обработки: больше не нужно — кадр держится доли секунды
const SHOT_WIDTH = 800;
// Секторы штрихов по кругу: в каждом секторе не больше одного штриха
const BINS = 720;

export function registerImpactSettings() {
    game.settings.register(MODULE_ID, 'impactFrames', {
        name: 'Импакт-кадры навыков',
        hint: 'Стоп-кадр во весь экран при использовании особых навыков.',
        scope: 'client',
        config: true,
        type: Boolean,
        default: true
    });
    game.settings.register(MODULE_ID, 'impactCalm', {
        name: 'Импакт-кадры без вспышек',
        hint: 'Без белой вспышки и инверсии кадра.',
        scope: 'client',
        config: true,
        type: Boolean,
        default: false
    });
    game.settings.register(MODULE_ID, 'impactSound', {
        name: 'Звук импакт-кадра',
        hint: 'Путь к звуковому файлу, например modules/gachadnd/assets/sounds/explosion.ogg. Пусто — взрыв синтезируется в браузере.',
        scope: 'world',
        config: true,
        type: String,
        default: ''
    });
}

// Навык использован: кадр у себя и у остальных. Хук срабатывает только у использовавшего,
// шаблон области к этому моменту уже размещён (dnd5e создаёт его до хука)
Hooks.on('dnd5e.postUseActivity', (activity, usageConfig, results) => {
    const item = activity?.item;
    const impact = item?.flags?.[MODULE_ID]?.impact;
    if (!impact) return;
    // drawPreview возвращает массив созданных шаблонов, поэтому results.templates бывает вложенным
    const template = [results?.templates].flat(2).find(t => Number.isFinite(t?.x));
    const token = item.actor?.getActiveTokens?.()[0];
    const point = template ? { x: template.x, y: template.y } : token?.center ? { x: token.center.x, y: token.center.y } : null;
    const data = { art: impact.art || item.img, sceneId: canvas?.scene?.id ?? null, point };
    emit('impactFrame', data);
    playImpact(data);
});
onSocket('impactFrame', message => playImpact(message));

// ==========================================
// КАДРЫ УДАРА
// ==========================================

const cache = new Map();

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

function seeded(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Штрихи по секторам: в секторе — мазок от точки удара наружу, [от, до] по доле радиуса,
// своей толщины и смещения; мазок сужается к обоим концам, как след кисти
function streaks(seed, density, minLength, maxWidth, start = 0) {
    const rnd = seeded(seed);
    const from = new Float32Array(BINS), to = new Float32Array(BINS);
    const width = new Float32Array(BINS), offset = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
        if (rnd() > density) { from[b] = 2; to[b] = 0; continue; }
        from[b] = start + rnd() * (0.7 - start * 0.5);
        to[b] = from[b] + minLength + rnd() * 0.8;
        width[b] = maxWidth * (0.3 + rnd() * 0.7);
        offset[b] = 0.25 + rnd() * 0.5;
    }
    return { from, to, width, offset };
}
// Попадает ли точка (сектор b, доля сектора frac, радиус r) в мазок
function inStroke(set, b, frac, r) {
    if (r < set.from[b] || r > set.to[b]) return false;
    const k = (r - set.from[b]) / (set.to[b] - set.from[b]);
    return Math.abs(frac - set.offset[b]) < set.width[b] * Math.sin(Math.PI * k) ** 0.6;
}

/**
 * Два кадра удара из изображения.
 * @param {CanvasImageSource & {width: number, height: number}} img
 * @param {number} fx, fy  Точка удара — доли ширины и высоты.
 * @returns {{first: HTMLCanvasElement, second: HTMLCanvasElement}}
 */
function impactPair(img, fx, fy) {
    const w = Math.min(SHOT_WIDTH, img.width), h = Math.round(w * img.height / img.width);
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    const sx = src.getContext('2d', { willReadFrequently: true });
    sx.drawImage(img, 0, 0, w, h);
    const d = sx.getImageData(0, 0, w, h).data;

    // Яркость и порог Оцу: светлое отделяется от тёмного на любой карте
    const lum = new Uint8Array(w * h), hist = new Float64Array(256);
    for (let p = 0, i = 0; p < lum.length; p++, i += 4) hist[lum[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let best = 0, threshold = 128, wB = 0, sumB = 0;
    for (let v = 0; v < 256; v++) {
        wB += hist[v]; if (!wB) continue;
        const wF = lum.length - wB; if (!wF) break;
        sumB += v * hist[v];
        const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
        if (between > best) { best = between; threshold = v; }
    }
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < mask.length; p++) mask[p] = lum[p] > threshold ? 1 : 0;

    // Рваные границы: случайный сдвиг порога по секторам, к точке удара он сходит на нет
    const rnd = seeded(97);
    const jag = Float32Array.from({ length: BINS }, () => rnd() - 0.5);
    const white1 = streaks(11, 0.45, 0.15, 0.22);  // белые штрихи в чёрном первого кадра
    const black1 = streaks(23, 0.14, 0.12, 0.35, 0.45);  // редкие чёрные мазки у краёв белого первого кадра
    const white2 = streaks(37, 0.3, 0.1, 0.16);    // проблески во втором кадре

    const out1 = sx.createImageData(w, h), out2 = sx.createImageData(w, h);
    const o1 = out1.data, o2 = out2.data;
    const cx = fx * w, cy = fy * h;
    const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const SAMPLES = 12, SMEAR = 0.24;
    for (let y = 0, p = 0; y < h; y++) {
        for (let x = 0; x < w; x++, p++) {
            const dx = x - cx, dy = y - cy;
            const r = Math.hypot(dx, dy) / maxR;
            const a = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI) * BINS;
            const b = Math.min(BINS - 1, a | 0), frac = a - b;
            // Размазывание к точке удара: среднее маски вдоль луча
            let acc = 0;
            for (let k = 0; k < SAMPLES; k++) {
                const f = 1 - SMEAR * k / SAMPLES;
                acc += mask[((cy + dy * f) | 0) * w + ((cx + dx * f) | 0)];
            }
            const light = acc / SAMPLES + jag[b] * Math.min(1, r * 3) * 0.7 > 0.5;
            const grain = Math.random() < 0.02;
            // Кадр 1: светлое — чёрное с белыми штрихами, тёмное — белое с чёрными штрихами
            const v1 = light ? (inStroke(white1, b, frac, r) || grain ? 255 : 0) : (inStroke(black1, b, frac, r) ? 0 : 255);
            // Кадр 2: светлое — белое, тёмное — чёрное с проблесками
            const v2 = light ? 255 : (inStroke(white2, b, frac, r) || grain ? 255 : 0);
            const i = p * 4;
            o1[i] = o1[i + 1] = o1[i + 2] = v1; o1[i + 3] = 255;
            o2[i] = o2[i + 1] = o2[i + 2] = v2; o2[i + 3] = 255;
        }
    }
    const toCanvas = image => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').putImageData(image, 0, 0);
        return c;
    };
    return { first: toCanvas(out1), second: toCanvas(out2) };
}

async function artPair(src) {
    if (!cache.has(src)) cache.set(src, loadImage(src).then(img => impactPair(img, 0.5, 0.5)));
    return cache.get(src);
}

/**
 * Снимок сцены, как её видит этот игрок. Холст WebGL не хранит кадр после показа,
 * поэтому сцена перерисовывается и копируется в той же задаче, до вывода на экран.
 * @returns {HTMLCanvasElement|null}  null — сцены нет, она другая или снимок пуст.
 */
function captureScene(sceneId) {
    const app = canvas?.app;
    const view = app?.view ?? app?.canvas;
    if (!canvas?.ready || !view || (sceneId && canvas.scene?.id !== sceneId)) return null;
    try {
        app.renderer.render(app.stage);
        // Снимок сразу уменьшается: дальнейшая обработка идёт по малому холсту
        const shot = document.createElement('canvas');
        shot.width = Math.min(SHOT_WIDTH, view.width);
        shot.height = Math.round(shot.width * view.height / view.width);
        const x = shot.getContext('2d', { willReadFrequently: true });
        x.drawImage(view, 0, 0, shot.width, shot.height);
        // Пустой буфер: проверка по сетке точек
        const probe = x.getImageData(0, 0, shot.width, shot.height).data;
        const step = Math.max(4, Math.floor(probe.length / 4 / 400)) * 4;
        let filled = 0;
        for (let i = 3; i < probe.length; i += step) if (probe[i] > 0) filled++;
        return filled > 20 ? shot : null;
    } catch (error) {
        console.warn(`${MODULE_ID} | снимок сцены для импакт-кадра`, error);
        return null;
    }
}

// Точка сцены → доля экрана; за краем экрана — прижата к нему, чтобы удар оставался в кадре
function screenFocus(point) {
    const view = canvas?.app?.view ?? canvas?.app?.canvas;
    if (!point || !view) return { fx: 0.5, fy: 0.48 };
    const p = canvas.stage.worldTransform.apply({ x: point.x, y: point.y });
    const rect = view.getBoundingClientRect();
    const clamp = v => Math.min(0.85, Math.max(0.15, v));
    return { fx: clamp(p.x / rect.width), fy: clamp(p.y / rect.height) };
}

// ==========================================
// ЗВУК
// ==========================================

let audio = null;

// Взрыв без файла: низкий удар с падением тона и шумовой хвост под закрывающимся фильтром
function synthExplosion(volume) {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    const out = audio.createGain();
    out.gain.value = volume;
    out.connect(audio.destination);

    const thump = audio.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(110, t);
    thump.frequency.exponentialRampToValueAtTime(32, t + 0.6);
    const thumpGain = audio.createGain();
    thumpGain.gain.setValueAtTime(1.2, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    thump.connect(thumpGain).connect(out);
    thump.start(t); thump.stop(t + 1);

    const length = Math.round(audio.sampleRate * 2.2);
    const buffer = audio.createBuffer(1, length, audio.sampleRate);
    const ch = buffer.getChannelData(0);
    // Коричневый шум: рокот вместо шипения
    for (let i = 0, last = 0; i < length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        ch[i] = last * 3.5;
    }
    const noise = audio.createBufferSource();
    noise.buffer = buffer;
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + 2);
    const noiseGain = audio.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(1.6, t + 0.02);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
    noise.connect(filter).connect(noiseGain).connect(out);
    noise.start(t);
}

function playSound() {
    if (!game.settings.get(MODULE_ID, 'soundsEnabled')) return;
    const volume = game.settings.get(MODULE_ID, 'soundsVolume');
    const src = game.settings.get(MODULE_ID, 'impactSound');
    if (src) {
        const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
        return helper?.play({ src, volume, autoplay: true, loop: false }, false);
    }
    try { synthExplosion(volume); } catch (error) { console.warn(`${MODULE_ID} | звук импакт-кадра`, error); }
}

// ==========================================
// ПОКАЗ
// ==========================================

let playing = false;

export async function playImpact({ art, sceneId, point }) {
    if (playing || !game.settings.get(MODULE_ID, 'impactFrames')) return;
    playing = true;
    let pair, focus = { fx: 0.5, fy: 0.5 };
    const shot = captureScene(sceneId);
    console.info(`${MODULE_ID} | импакт-кадр: ${shot ? `снимок сцены ${shot.width}×${shot.height}` : 'арт навыка'}`);
    try {
        if (shot) {
            focus = screenFocus(point);
            pair = impactPair(shot, focus.fx, focus.fy);
        } else pair = await artPair(art);
    } catch (error) {
        playing = false;
        return console.warn(`${MODULE_ID} | импакт-кадр не собран`, error);
    }
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const cv = document.createElement('canvas');
    cv.className = 'gd-impact';
    cv.width = innerWidth; cv.height = innerHeight;
    document.body.append(cv);
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, cx = W * focus.fx, cy = H * focus.fy;
    playSound();

    // Кадр во весь экран; масштаб — вокруг точки удара, она остаётся на месте
    const cover = (src, zoom, ox, oy) => {
        const base = Math.max(W / src.width, H / src.height);
        const bx = (W - src.width * base) / 2, by = (H - src.height * base) / 2;
        ctx.drawImage(src, cx - (cx - bx) * zoom + ox, cy - (cy - by) * zoom + oy, src.width * base * zoom, src.height * base * zoom);
    };

    // Рывок: первый кадр сдвинут и чуть крупнее, второй встаёт на место
    const ox = (Math.random() - 0.5) * 24, oy = (Math.random() - 0.5) * 24;
    const t0 = performance.now();
    const finish = () => { cv.remove(); playing = false; };
    const tick = now => {
        try {
            const t = now - t0;
            if (t >= (calm ? T.calm : T.end)) return finish();
            if (calm || t < T.first) cover(pair.first, 1.05, ox, oy);
            else cover(pair.second, 1, 0, 0);
            requestAnimationFrame(tick);
        } catch (error) {
            finish();
            console.error(`${MODULE_ID} | импакт-кадр`, error);
        }
    };
    requestAnimationFrame(tick);
}
