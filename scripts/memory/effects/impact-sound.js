/**
 * Gacha Roguelike dnd5e — Звуки импакт-кадров
 *
 * Каждый момент удара — свой звук, синтезированный в браузере (Web Audio), без файлов.
 * Большие удары собраны из слоёв: атака (короткий треск) — тело (глухой удар с басом) — хвост
 * (гул, обломки). Если в настройке «Папка звуков импакт-кадров» указана папка, вместо синтеза
 * играет файл из неё с именем момента: approach.ogg, inhale.ogg, … (список — CUES).
 *
 * Синтез работает и в OfflineAudioContext — так звуки можно отрисовать в файл и послушать.
 */

/** Моменты и их назначение */
export const CUES = {
    approach: 'подъезд камеры: низкий нарастающий гул',
    inhale: 'вдох: всасывание воздуха с растущим тоном, обрывается перед касанием',
    lunge: 'рывок: короткий свист',
    contact: 'касание: треск, тяжёлый удар с басом, треск молний, звон в ушах',
    punch: 'удар кулака (1–4): короткий плотный удар, высота у каждого своя',
    punchFinal: 'пятый кулак: удар тяжелее и раскат',
    fly: 'полёт цели: удаляющийся свист с падающим тоном',
    land: 'приземление: удар о землю и осыпь',
    ok: 'реплика «Ок.»: тихий хлопок пузыря'
};

// ==========================================
// КИРПИЧИ СИНТЕЗА
// ==========================================

const noiseCache = new WeakMap();

// Белый шум на 3 секунды — общий для всех звуков контекста
function noiseBuffer(ctx) {
    if (!noiseCache.has(ctx)) {
        const length = Math.round(ctx.sampleRate * 3);
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const ch = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) ch[i] = Math.random() * 2 - 1;
        noiseCache.set(ctx, buffer);
    }
    return noiseCache.get(ctx);
}

// Огибающая громкости: точки [время от начала, уровень]; между ними — экспоненциально
function envelope(param, t0, points) {
    param.setValueAtTime(Math.max(0.0001, points[0][1]), t0 + points[0][0]);
    for (const [dt, v] of points.slice(1)) param.exponentialRampToValueAtTime(Math.max(0.0001, v), t0 + dt);
}

// Шум через фильтр с меняющейся частотой: свисты, всасывание, гул, треск
function noise(ctx, out, t0, { type = 'bandpass', freq = [1000, 1000], q = 1, gain = [[0, 0.0001], [0.01, 1], [0.3, 0.0001]], duration = 0.4, offset = Math.random() * 2 }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq[0], t0);
    filter.frequency.exponentialRampToValueAtTime(freq[1], t0 + duration);
    const g = ctx.createGain();
    envelope(g.gain, t0, gain);
    src.connect(filter).connect(g).connect(out);
    src.start(t0, offset);
    src.stop(t0 + duration + 0.05);
}

// Тон с падающей или растущей частотой: тело удара, бас, звон
function tone(ctx, out, t0, { type = 'sine', freq = [120, 40], gain = [[0, 1], [0.3, 0.0001]], duration = 0.35 }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq[0], t0);
    osc.frequency.exponentialRampToValueAtTime(freq[1], t0 + duration);
    const g = ctx.createGain();
    envelope(g.gain, t0, gain);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
}

// Атака: щелчок в несколько миллисекунд — даёт удару резкость
function click(ctx, out, t0, level = 1, freq = 3500) {
    noise(ctx, out, t0, { type: 'highpass', freq: [freq, freq], q: 0.7, gain: [[0, level], [0.012, 0.0001]], duration: 0.015 });
}

// Треск: россыпь коротких щелчков — электричество, обломки
function crackle(ctx, out, t0, { count = 40, spread = 0.4, level = 0.5, freq = [2500, 6000] } = {}) {
    for (let i = 0; i < count; i++) {
        const t = t0 + Math.random() ** 1.6 * spread;
        const f = freq[0] + Math.random() * (freq[1] - freq[0]);
        noise(ctx, out, t, { type: 'bandpass', freq: [f, f * 0.8], q: 4, gain: [[0, level * (0.3 + Math.random() * 0.7)], [0.004 + Math.random() * 0.012, 0.0001]], duration: 0.02 });
    }
}

// ==========================================
// ЗВУКИ МОМЕНТОВ
// ==========================================

const RECIPES = {
    approach(ctx, out, t0, { duration = 0.52 } = {}) {
        noise(ctx, out, t0, { type: 'lowpass', freq: [180, 600], q: 0.8, gain: [[0, 0.0001], [duration * 0.9, 0.35], [duration + 0.15, 0.0001]], duration: duration + 0.15 });
        tone(ctx, out, t0, { freq: [45, 60], gain: [[0, 0.0001], [duration, 0.4], [duration + 0.2, 0.0001]], duration: duration + 0.2 });
    },
    // Вдох: шум с растущим тоном и нарастанием, в конце — обрыв (тишина перед ударом)
    inhale(ctx, out, t0, { duration = 0.88 } = {}) {
        noise(ctx, out, t0, { type: 'bandpass', freq: [500, 3200], q: 1.6, gain: [[0, 0.0001], [duration * 0.85, 0.7], [duration, 0.5], [duration + 0.015, 0.0001]], duration: duration + 0.02 });
        noise(ctx, out, t0, { type: 'highpass', freq: [2500, 7000], q: 0.7, gain: [[0, 0.0001], [duration * 0.9, 0.18], [duration + 0.015, 0.0001]], duration: duration + 0.02 });
        tone(ctx, out, t0, { type: 'sawtooth', freq: [70, 140], gain: [[0, 0.0001], [duration, 0.06], [duration + 0.015, 0.0001]], duration: duration + 0.02 });
    },
    // Рывок: свист затихает за ~60 мс до касания — перед ударом тишина
    lunge(ctx, out, t0) {
        noise(ctx, out, t0, { type: 'bandpass', freq: [700, 3500], q: 2, gain: [[0, 0.0001], [0.09, 0.8], [0.14, 0.0001]], duration: 0.16 });
    },
    // Касание: атака, тело, бас, раскат, треск молний, звон в ушах
    contact(ctx, out, t0) {
        click(ctx, out, t0, 1.4, 3000);
        tone(ctx, out, t0, { freq: [160, 45], gain: [[0, 1.6], [0.45, 0.0001]], duration: 0.5 });
        tone(ctx, out, t0, { freq: [60, 28], gain: [[0, 1.2], [1.1, 0.0001]], duration: 1.15 });
        noise(ctx, out, t0, { type: 'lowpass', freq: [5000, 150], q: 0.5, gain: [[0, 1.2], [0.03, 1.3], [1.6, 0.0001]], duration: 1.65 });
        crackle(ctx, out, t0 + 0.04, { count: 70, spread: 0.45, level: 0.55 });
        tone(ctx, out, t0 + 0.05, { freq: [3600, 3550], gain: [[0, 0.0001], [0.08, 0.05], [1.4, 0.0001]], duration: 1.45 });
    },
    // Кулак: index сдвигает высоту — очередь не звучит одним звуком
    punch(ctx, out, t0, { index = 0 } = {}) {
        const k = [1, 0.92, 1.07, 0.97][index % 4] * (0.97 + Math.random() * 0.06);
        click(ctx, out, t0, 0.9, 2800 * k);
        tone(ctx, out, t0, { freq: [190 * k, 55 * k], gain: [[0, 1.3], [0.2, 0.0001]], duration: 0.22 });
        noise(ctx, out, t0, { type: 'lowpass', freq: [2600 * k, 300], q: 0.6, gain: [[0, 0.9], [0.18, 0.0001]], duration: 0.2 });
    },
    punchFinal(ctx, out, t0) {
        click(ctx, out, t0, 1.3, 2600);
        tone(ctx, out, t0, { freq: [150, 38], gain: [[0, 1.6], [0.5, 0.0001]], duration: 0.55 });
        tone(ctx, out, t0, { freq: [55, 26], gain: [[0, 1.1], [1.0, 0.0001]], duration: 1.05 });
        noise(ctx, out, t0, { type: 'lowpass', freq: [3500, 120], q: 0.5, gain: [[0, 1.1], [1.3, 0.0001]], duration: 1.35 });
    },
    // Полёт: свист уходит вниз по тону и затихает — цель удаляется
    fly(ctx, out, t0, { duration = 0.38 } = {}) {
        noise(ctx, out, t0, { type: 'bandpass', freq: [2400, 500], q: 2.2, gain: [[0, 0.0001], [0.04, 1.5], [duration + 0.1, 0.0001]], duration: duration + 0.1 });
        noise(ctx, out, t0, { type: 'lowpass', freq: [900, 200], q: 0.7, gain: [[0, 0.0001], [0.05, 0.7], [duration + 0.15, 0.0001]], duration: duration + 0.15 });
    },
    land(ctx, out, t0) {
        click(ctx, out, t0, 0.8, 1800);
        tone(ctx, out, t0, { freq: [110, 35], gain: [[0, 1.4], [0.45, 0.0001]], duration: 0.5 });
        noise(ctx, out, t0, { type: 'lowpass', freq: [1800, 150], q: 0.6, gain: [[0, 1], [0.7, 0.0001]], duration: 0.75 });
        // Осыпь: мелкие камешки после удара
        crackle(ctx, out, t0 + 0.06, { count: 45, spread: 0.7, level: 0.35, freq: [900, 3000] });
    },
    ok(ctx, out, t0) {
        tone(ctx, out, t0, { freq: [520, 880], gain: [[0, 0.0001], [0.012, 0.35], [0.09, 0.0001]], duration: 0.1 });
        noise(ctx, out, t0, { type: 'bandpass', freq: [1200, 2400], q: 3, gain: [[0, 0.2], [0.05, 0.0001]], duration: 0.06 });
    }
};

/**
 * Сыграть звук момента в контексте ctx через узел out, начиная с момента t0 (секунды контекста).
 * Для отрисовки в файл: ctx — OfflineAudioContext.
 */
export function renderCue(ctx, out, name, t0, options = {}) {
    RECIPES[name]?.(ctx, out, t0, options);
}

// ==========================================
// ВОСПРОИЗВЕДЕНИЕ В ИГРЕ
// ==========================================

let live = null;

// Общая цепочка: громкость → компрессор (наложение слоёв не перегружает звук) → выход
function liveOutput(volume) {
    if (!live) {
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -10;
        limiter.knee.value = 6;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.15;
        gain.connect(limiter).connect(ctx.destination);
        live = { ctx, gain };
    }
    if (live.ctx.state === 'suspended') live.ctx.resume();
    live.gain.gain.value = volume;
    return live;
}

/**
 * Звук момента: файл из папки звуков, если она указана, иначе синтез.
 * @param {string} name     Момент из CUES.
 * @param {object} options  { volume, folder, duration (с), index }.
 */
export function playCue(name, { volume = 0.5, folder = '', ...options } = {}) {
    if (!RECIPES[name]) return;
    if (folder) {
        const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
        return helper?.play({ src: `${folder.replace(/\/$/, '')}/${name}.ogg`, volume, autoplay: true, loop: false }, false);
    }
    try {
        const { ctx, gain } = liveOutput(volume);
        renderCue(ctx, gain, name, ctx.currentTime + 0.005, options);
    } catch (error) {
        console.warn(`gachadnd | звук ${name}`, error);
    }
}
