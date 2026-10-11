/**
 * Gacha Roguelike dnd5e — Звуки импакт-кадров
 *
 * Каждый момент удара — свой звук, синтезированный в браузере (Web Audio), без файлов.
 * Большие удары собраны из слоёв: атака (короткий треск) — тело (глухой удар с басом) — суббас —
 * хвост (гул, обломки). Глубину дают три вещи:
 *  - пространство: каждый слой частью уходит в ревербацию — сгенерированный хвост помещения;
 *  - ширина: звук стерео, шумовые слои разведены по сторонам и не совпадают в каналах;
 *  - плотность: удары проходят мягкий перегруз, он добавляет обертоны.
 * Если в настройке «Папка звуков импакт-кадров» указана папка, вместо синтеза играет файл из неё
 * с именем момента: approach.ogg, inhale.ogg, … (список — CUES).
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
// ЦЕПОЧКА: сухой звук, перегруз, ревербация, лимитер
// ==========================================

const noiseCache = new WeakMap();

// Белый шум на 3 секунды, по каналу на сторону — общий для всех звуков контекста
function noiseBuffer(ctx) {
    if (!noiseCache.has(ctx)) {
        const length = Math.round(ctx.sampleRate * 3);
        const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let c = 0; c < 2; c++) {
            const ch = buffer.getChannelData(c);
            for (let i = 0; i < length; i++) ch[i] = Math.random() * 2 - 1;
        }
        noiseCache.set(ctx, buffer);
    }
    return noiseCache.get(ctx);
}

// Хвост помещения: стерео-шум с затуханием, ранние отражения и потемнение к концу
function impulse(ctx, seconds = 2.2, decay = 0.45) {
    const length = Math.round(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
        const ch = buffer.getChannelData(c);
        let low = 0;
        for (let i = 0; i < length; i++) {
            const t = i / ctx.sampleRate;
            // Чем дальше, тем темнее: однополюсный фильтр с растущей силой
            const k = 0.25 + 0.7 * Math.min(1, t / seconds);
            low = low * k + (Math.random() * 2 - 1) * (1 - k);
            ch[i] = low * Math.exp(-t / decay) * 2.2;
        }
        // Ранние отражения: несколько отчётливых щелчков в первые 60 мс
        for (let r = 0; r < 6; r++) {
            const i = Math.round(ctx.sampleRate * (0.008 + Math.random() * 0.055));
            ch[i] += (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.4);
        }
    }
    return buffer;
}

// Мягкий перегруз: гиперболический тангенс — округляет пики, добавляет обертоны
function driveCurve(amount = 2.2) {
    const n = 2048, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = i / (n - 1) * 2 - 1;
        curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return curve;
}

/**
 * Шина звуков: dry — сухой звук, drive — через перегруз, verb — посыл в ревербацию.
 * Всё сходится в лимитер и уходит в destination.
 */
export function createBus(ctx, destination, volume = 0.5) {
    const master = ctx.createGain();
    master.gain.value = volume;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    master.connect(limiter).connect(destination);

    const dry = ctx.createGain();
    dry.connect(master);
    const drive = ctx.createWaveShaper();
    drive.curve = driveCurve();
    drive.oversample = '2x';
    const driveOut = ctx.createGain();
    driveOut.gain.value = 0.8;
    drive.connect(driveOut).connect(master);
    const verb = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    verb.connect(convolver).connect(wet).connect(master);
    return { dry, drive, verb, master };
}

// Слой → в шину: по месту в стереопанораме, сухо или через перегруз, с посылом в ревербацию
function route(ctx, node, bus, { pan = 0, send = 0.2, driven = false }) {
    let tail = node;
    if (pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        tail.connect(p);
        tail = p;
    }
    tail.connect(driven ? bus.drive : bus.dry);
    if (send > 0) {
        const s = ctx.createGain();
        s.gain.value = send;
        tail.connect(s).connect(bus.verb);
    }
}

// ==========================================
// КИРПИЧИ СИНТЕЗА
// ==========================================

// Огибающая громкости: точки [время от начала, уровень]; между ними — экспоненциально
function envelope(param, t0, points) {
    param.setValueAtTime(Math.max(0.0001, points[0][1]), t0 + points[0][0]);
    for (const [dt, v] of points.slice(1)) param.exponentialRampToValueAtTime(Math.max(0.0001, v), t0 + dt);
}

// Шум через фильтр с меняющейся частотой: свисты, всасывание, гул, треск. Стерео: каналы
// шума разные — звук широкий, а не точка посередине
function noise(ctx, bus, t0, { type = 'bandpass', freq = [1000, 1000], q = 1, gain = [[0, 0.0001], [0.01, 1], [0.3, 0.0001]], duration = 0.4, offset = Math.random() * 2, ...mix }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq[0], t0);
    filter.frequency.exponentialRampToValueAtTime(freq[1], t0 + duration);
    const g = ctx.createGain();
    envelope(g.gain, t0, gain);
    src.connect(filter).connect(g);
    route(ctx, g, bus, mix);
    src.start(t0, offset);
    src.stop(t0 + duration + 0.05);
}

// Тон с падающей или растущей частотой: тело удара, бас, звон
function tone(ctx, bus, t0, { type = 'sine', freq = [120, 40], gain = [[0, 1], [0.3, 0.0001]], duration = 0.35, ...mix }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq[0], t0);
    osc.frequency.exponentialRampToValueAtTime(freq[1], t0 + duration);
    const g = ctx.createGain();
    envelope(g.gain, t0, gain);
    osc.connect(g);
    route(ctx, g, bus, mix);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
}

// Атака: щелчок в несколько миллисекунд — даёт удару резкость
function click(ctx, bus, t0, level = 1, freq = 3500, send = 0.15) {
    noise(ctx, bus, t0, { type: 'highpass', freq: [freq, freq], q: 0.7, gain: [[0, level], [0.012, 0.0001]], duration: 0.015, send });
}

// Треск: россыпь коротких щелчков по всей панораме — электричество, обломки
function crackle(ctx, bus, t0, { count = 40, spread = 0.4, level = 0.5, freq = [2500, 6000], send = 0.35 } = {}) {
    for (let i = 0; i < count; i++) {
        const t = t0 + Math.random() ** 1.6 * spread;
        const f = freq[0] + Math.random() * (freq[1] - freq[0]);
        noise(ctx, bus, t, {
            type: 'bandpass', freq: [f, f * 0.8], q: 4, duration: 0.02, send, pan: (Math.random() - 0.5) * 1.6,
            gain: [[0, level * (0.3 + Math.random() * 0.7)], [0.004 + Math.random() * 0.012, 0.0001]]
        });
    }
}

// Тяжёлый удар: атака, тело с падающим тоном через перегруз, суббас, раскат по сторонам
function slam(ctx, bus, t0, { pitch = 1, body = 1.4, sub = 1.1, subLen = 1.1, rumble = 1.1, rumbleLen = 1.5, send = 0.5 } = {}) {
    click(ctx, bus, t0, 1.3, 2800 * pitch);
    tone(ctx, bus, t0, { freq: [170 * pitch, 42 * pitch], gain: [[0, body], [0.5, 0.0001]], duration: 0.55, driven: true, send: send * 0.6 });
    tone(ctx, bus, t0, { type: 'triangle', freq: [62 * pitch, 30], gain: [[0, sub], [subLen, 0.0001]], duration: subLen + 0.05, send: 0.1 });
    for (const pan of [-0.55, 0.55]) {
        noise(ctx, bus, t0, { type: 'lowpass', freq: [4200, 110], q: 0.5, gain: [[0, rumble * 0.7], [0.03, rumble * 0.8], [rumbleLen, 0.0001]], duration: rumbleLen + 0.05, pan, send });
    }
}

// ==========================================
// ЗВУКИ МОМЕНТОВ
// ==========================================

const RECIPES = {
    approach(ctx, bus, t0, { duration = 0.52 } = {}) {
        for (const pan of [-0.6, 0.6]) noise(ctx, bus, t0, { type: 'lowpass', freq: [160, 700], q: 0.8, gain: [[0, 0.0001], [duration * 0.9, 0.3], [duration + 0.2, 0.0001]], duration: duration + 0.2, pan, send: 0.4 });
        tone(ctx, bus, t0, { type: 'triangle', freq: [42, 58], gain: [[0, 0.0001], [duration, 0.45], [duration + 0.25, 0.0001]], duration: duration + 0.25, send: 0.2 });
    },
    // Вдох: шум с растущим тоном и нарастанием, в конце — обрыв (тишина перед ударом); хвост
    // помещения оставляет в обрыве короткое эхо
    inhale(ctx, bus, t0, { duration = 0.88 } = {}) {
        for (const pan of [-0.4, 0.4]) noise(ctx, bus, t0, { type: 'bandpass', freq: [450, 3400], q: 1.6, gain: [[0, 0.0001], [duration * 0.85, 0.6], [duration, 0.45], [duration + 0.015, 0.0001]], duration: duration + 0.02, pan, send: 0.3 });
        noise(ctx, bus, t0, { type: 'highpass', freq: [2500, 7500], q: 0.7, gain: [[0, 0.0001], [duration * 0.9, 0.16], [duration + 0.015, 0.0001]], duration: duration + 0.02, send: 0.2 });
        tone(ctx, bus, t0, { type: 'sawtooth', freq: [60, 140], gain: [[0, 0.0001], [duration, 0.07], [duration + 0.015, 0.0001]], duration: duration + 0.02, driven: true, send: 0.15 });
    },
    // Рывок: свист проходит слева направо и затихает за ~60 мс до касания — перед ударом тишина
    lunge(ctx, bus, t0) {
        noise(ctx, bus, t0, { type: 'bandpass', freq: [700, 3500], q: 2, gain: [[0, 0.0001], [0.09, 0.8], [0.14, 0.0001]], duration: 0.16, pan: -0.3, send: 0.25 });
        noise(ctx, bus, t0 + 0.02, { type: 'bandpass', freq: [900, 4200], q: 2, gain: [[0, 0.0001], [0.08, 0.6], [0.12, 0.0001]], duration: 0.14, pan: 0.4, send: 0.25 });
    },
    // Касание: тяжёлый удар, треск молний по всей панораме, звон в ушах
    contact(ctx, bus, t0) {
        slam(ctx, bus, t0, { body: 1.5, sub: 1.3, subLen: 1.4, rumble: 1.2, rumbleLen: 1.8, send: 0.6 });
        crackle(ctx, bus, t0 + 0.04, { count: 80, spread: 0.5, level: 0.5, send: 0.45 });
        tone(ctx, bus, t0 + 0.05, { freq: [3600, 3550], gain: [[0, 0.0001], [0.08, 0.045], [1.4, 0.0001]], duration: 1.45, send: 0.3 });
    },
    // Кулак: index сдвигает высоту и место в панораме — очередь не звучит одним звуком
    punch(ctx, bus, t0, { index = 0 } = {}) {
        const k = [1, 0.92, 1.07, 0.97][index % 4] * (0.97 + Math.random() * 0.06);
        const pan = [-0.35, 0.35, 0.3, -0.3][index % 4];
        click(ctx, bus, t0, 0.9, 2800 * k, 0.2);
        tone(ctx, bus, t0, { freq: [200 * k, 55 * k], gain: [[0, 1.3], [0.24, 0.0001]], duration: 0.26, driven: true, pan: pan * 0.5, send: 0.3 });
        tone(ctx, bus, t0, { type: 'triangle', freq: [70 * k, 40], gain: [[0, 0.7], [0.35, 0.0001]], duration: 0.38, send: 0.05 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [2600 * k, 300], q: 0.6, gain: [[0, 0.9], [0.22, 0.0001]], duration: 0.24, pan, send: 0.4 });
    },
    punchFinal(ctx, bus, t0) {
        slam(ctx, bus, t0, { pitch: 0.9, body: 1.6, sub: 1.2, subLen: 1.2, rumble: 1.1, rumbleLen: 1.5, send: 0.55 });
    },
    // Полёт: свист уходит вниз по тону, из центра в сторону, и затихает — цель удаляется
    fly(ctx, bus, t0, { duration = 0.38 } = {}) {
        noise(ctx, bus, t0, { type: 'bandpass', freq: [2400, 500], q: 2.2, gain: [[0, 0.0001], [0.04, 1.5], [duration + 0.1, 0.0001]], duration: duration + 0.1, pan: 0.2, send: 0.45 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [900, 200], q: 0.7, gain: [[0, 0.0001], [0.05, 0.7], [duration + 0.15, 0.0001]], duration: duration + 0.15, pan: -0.2, send: 0.4 });
    },
    // Приземление: удар о землю и долгая осыпь камней по сторонам
    land(ctx, bus, t0) {
        slam(ctx, bus, t0, { pitch: 0.75, body: 1.3, sub: 1.0, subLen: 0.9, rumble: 0.9, rumbleLen: 0.9, send: 0.45 });
        crackle(ctx, bus, t0 + 0.06, { count: 60, spread: 1.0, level: 0.32, freq: [700, 2800], send: 0.3 });
    },
    ok(ctx, bus, t0) {
        tone(ctx, bus, t0, { freq: [520, 880], gain: [[0, 0.0001], [0.012, 0.35], [0.09, 0.0001]], duration: 0.1, send: 0.15 });
        noise(ctx, bus, t0, { type: 'bandpass', freq: [1200, 2400], q: 3, gain: [[0, 0.2], [0.05, 0.0001]], duration: 0.06, send: 0.1 });
    }
};

/**
 * Сыграть звук момента в шине bus (createBus), начиная с момента t0 (секунды контекста).
 * Для отрисовки в файл: ctx — OfflineAudioContext.
 */
export function renderCue(ctx, bus, name, t0, options = {}) {
    RECIPES[name]?.(ctx, bus, t0, options);
}

// ==========================================
// ВОСПРОИЗВЕДЕНИЕ В ИГРЕ
// ==========================================

let live = null;

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
        if (!live) {
            const ctx = new AudioContext();
            live = { ctx, bus: createBus(ctx, ctx.destination, volume) };
        }
        if (live.ctx.state === 'suspended') live.ctx.resume();
        live.bus.master.gain.value = volume;
        renderCue(live.ctx, live.bus, name, live.ctx.currentTime + 0.005, options);
    } catch (error) {
        console.warn(`gachadnd | звук ${name}`, error);
    }
}
