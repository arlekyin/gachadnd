/**
 * Gacha Roguelike dnd5e — Импакт-кадр навыка
 *
 * Навык с полем impact (Мегумин) при использовании на секунду с половиной закрывает экран у всех игроков
 * стоп-кадром в манга-стиле: белая вспышка, инвертированный кадр, три тона с растром, линии скорости,
 * выкрик и имя навыка, распад полосами. Кадр собирается из арта навыка прямо в браузере.
 * «Без вспышек» убирает белую вспышку и инверсию — каждый игрок у себя.
 */

import { MODULE_ID } from "./constants.js";
import { emit, onSocket } from "./socket.js";

const PALETTE = { dark: [8, 6, 10], mid: [214, 18, 46], light: [250, 246, 240] };
const DURATION = 1500;

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

// Навык использован: кадр у себя и у остальных. Хук срабатывает только у использовавшего
Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    const impact = item?.flags?.[MODULE_ID]?.impact;
    if (!impact) return;
    const data = { name: item.name, shout: impact.shout ?? '', art: impact.art || item.img };
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

// Оттенки серого → три тона (тёмный / алый / светлый) с растром, прямой или инвертированный вариант
function process(img, inverted) {
    const w = Math.min(900, img.width), h = Math.round(w * img.height / img.width);
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
    // Пороги по гистограмме: 38% и 72% яркости кадра — работает с любым артом
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    const total = d.length / 4;
    let acc = 0, t1 = 85, t2 = 170;
    for (let v = 0, found = false; v < 256; v++) {
        acc += hist[v];
        if (!found && acc > total * 0.38) { t1 = v; found = true; }
        if (acc > total * 0.72) { t2 = v; break; }
    }
    for (let i = 0; i < d.length; i += 4) {
        const px = (i / 4) % w, py = Math.floor(i / 4 / w);
        // Растровые точки в средних тонах: на границах тонов — манга-текстура
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] + Math.sin(px * 0.9) * Math.sin(py * 0.9) * 14;
        let tone = l < t1 ? 'dark' : l < t2 ? 'mid' : 'light';
        if (inverted) tone = tone === 'dark' ? 'light' : tone === 'light' ? 'dark' : 'mid';
        const [r, g, b] = PALETTE[tone];
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    x.putImageData(data, 0, 0);
    return c;
}

async function frames(src) {
    if (!cache.has(src)) {
        cache.set(src, loadImage(src).then(img => ({ normal: process(img, false), inverted: process(img, true) })));
    }
    return cache.get(src);
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

export async function playImpact({ name, shout, art }) {
    if (playing || !game.settings.get(MODULE_ID, 'impactFrames')) return;
    playing = true;
    let set;
    try { set = await frames(art); } catch (error) {
        playing = false;
        return console.warn(`${MODULE_ID} | арт импакт-кадра не загружен: ${art}`, error);
    }
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const cv = document.createElement('canvas');
    cv.className = 'gd-impact';
    const dpr = Math.min(devicePixelRatio, 1.5);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    document.body.append(cv);
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, cx = W / 2, cy = H * 0.48;
    playSound();

    const cover = (src, zoom, ox, oy) => {
        const s = Math.max(W / src.width, H / src.height) * zoom;
        const w = src.width * s, h = src.height * s;
        ctx.drawImage(src, (W - w) / 2 + ox, (H - h) / 2 + oy, w, h);
    };
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
        ctx.translate(cx, y); ctx.rotate(rot);
        ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.14; ctx.strokeStyle = stroke; ctx.strokeText(text, 0, 0);
        ctx.fillStyle = color; ctx.fillText(text, 0, 0);
        ctx.restore();
    };
    const rgb = tone => `rgb(${PALETTE[tone].join(',')})`;

    const t0 = performance.now();
    const tick = now => {
        const t = now - t0;
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, W, H);
        const shake = t < 520 ? (1 - t / 520) * 18 * dpr : 0;
        const ox = (Math.random() - 0.5) * shake, oy = (Math.random() - 0.5) * shake;
        if (t < 70 && !calm) {
            // 1. Белая вспышка
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
        } else if (t < 230 && !calm) {
            // 2. Инвертированный кадр: светлый фон, чёрные линии скорости, рывок масштаба
            cover(set.inverted, 1.18 - (t - 70) / 160 * 0.06, ox, oy);
            speedLines('rgba(8, 6, 10, 0.92)', 7, 90);
        } else if (t < 1050) {
            // 3. Основной кадр: три тона, светлые линии скорости, выкрик и имя
            const k = Math.min(1, Math.max(0, (t - 230) / 820));
            ctx.fillStyle = rgb('dark'); ctx.fillRect(0, 0, W, H);
            cover(set.normal, 1.1 + k * 0.05, ox, oy);
            // Сдвиг каналов: двойник арта чуть в стороне
            ctx.globalAlpha = 0.28 * (1 - k); ctx.globalCompositeOperation = 'lighter';
            cover(set.normal, 1.1 + k * 0.05, ox + 10 * dpr, oy);
            ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
            speedLines('rgba(250, 246, 240, 0.55)', 11 + Math.floor(t / 90), 70);
            // Полосы кинорамки
            ctx.fillStyle = rgb('dark'); ctx.fillRect(0, 0, W, H * 0.1); ctx.fillRect(0, H * 0.9, W, H * 0.1);
            const pop = Math.min(1, Math.max(0, (t - 230) / 120));
            title(shout, H * 0.16 * (1.25 - pop * 0.25), rgb('light'), rgb('mid'), -0.08, H * 0.3, pop);
            title(name, H * 0.06, rgb('mid'), rgb('dark'), -0.03, H * 0.8, Math.min(1, (t - 330) / 150));
        } else if (t < DURATION) {
            // 4. Распад: кадр разъезжается полосами и гаснет
            const k = (t - 1050) / (DURATION - 1050);
            ctx.globalAlpha = 1 - k;
            const bands = 12, bh = H / bands;
            for (let b = 0; b < bands; b++) {
                ctx.save(); ctx.beginPath(); ctx.rect(0, b * bh, W, bh + 1); ctx.clip();
                cover(set.normal, 1.15, (b % 2 ? 1 : -1) * k * W * 0.25, 0);
                ctx.restore();
            }
        } else {
            cv.remove();
            playing = false;
            return;
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}
