/**
 * Gacha Roguelike dnd5e — Импакт-кадр навыка
 *
 * Навык с полем impact (Мегумин) при использовании на секунду с половиной закрывает экран у всех игроков
 * стоп-кадром в манга-стиле: белая вспышка, инвертированный кадр, три тона с растром, линии скорости,
 * выкрик и имя навыка, распад на растровые точки от центра удара. Кадр — снимок сцены с токенами
 * у каждого игрока, удар — в точку шаблона области. Без сцены кадр собирается из арта навыка.
 * «Без вспышек» убирает белую вспышку и инверсию — каждый игрок у себя.
 */

import { MODULE_ID } from "./constants.js";
import { emit, onSocket } from "./socket.js";

const PALETTE = { dark: [8, 6, 10], mid: [214, 18, 46], light: [250, 246, 240] };
const DURATION = 1650;

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
    const data = { name: item.name, shout: impact.shout ?? '', art: impact.art || item.img, sceneId: canvas?.scene?.id ?? null, point };
    emit('impactFrame', data);
    playImpact(data);
});
onSocket('impactFrame', message => playImpact(message));

// ==========================================
// ОБРАБОТКА АРТА
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

// Прямой вариант — градиентная карта чёрный / алый / белый, инвертированный — негатив в цветах сцены
function process(img, inverted, maxWidth = 900) {
    const w = Math.min(maxWidth, img.width), h = Math.round(w * img.height / img.width);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, w, h);
    let data;
    try { data = x.getImageData(0, 0, w, h); } catch {
        // Арт с чужого сервера без CORS: пикселей не прочитать — тона через фильтры
        x.clearRect(0, 0, w, h);
        x.filter = `grayscale(1) contrast(4)${inverted ? ' invert(1)' : ''}`;
        x.drawImage(img, 0, 0, w, h);
        x.filter = 'none';
        x.globalCompositeOperation = 'multiply';
        x.fillStyle = `rgb(${PALETTE.mid.join(',')})`;
        x.fillRect(0, 0, w, h);
        x.globalCompositeOperation = 'source-over';
        return c;
    }
    const d = data.data;
    // Уровни по гистограмме яркости: 2% и 98% растягиваются на весь диапазон — работает с любой картой
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    const total = d.length / 4;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0, found = false; v < 256; v++) {
        acc += hist[v];
        if (!found && acc > total * 0.02) { lo = v; found = true; }
        if (acc > total * 0.98) { hi = v; break; }
    }
    const span = Math.max(24, hi - lo);
    const curve = n => { n = Math.min(1, Math.max(0, n)); return n * n * (3 - 2 * n); };
    const mix = (a, b, k) => a + (b - a) * k;
    for (let i = 0; i < d.length; i += 4) {
        if (inverted) {
            // Негатив сцены в её собственных цветах: токены, карта и зона узнаваемы, контраст усилен
            for (let c = 0; c < 3; c++) d[i + c] = 255 * curve((hi - d[i + c]) / span);
            continue;
        }
        // Градиентная карта: тени — чёрный, средние — алый, света — белый; лёгкий растр в полутонах
        const px = (i / 4) % w, py = Math.floor(i / 4 / w);
        // Без S-кривой: светлые токены и зона не выгорают в сплошной белый
        const n = Math.min(1, Math.max(0, (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - lo) / span)) * 0.92
            + Math.sin(px * 0.9) * Math.sin(py * 0.9) * 0.05;
        const [from, to, k] = n < 0.5 ? [PALETTE.dark, PALETTE.mid, n * 2] : [PALETTE.mid, PALETTE.light, (n - 0.5) * 2];
        const kk = Math.min(1, Math.max(0, k));
        d[i] = mix(from[0], to[0], kk); d[i + 1] = mix(from[1], to[1], kk); d[i + 2] = mix(from[2], to[2], kk);
    }
    x.putImageData(data, 0, 0);
    return c;
}

async function artFrames(src) {
    if (!cache.has(src)) {
        cache.set(src, loadImage(src).then(img => ({ normal: process(img, false), inverted: process(img, true) })));
    }
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
        const shot = document.createElement('canvas');
        shot.width = view.width; shot.height = view.height;
        const x = shot.getContext('2d', { willReadFrequently: true });
        x.drawImage(view, 0, 0);
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
// КАДР
// ==========================================

let playing = false;

export async function playImpact({ name, shout, art, sceneId, point }) {
    if (playing || !game.settings.get(MODULE_ID, 'impactFrames')) return;
    playing = true;
    let set, focus = { fx: 0.5, fy: 0.48 };
    const shot = captureScene(sceneId);
    console.info(`${MODULE_ID} | импакт-кадр: ${shot ? `снимок сцены ${shot.width}×${shot.height}` : 'арт навыка'}`);
    if (shot) {
        set = { normal: process(shot, false, 1280), inverted: process(shot, true, 1280) };
        focus = screenFocus(point);
    } else {
        try { set = await artFrames(art); } catch (error) {
            playing = false;
            return console.warn(`${MODULE_ID} | арт импакт-кадра не загружен: ${art}`, error);
        }
    }
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const cv = document.createElement('canvas');
    cv.className = 'gd-impact';
    const dpr = Math.min(devicePixelRatio, 1.5);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    document.body.append(cv);
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, cx = W * focus.fx, cy = H * focus.fy;
    playSound();

    // Кадр во весь экран; масштаб — вокруг точки удара, она остаётся на месте
    const cover = (src, zoom, ox, oy) => {
        const s = Math.max(W / src.width, H / src.height) * zoom;
        const w = src.width * s, h = src.height * s;
        const base = Math.max(W / src.width, H / src.height);
        const bx = (W - src.width * base) / 2, by = (H - src.height * base) / 2;
        ctx.drawImage(src, cx - (cx - bx) * zoom + ox, cy - (cy - by) * zoom + oy, w, h);
    };
    const still = document.createElement('canvas');
    still.width = W; still.height = H;
    let stillReady = false;
    // Линии скорости: клинья от точки удара к краям экрана
    const speedLines = (color, seed, count) => {
        let s = seed;
        const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
        const R = Math.hypot(W, H);
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
            const a = rnd() * Math.PI * 2, spread = 0.004 + rnd() * 0.018, inner = R * (0.18 + rnd() * 0.22);
            ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
            ctx.lineTo(cx + Math.cos(a - spread) * R, cy + Math.sin(a - spread) * R);
            ctx.lineTo(cx + Math.cos(a + spread) * R, cy + Math.sin(a + spread) * R);
            ctx.closePath();
        }
        ctx.fill();
    };
    const title = (text, size, color, stroke, rot, y, alpha) => {
        if (!text || alpha <= 0) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(W / 2, y); ctx.rotate(rot);
        ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.14; ctx.strokeStyle = stroke; ctx.strokeText(text, 0, 0);
        ctx.fillStyle = color; ctx.fillText(text, 0, 0);
        ctx.restore();
    };
    const rgb = tone => `rgb(${PALETTE[tone].join(',')})`;

    const t0 = performance.now();
    const step = now => {
        const t = now - t0;
        // Последний показанный кадр основной фазы — с выкриком и линиями — застывает и рассыпается
        if (t >= 1200 && !stillReady) { still.getContext('2d').drawImage(cv, 0, 0); stillReady = true; }
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, W, H);
        const shake = t < 600 ? (1 - t / 600) * 18 * dpr : 0;
        const ox = (Math.random() - 0.5) * shake, oy = (Math.random() - 0.5) * shake;
        if (t < 60 && !calm) {
            // 1. Белая вспышка
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
        } else if (t < 380 && !calm) {
            // 2. Негатив сцены: чёрные линии скорости по краям, рывок масштаба
            cover(set.inverted, 1.18 - (t - 60) / 320 * 0.06, ox, oy);
            speedLines('rgba(8, 6, 10, 0.8)', 7, 55);
        } else if (t < 1200) {
            // 3. Основной кадр: три тона, светлые линии скорости, выкрик и имя
            const k = Math.min(1, Math.max(0, (t - 380) / 820));
            ctx.fillStyle = rgb('dark'); ctx.fillRect(0, 0, W, H);
            cover(set.normal, 1.1 + k * 0.05, ox, oy);
            // Сдвиг каналов: двойник арта чуть в стороне
            ctx.globalAlpha = 0.28 * (1 - k); ctx.globalCompositeOperation = 'lighter';
            cover(set.normal, 1.1 + k * 0.05, ox + 10 * dpr, oy);
            ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
            speedLines('rgba(250, 246, 240, 0.55)', 11 + Math.floor(t / 90), 70);
            // Полосы кинорамки
            ctx.fillStyle = rgb('dark'); ctx.fillRect(0, 0, W, H * 0.1); ctx.fillRect(0, H * 0.9, W, H * 0.1);
            const pop = Math.min(1, Math.max(0, (t - 380) / 120));
            title(shout, H * 0.16 * (1.25 - pop * 0.25), rgb('light'), rgb('mid'), -0.08, H * 0.3, pop);
            title(name, H * 0.06, rgb('mid'), rgb('dark'), -0.03, H * 0.8, Math.min(1, (t - 480) / 150));
        } else if (t < DURATION) {
            // 4. Распад: кадр рассыпается на растровые точки, они сжимаются волной от точки удара
            const k = (t - 1200) / (DURATION - 1200);
            const cell = 18 * dpr, R = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
            ctx.beginPath();
            for (let row = 0, y = 0; y < H + cell; row++, y += cell * 0.87) {
                for (let x = row % 2 ? cell / 2 : 0; x < W + cell; x += cell) {
                    const local = Math.min(1, Math.max(0, k * 1.6 - Math.hypot(x - cx, y - cy) / R * 0.6));
                    const r = cell * 0.62 * (1 - local * local);
                    if (r < 0.4) continue;
                    ctx.moveTo(x + r, y);
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                }
            }
            ctx.fillStyle = '#000';
            ctx.fill();
            ctx.globalCompositeOperation = 'source-in';
            ctx.drawImage(still, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
        } else {
            return false;
        }
        return true;
    };
    // Ошибка в кадре не должна оставить холст поверх экрана
    const finish = () => { cv.remove(); playing = false; };
    const tick = now => {
        try {
            if (step(now)) requestAnimationFrame(tick);
            else finish();
        } catch (error) {
            finish();
            console.error(`${MODULE_ID} | импакт-кадр`, error);
        }
    };
    requestAnimationFrame(tick);
}
