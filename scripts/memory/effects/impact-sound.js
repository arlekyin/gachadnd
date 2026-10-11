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
    ok: 'реплика «Ок.»: тихий хлопок пузыря',
    bars: 'кинополосы выезжают: низкий короткий удар-заставка',
    beam: 'столб света: высокий нарастающий свист',
    zap: 'молнии: электрический треск со щелчками'
};

// Эффекты шины (только для синтеза): провал в тишину, контузия, тишина перед репликой
export const FX = ['dip', 'muffle', 'hush'];

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
 * Шина звуков: dry — сухой звук, drive — через мягкий перегруз, crush — через жёсткий,
 * verb — посыл в ревербацию.
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
    // Контузия: фильтр после всех звуков — в обычном состоянии открыт
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 20000;
    muffle.Q.value = 0.7;
    master.connect(muffle).connect(limiter).connect(destination);

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
    // Жёсткий перегруз: почти срезанные пики — хруст, треск, грубость
    const crush = ctx.createWaveShaper();
    crush.curve = driveCurve(7);
    crush.oversample = '2x';
    const crushOut = ctx.createGain();
    crushOut.gain.value = 0.55;
    crush.connect(crushOut).connect(master);
    return { dry, drive, crush, verb, master, muffle, post: limiter, volume };
}

// Слой → в шину: по месту в стереопанораме, сухо или через перегруз, с посылом в ревербацию
// Место звука на экране: сдвиг панорамы всех слоёв текущего звука (−1 слева … 1 справа)
let cuePan = 0;

function route(ctx, node, bus, { pan = 0, send = 0.2, driven = false, crushed = false }) {
    let tail = node;
    pan = Math.max(-1, Math.min(1, pan + cuePan));
    if (pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        tail.connect(p);
        tail = p;
    }
    tail.connect(crushed ? bus.crush : driven ? bus.drive : bus.dry);
    if (send > 0) {
        const s = ctx.createGain();
        s.gain.value = send;
        tail.connect(s).connect(bus.verb);
    }
}

// ==========================================
// КИРПИЧИ СИНТЕЗА
// ==========================================

// Разнообразие: каждый слой при каждом показе чуть иной по высоте и громкости
const vary = (spread = 0.06) => 1 + (Math.random() - 0.5) * spread;

// Огибающая громкости: точки [время от начала, уровень]; между ними — экспоненциально
function envelope(param, t0, points) {
    const k = vary(0.18);
    param.setValueAtTime(Math.max(0.0001, points[0][1] * k), t0 + points[0][0]);
    for (const [dt, v] of points.slice(1)) param.exponentialRampToValueAtTime(Math.max(0.0001, v * k), t0 + dt);
}

// Шум через фильтр с меняющейся частотой: свисты, всасывание, гул, треск. Стерео: каналы
// шума разные — звук широкий, а не точка посередине
function noise(ctx, bus, t0, { type = 'bandpass', freq = [1000, 1000], q = 1, gain = [[0, 0.0001], [0.01, 1], [0.3, 0.0001]], duration = 0.4, offset = Math.random() * 2, ...mix }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    const fk = vary(0.08);
    filter.frequency.setValueAtTime(freq[0] * fk, t0);
    filter.frequency.exponentialRampToValueAtTime(freq[1] * fk, t0 + duration);
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
    const fk = vary(0.05);
    osc.frequency.setValueAtTime(freq[0] * fk, t0);
    osc.frequency.exponentialRampToValueAtTime(freq[1] * fk, t0 + duration);
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

// Треск стекла в духе файтингов: не звон, а короткий сухой хлёсткий «кш-ш». Зажатый жёстким
// перегрузом треск, плотная россыпь хруста за 0,1 с и металлический призвук (частотная модуляция
// с некратным соотношением — «дзынь» без ноты), почти без хвоста
function glass(ctx, bus, t0, { level = 0.35, pan = 0 } = {}) {
    noise(ctx, bus, t0, { type: 'highpass', freq: [2200, 1800], q: 0.7, gain: [[0, level * 1.8], [0.035, level * 0.5], [0.09, 0.0001]], duration: 0.1, pan, crushed: true, send: 0.08 });
    noise(ctx, bus, t0, { type: 'bandpass', freq: [6500, 4200], q: 1.2, gain: [[0, level * 1.1], [0.16, 0.0001]], duration: 0.17, pan: -pan, send: 0.12 });
    crackle(ctx, bus, t0 + 0.004, { count: 26, spread: 0.11, level: level * 1.1, freq: [2500, 8000], send: 0.08 });
    // Металлический призвук
    for (const [carrier, ratio, length] of [[2300, 1.41, 0.14], [3700, 2.76, 0.1]]) {
        const osc = ctx.createOscillator(), mod = ctx.createOscillator(), depth = ctx.createGain(), g = ctx.createGain();
        osc.frequency.value = carrier * (0.95 + Math.random() * 0.1);
        mod.frequency.value = osc.frequency.value * ratio;
        depth.gain.value = osc.frequency.value * 1.6;
        mod.connect(depth).connect(osc.frequency);
        envelope(g.gain, t0, [[0, level * 0.35], [length, 0.0001]]);
        osc.connect(g);
        route(ctx, g, bus, { pan: pan * 0.5, send: 0.1 });
        for (const o of [osc, mod]) { o.start(t0); o.stop(t0 + length + 0.05); }
    }
}

// Свист с дрожанием: шум, громкость которого рвёт быстрое колебание — так режет воздух
// кувыркающееся тело
function flutter(ctx, bus, t0, { freq = [2000, 400], q = 1.8, rate = [34, 14], level = 1, duration = 0.4, pan = 0, send = 0.3 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq[0], t0);
    filter.frequency.exponentialRampToValueAtTime(freq[1], t0 + duration);
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator(), lfoDepth = ctx.createGain();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(rate[0], t0);
    lfo.frequency.exponentialRampToValueAtTime(rate[1], t0 + duration);
    lfoDepth.gain.value = 0.5;
    lfo.connect(lfoDepth).connect(am.gain);
    const g = ctx.createGain();
    envelope(g.gain, t0, [[0, 0.0001], [0.03, level], [duration, level * 0.4], [duration + 0.12, 0.0001]]);
    src.connect(filter).connect(am).connect(g);
    route(ctx, g, bus, { pan, send });
    src.start(t0, Math.random() * 2);
    src.stop(t0 + duration + 0.15);
    lfo.start(t0);
    lfo.stop(t0 + duration + 0.15);
}

// ==========================================
// ЗВУКИ МОМЕНТОВ
// ==========================================

const RECIPES = {
    // Кинополосы: низкий короткий удар-заставка, как начало сцены в кино
    bars(ctx, bus, t0) {
        tone(ctx, bus, t0, { type: 'triangle', freq: [70, 34], gain: [[0, 1.1], [0.9, 0.0001]], duration: 0.95, send: 0.3 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [600, 90], q: 0.8, gain: [[0, 0.8], [0.7, 0.0001]], duration: 0.75, send: 0.5 });
        click(ctx, bus, t0, 0.5, 1200, 0.3);
    },
    // Столб света: высокий свист, растёт за 50 мс
    beam(ctx, bus, t0) {
        noise(ctx, bus, t0, { type: 'bandpass', freq: [3000, 9000], q: 3, gain: [[0, 0.0001], [0.04, 0.7], [0.09, 0.0001]], duration: 0.1, send: 0.3 });
        tone(ctx, bus, t0, { freq: [2400, 5200], gain: [[0, 0.0001], [0.04, 0.12], [0.08, 0.0001]], duration: 0.09, send: 0.25 });
    },
    // Молнии: электрический треск — щелчки и гудящий зуд
    zap(ctx, bus, t0) {
        crackle(ctx, bus, t0, { count: 45, spread: 0.1, level: 0.75, freq: [1500, 7000], send: 0.25 });
        tone(ctx, bus, t0, { type: 'sawtooth', freq: [120, 90], gain: [[0, 0.25], [0.12, 0.0001]], duration: 0.13, crushed: true, send: 0.15 });
    },
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
    // Касание: самый тяжёлый удар — ниже и дольше обычного, с глухим толчком, мощным суббасом
    // и вторым раскатом через 70 мс (эхо взрыва); треск молний по всей панораме, звон в ушах
    contact(ctx, bus, t0) {
        slam(ctx, bus, t0, { pitch: 0.8, body: 1.8, sub: 1.5, subLen: 2.0, rumble: 1.3, rumbleLen: 2.6, send: 0.65 });
        // Толчок: плотный низ середины, через перегруз
        noise(ctx, bus, t0, { type: 'lowpass', freq: [450, 140], q: 1.2, gain: [[0, 1.6], [0.25, 0.0001]], duration: 0.28, driven: true, send: 0.3 });
        // Суббас, который чувствуется, а не слышится: синус падает с 80 до 32 Гц
        tone(ctx, bus, t0, { freq: [80, 32], gain: [[0, 1.4], [0.06, 1.3], [2.0, 0.0001]], duration: 2.05, send: 0.05 });
        // Эхо взрыва
        for (const pan of [-0.7, 0.7]) noise(ctx, bus, t0 + 0.07, { type: 'lowpass', freq: [1500, 90], q: 0.6, gain: [[0, 0.0001], [0.03, 0.9], [1.6, 0.0001]], duration: 1.65, pan, send: 0.7 });
        crackle(ctx, bus, t0 + 0.04, { count: 80, spread: 0.5, level: 0.5, send: 0.45 });
        tone(ctx, bus, t0 + 0.05, { freq: [3600, 3550], gain: [[0, 0.0001], [0.08, 0.045], [1.4, 0.0001]], duration: 1.45, send: 0.3 });
    },
    // Кулак — удар в экран: плотный низ, толчок и треск стекла. index сдвигает высоту и место
    // в панораме — очередь не звучит одним звуком
    punch(ctx, bus, t0, { index = 0 } = {}) {
        const k = [1, 0.92, 1.07, 0.97][index % 4] * (0.97 + Math.random() * 0.06);
        // Место — от экрана (pan в playCue); здесь только лёгкий разброс слоёв
        const pan = [-0.12, 0.12, 0.1, -0.1][index % 4];
        click(ctx, bus, t0, 0.9, 2800 * k, 0.2);
        tone(ctx, bus, t0, { freq: [170 * k, 48 * k], gain: [[0, 1.5], [0.3, 0.0001]], duration: 0.32, driven: true, pan: pan * 0.5, send: 0.3 });
        tone(ctx, bus, t0, { type: 'triangle', freq: [66 * k, 36], gain: [[0, 1.0], [0.5, 0.0001]], duration: 0.52, send: 0.05 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [380 * k, 120], q: 1.1, gain: [[0, 1.1], [0.16, 0.0001]], duration: 0.18, driven: true, pan: pan * 0.5, send: 0.2 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [2600 * k, 300], q: 0.6, gain: [[0, 0.8], [0.26, 0.0001]], duration: 0.28, pan, send: 0.4 });
        glass(ctx, bus, t0 + 0.004, { level: 0.3, pan });
    },
    // Пятый кулак: тяжёлый удар и стекло громче — экран трескается по-настоящему
    punchFinal(ctx, bus, t0) {
        slam(ctx, bus, t0, { pitch: 0.85, body: 1.7, sub: 1.3, subLen: 1.4, rumble: 1.1, rumbleLen: 1.7, send: 0.55 });
        glass(ctx, bus, t0 + 0.004, { level: 0.5 });
    },
    // Полёт: рвущийся свист с дрожанием от кувырка, тон падает — цель удаляется; под ним ветер
    // с хрипом через жёсткий перегруз
    fly(ctx, bus, t0, { duration = 0.38 } = {}) {
        flutter(ctx, bus, t0, { freq: [2600, 450], rate: [36, 12], level: 1.4, duration, pan: 0.25, send: 0.35 });
        flutter(ctx, bus, t0 + 0.015, { freq: [1300, 260], q: 1.2, rate: [28, 10], level: 0.9, duration, pan: -0.25, send: 0.3 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [700, 160], q: 0.9, gain: [[0, 0.0001], [0.05, 0.6], [duration + 0.15, 0.0001]], duration: duration + 0.15, crushed: true, send: 0.15 });
    },
    // Приземление: грубо и сухо — не как остальные удары. Хрустящий перегруженный низ, глухой
    // удар о землю, плотный гравий и шорох разлетающейся земли, ревербации почти нет
    land(ctx, bus, t0) {
        click(ctx, bus, t0, 1.1, 1500, 0.05);
        noise(ctx, bus, t0, { type: 'lowpass', freq: [900, 140], q: 1, gain: [[0, 1.8], [0.08, 1.0], [0.45, 0.0001]], duration: 0.5, crushed: true, send: 0.1 });
        tone(ctx, bus, t0, { freq: [95, 30], gain: [[0, 1.6], [0.4, 0.0001]], duration: 0.45, driven: true, send: 0.05 });
        tone(ctx, bus, t0, { type: 'triangle', freq: [48, 28], gain: [[0, 1.0], [0.7, 0.0001]], duration: 0.75, send: 0.02 });
        // Гравий: плотная россыпь в средних частотах, рассыпается по сторонам
        crackle(ctx, bus, t0 + 0.01, { count: 90, spread: 0.55, level: 0.55, freq: [300, 1600], send: 0.1 });
        crackle(ctx, bus, t0 + 0.08, { count: 40, spread: 0.9, level: 0.25, freq: [1200, 3500], send: 0.12 });
        for (const pan of [-0.6, 0.6]) noise(ctx, bus, t0 + 0.03, { type: 'bandpass', freq: [1800, 700], q: 0.7, gain: [[0, 0.0001], [0.04, 0.5], [0.6, 0.0001]], duration: 0.65, pan, send: 0.1 });
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

function liveBus(volume) {
    if (!live) {
        const ctx = new AudioContext();
        live = { ctx, bus: createBus(ctx, ctx.destination, volume) };
    }
    if (live.ctx.state === 'suspended') live.ctx.resume();
    // Пока идёт провал или тишина — громкость ведёт их автоматизация
    if (live.ctx.currentTime >= (live.fxUntil ?? 0)) live.bus.master.gain.value = volume;
    return live;
}

/**
 * Эффект шины синтеза.
 *  dip    — провал в тишину на duration (белый кадр);
 *  muffle — контузия: всё глухо, как под водой, и звон в ушах; верха возвращаются за duration;
 *  hush   — тишина перед репликой: хвосты обрываются, через duration звук возвращается.
 */
function busFx(name, { volume = 0.5, duration = 0.04 } = {}) {
    const state = liveBus(volume), { ctx, bus } = state, t = ctx.currentTime, g = bus.master.gain;
    if (name === 'dip' || name === 'hush') {
        state.fxUntil = t + duration + 0.03;
        const low = name === 'dip' ? 0.12 : 0.0001;
        g.cancelScheduledValues(t);
        g.setValueAtTime(volume, t);
        g.linearRampToValueAtTime(volume * low, t + (name === 'dip' ? 0.006 : 0.12));
        g.setValueAtTime(volume * low, t + duration);
        g.linearRampToValueAtTime(volume, t + duration + 0.02);
    } else if (name === 'muffle') {
        const f = bus.muffle.frequency;
        f.cancelScheduledValues(t);
        f.setValueAtTime(20000, t);
        f.exponentialRampToValueAtTime(380, t + 0.05);
        f.setValueAtTime(380, t + duration * 0.45);
        f.exponentialRampToValueAtTime(20000, t + duration);
        // Звон в ушах — мимо фильтра, затихает вместе с контузией
        const osc = ctx.createOscillator(), rg = ctx.createGain();
        osc.frequency.value = 3400 * vary(0.08);
        rg.gain.setValueAtTime(0.0001, t);
        rg.gain.exponentialRampToValueAtTime(0.06 * volume, t + 0.06);
        rg.gain.exponentialRampToValueAtTime(0.0001, t + duration * 1.2);
        osc.connect(rg).connect(bus.post);
        osc.start(t);
        osc.stop(t + duration * 1.2 + 0.05);
    }
}

/**
 * Звук момента: файл из папки звуков, если она указана, иначе синтез. Эффекты шины (FX) —
 * только для синтеза.
 * @param {string} name     Момент из CUES или эффект из FX.
 * @param {object} options  { volume, folder, duration (с), index, pan (−1…1 — место на экране) }.
 */
export function playCue(name, { volume = 0.5, folder = '', pan = 0, ...options } = {}) {
    if (FX.includes(name)) {
        if (!folder) try { busFx(name, { volume, ...options }); } catch (error) { console.warn(`gachadnd | звук ${name}`, error); }
        return;
    }
    if (!RECIPES[name]) return;
    if (folder) {
        const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
        return helper?.play({ src: `${folder.replace(/\/$/, '')}/${name}.ogg`, volume, autoplay: true, loop: false }, false);
    }
    try {
        const { ctx, bus } = liveBus(volume);
        cuePan = pan;
        renderCue(ctx, bus, name, ctx.currentTime + 0.005, options);
    } catch (error) {
        console.warn(`gachadnd | звук ${name}`, error);
    } finally {
        cuePan = 0;
    }
}

/**
 * Приглушить музыку и звуки сцены Foundry на время удара. Возвращает функцию, которая
 * плавно возвращает громкость.
 */
export function duckScene(level = 0.15, fadeIn = 250, fadeOut = 900) {
    const sounds = [];
    try {
        for (const playlist of game.playlists?.playing ?? []) {
            for (const ps of playlist.sounds?.filter(s => s.playing) ?? []) if (ps.sound) sounds.push(ps.sound);
        }
        for (const ambient of globalThis.canvas?.sounds?.placeables ?? []) if (ambient.sound?.playing) sounds.push(ambient.sound);
    } catch (error) { console.warn('gachadnd | приглушение звуков сцены', error); }
    const ducked = sounds.map(sound => {
        const volume = sound.volume;
        try { sound.fade ? sound.fade(volume * level, { duration: fadeIn }) : (sound.volume = volume * level); } catch { /* звук уже остановлен */ }
        return { sound, volume };
    });
    return () => {
        for (const { sound, volume } of ducked) {
            try { sound.fade ? sound.fade(volume, { duration: fadeOut }) : (sound.volume = volume); } catch { /* звук уже остановлен */ }
        }
    };
}
