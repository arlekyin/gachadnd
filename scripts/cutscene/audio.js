/**
 * Катсцены — звук: синтез в браузере (Web Audio) без файлов и воспроизведение звуков сцены.
 *
 * Шина (createBus): сухой звук, мягкий и жёсткий перегруз, басовая шина с гармониками (бас слышен
 * и на динамиках ноутбука), ревербация — сгенерированный хвост помещения, фильтр, лимитер
 * и предохранитель. Кирпичи синтеза — noise и tone; инструменты из них — instruments.js.
 * Звуки сцен регистрируются по именам (registerCues) и играют через playCue: синтез или файл
 * из папки с тем же именем. Работает и в OfflineAudioContext — звук можно отрисовать в файл.
 */

// Эффекты шины (только для синтеза): провал в тишину, тишина перед репликой
export const FX = ['dip', 'hush'];

// ==========================================
// ЦЕПОЧКА: сухой звук, перегруз, ревербация, лимитер
// ==========================================

const noiseCache = new WeakMap();

// Белый шум на 3 секунды, по каналу на сторону — общий для всех звуков контекста
export function noiseBuffer(ctx) {
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
export function driveCurve(amount = 2.2) {
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
    limiter.threshold.value = -7;
    limiter.knee.value = 6;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    // Предохранитель после лимитера: мягко срезает выбросы атаки выше 0 дБ
    const guard = ctx.createWaveShaper();
    guard.curve = driveCurve(1.4);
    const guardIn = ctx.createGain();
    guardIn.gain.value = 0.9;
    master.connect(limiter).connect(guardIn).connect(guard).connect(destination);

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
    // Глубокий бас: сам суббас и его гармоники. Ниже 80 Гц почти не слышно на динамиках ноутбука
    // и телефона — перегруз даёт обертоны на 100–250 Гц, по ним слух «достраивает» основной тон
    const sub = ctx.createGain();
    const subDry = ctx.createGain();
    subDry.gain.value = 0.75;
    sub.connect(subDry).connect(master);
    const subDrive = ctx.createWaveShaper();
    subDrive.curve = driveCurve(5);
    subDrive.oversample = '4x';
    const subBand = ctx.createBiquadFilter();
    subBand.type = 'bandpass';
    subBand.frequency.value = 140;
    subBand.Q.value = 0.6;
    const subHarm = ctx.createGain();
    subHarm.gain.value = 0.9;
    sub.connect(subDrive).connect(subBand).connect(subHarm).connect(master);
    return { dry, drive, crush, sub, verb, master, post: limiter, volume };
}

// Слой → в шину: по месту в стереопанораме, сухо или через перегруз, с посылом в ревербацию
// Место звука на экране: сдвиг панорамы всех слоёв текущего звука (−1 слева … 1 справа)
let cuePan = 0;

export function route(ctx, node, bus, { pan = 0, send = 0.2, driven = false, crushed = false, deep = false }) {
    let tail = node;
    pan = Math.max(-1, Math.min(1, pan + cuePan));
    if (pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        tail.connect(p);
        tail = p;
    }
    tail.connect(deep ? bus.sub : crushed ? bus.crush : driven ? bus.drive : bus.dry);
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
export const vary = (spread = 0.06) => 1 + (Math.random() - 0.5) * spread;

// Огибающая громкости: точки [время от начала, уровень]; между ними — экспоненциально
export function envelope(param, t0, points) {
    const k = vary(0.18);
    param.setValueAtTime(Math.max(0.0001, points[0][1] * k), t0 + points[0][0]);
    for (const [dt, v] of points.slice(1)) param.exponentialRampToValueAtTime(Math.max(0.0001, v * k), t0 + dt);
}

// Шум через фильтр с меняющейся частотой: свисты, всасывание, гул, треск. Стерео: каналы
// шума разные — звук широкий, а не точка посередине
export function noise(ctx, bus, t0, { type = 'bandpass', freq = [1000, 1000], q = 1, gain = [[0, 0.0001], [0.01, 1], [0.3, 0.0001]], duration = 0.4, offset = Math.random() * 2, ...mix }) {
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
export function tone(ctx, bus, t0, { type = 'sine', freq = [120, 40], gain = [[0, 1], [0.3, 0.0001]], duration = 0.35, ...mix }) {
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
// ==========================================
// РЕЕСТР ЗВУКОВ СЦЕН
// ==========================================

const RECIPES = {};

/** Добавить звуки сцены: { имя: (ctx, bus, t0, options) => … } */
export function registerCues(recipes) {
    Object.assign(RECIPES, recipes);
}

/**
 * Сыграть звук в шине bus (createBus), начиная с момента t0 (секунды контекста).
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
 *  hush   — тишина перед репликой: хвосты обрываются, через duration звук возвращается.
 */
function busFx(name, { volume = 0.5, duration = 0.04 } = {}) {
    const state = liveBus(volume), { ctx, bus } = state, t = ctx.currentTime;
    if (FX.includes(name)) {
        state.fxUntil = t + duration + 0.03;
        fxRamp(bus.master.gain, name, t, { volume, duration });
    }
}

/** Огибающая эффекта шины на громкости master с момента t (стенд звука рисует ей ту же кривую) */
export function fxRamp(g, name, t, { volume = 0.5, duration = 0.04 } = {}) {
    const low = name === 'dip' ? 0.12 : 0.0001;
    g.cancelScheduledValues(t);
    g.setValueAtTime(volume, t);
    g.linearRampToValueAtTime(volume * low, t + (name === 'dip' ? 0.006 : 0.12));
    g.setValueAtTime(volume * low, t + duration);
    g.linearRampToValueAtTime(volume, t + duration + 0.02);
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
