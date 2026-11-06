/**
 * Gacha Roguelike dnd5e — Звуки паутины: синтез на лету (Web Audio), без файлов
 *
 * Тон — приглушённая латунь, дерево и Туман: гул астролябии, глухие стуки узлов, шелест нитей, порывы фонаря;
 * Пожиратель — болезнь: плывущий стон, бульканье гнили, провал в инфразвук. Звучит только у того, кто видит слой; громкость —
 * «Звуки интерфейса» Foundry, выключается настройкой «Звуки паутины».
 *
 * Каждая функция строит граф из генераторов и огибающих: play(ctx, out, t) — тот же граф рисует и
 * tools/sound/render.mjs (OfflineAudioContext) в файлы для прослушивания.
 */


const MODULE_ID = 'gachadnd';

let shared = null;
/** Общий контекст и выход; null — звук выключен или недоступен */
function output() {
    try {
        if (!game.settings.get(MODULE_ID, 'webSounds')) return null;
        const volume = Number(game.settings.get('core', 'globalInterfaceVolume') ?? 0.5);
        if (!(volume > 0)) return null;
        shared ??= (() => { const ctx = new AudioContext(); const out = ctx.createGain(); out.connect(ctx.destination); return { ctx, out }; })();
        if (shared.ctx.state === 'suspended') shared.ctx.resume();
        shared.out.gain.value = volume * 0.9;
        return shared;
    } catch (err) {
        return null;
    }
}

// ---------- Кирпичики

const env = (ctx, node, t, { a = 0.005, peak = 1, d = 0.3, hold = 0 }) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.setValueAtTime(Math.max(0.0002, peak), t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
    node.connect(g);
    return g;
};

const noiseBuffers = new WeakMap();
function noise(ctx, seconds) {
    let buffer = noiseBuffers.get(ctx);
    if (!buffer) {
        buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        // Розовый шум: мягче белого, ближе к шороху
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < data.length; i++) {
            const w = Math.random() * 2 - 1;
            b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056;
            data[i] = (b0 + b1 + b2 + w * 0.05) * 1.8;
        }
        noiseBuffers.set(ctx, buffer);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopEnd = Math.min(3, seconds + 0.1);
    return src;
}

const osc = (ctx, type, freq) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; return o; };
const filter = (ctx, type, freq, q = 0.7) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; };
const run = (nodes, t, len) => nodes.forEach(n => { n.start(t); n.stop(t + len); });

/** Металл/стекло: негармонические призвуки, как у колокольчика или латунного кольца */
function bell(ctx, out, t, { freq, ratios = [1, 2.76, 5.4, 8.93], decay = 1.2, peak = 0.2, type = 'sine' }) {
    const nodes = [];
    ratios.forEach((r, i) => {
        const o = osc(ctx, type, freq * r);
        env(ctx, o, t, { a: 0.002, peak: peak / (i + 1) ** 1.2, d: decay / (1 + i * 0.6) }).connect(out);
        nodes.push(o);
    });
    run(nodes, t, decay + 0.1);
}

/** Шорох: шум через полосовой фильтр, частота скользит from → to */
function whoosh(ctx, out, t, { from, to, len, peak = 0.3, q = 1.2, a = 0.25 }) {
    const n = noise(ctx, len);
    const f = filter(ctx, 'bandpass', from, q);
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + len);
    n.connect(f);
    env(ctx, f, t, { a: len * a, peak, d: len * (1 - a) }).connect(out);
    run([n], t, len + 0.05);
}

// ---------- Звуки

/** Глухой удар: короткий тон, падающий вниз, через фильтр — дерево, латунный штифт, кожа */
function knock(ctx, out, t, { freq, drop = 0.6, len = 0.12, peak = 0.15, cutoff = 900, click = 0.04 }) {
    const o = osc(ctx, 'triangle', freq);
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * drop, t + len);
    const lp = filter(ctx, 'lowpass', cutoff, 0.8);
    o.connect(lp);
    env(ctx, lp, t, { a: 0.002, peak, d: len }).connect(out);
    run([o], t, len + 0.05);
    if (click) whoosh(ctx, out, t, { from: 1600, to: 1200, len: 0.025, peak: click, q: 0.9, a: 0.1 });
}

/** Приглушённый гонг: негармонические призвуки, но низко и через фильтр — латунь за стеной Тумана */
function gong(ctx, out, t, { freq, decay = 2, peak = 0.1 }) {
    const lp = filter(ctx, 'lowpass', freq * 4, 0.5);
    lp.connect(out);
    bell(ctx, lp, t, { freq, decay, peak, ratios: [1, 1.48, 2.32, 3.1] });
}

export const SOUNDS = {
    /** Слой открывается: Туман наползает (шорох снизу вверх), под ним гул латуни и далёкий глухой гонг */
    open(ctx, out, t) {
        whoosh(ctx, out, t, { from: 140, to: 900, len: 1.4, peak: 0.3, q: 0.5, a: 0.45 });
        const lp = filter(ctx, 'lowpass', 220, 0.9);
        const drone = [osc(ctx, 'sawtooth', 55), osc(ctx, 'sawtooth', 55.5), osc(ctx, 'triangle', 41.2)];
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.8);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
        drone.forEach(o => o.connect(lp));
        lp.connect(g).connect(out);
        run(drone, t, 2.9);
        gong(ctx, out, t + 0.4, { freq: 82.4, decay: 2.4, peak: 0.14 });
    },
    /** Слой закрывается: шорох уходит вниз, гул тает, глухой гонг издалека */
    close(ctx, out, t) {
        whoosh(ctx, out, t + 0.2, { from: 900, to: 140, len: 1.3, peak: 0.24, q: 0.5, a: 0.3 });
        gong(ctx, out, t, { freq: 73.4, decay: 1.6, peak: 0.09 });
    },
    /** Босс набрал ступень: глубокий удар в грудь и долгий тёмный гул латуни */
    stage(ctx, out, t) {
        const sub = osc(ctx, 'sine', 62);
        sub.frequency.setValueAtTime(62, t);
        sub.frequency.exponentialRampToValueAtTime(30, t + 0.8);
        env(ctx, sub, t, { a: 0.008, peak: 0.45, d: 1.1 }).connect(out);
        run([sub], t, 1.2);
        knock(ctx, out, t, { freq: 90, drop: 0.5, len: 0.25, peak: 0.25, cutoff: 400, click: 0.05 });
        gong(ctx, out, t + 0.05, { freq: 55, decay: 2.6, peak: 0.16 });
    },
    /** Узел встаёт на место: тихий глухой стук штифта о латунь, чуть разной высоты */
    pop(ctx, out, t, k = Math.random()) {
        knock(ctx, out, t, { freq: 240 + k * 120, len: 0.08, peak: 0.1, cutoff: 700, click: 0.025 });
    },
    /** Нити протягиваются: шелест ткани и натянутой нити, без блеска */
    threads(ctx, out, t) {
        whoosh(ctx, out, t, { from: 350, to: 1300, len: 1.0, peak: 0.22, q: 0.9, a: 0.55 });
        const o = osc(ctx, 'triangle', 110);
        o.frequency.linearRampToValueAtTime(116, t + 1);
        const lp = filter(ctx, 'lowpass', 500);
        o.connect(lp);
        env(ctx, lp, t + 0.2, { a: 0.4, peak: 0.05, d: 0.8 }).connect(out);
        run([o], t + 0.2, 1.3);
    },
    /** Наведение: едва слышный короткий стук — палец по латуни */
    hover(ctx, out, t) {
        knock(ctx, out, t, { freq: 420, drop: 0.8, len: 0.035, peak: 0.07, cutoff: 1200, click: 0.018 });
    },
    /** Выбор узла: тёплый щипок низкой струны и отзвук латуни */
    select(ctx, out, t) {
        knock(ctx, out, t, { freq: 196, drop: 0.98, len: 0.5, peak: 0.16, cutoff: 1100, click: 0.03 });
        gong(ctx, out, t + 0.02, { freq: 146.8, decay: 0.8, peak: 0.05 });
    },
    /** Шаг фонаря по нити: мягкий порыв и глухой стук на каждом узле, в конце — низкий гонг */
    step(ctx, out, t, legs = 1) {
        for (let i = 0; i < legs; i++) {
            const at = t + i * 0.42;
            whoosh(ctx, out, at, { from: 220, to: 700, len: 0.4, peak: 0.16, q: 1, a: 0.5 });
            knock(ctx, out, at + 0.38, { freq: 130, drop: 0.5, len: 0.18, peak: 0.2, cutoff: 500, click: 0.02 });
        }
        gong(ctx, out, t + legs * 0.42, { freq: 110, decay: 1.4, peak: 0.08 });
    },
    /** Нельзя: глухой стук по латуни */
    denied(ctx, out, t) {
        knock(ctx, out, t, { freq: 165, drop: 0.65, len: 0.14, peak: 0.2, cutoff: 600, click: 0.04 });
    },
    /**
     * Пожиратель поглощает узел — болезнь: низкий стон, который плывёт и бьётся сам о себя (два голоса
     * в полутоне), под ним — влажное бульканье гнили и провал в инфразвук; сверху — треск рвущейся ткани узла.
     * Никакого звона: всё глухое, тянется и тает долго.
     */
    bite(ctx, out, t) {
        const len = 2.6;
        // Ограничитель: болезнь давит, но не рвёт динамики
        const limit = ctx.createDynamicsCompressor();
        limit.threshold.value = -18; limit.ratio.value = 16; limit.attack.value = 0.001; limit.release.value = 0.3;
        const trim = ctx.createGain();
        trim.gain.value = 0.55;
        limit.connect(trim).connect(out);
        out = limit;
        // Провал вниз — удар в грудь
        const sub = osc(ctx, 'sine', 70);
        sub.frequency.setValueAtTime(70, t);
        sub.frequency.exponentialRampToValueAtTime(24, t + 0.9);
        env(ctx, sub, t, { a: 0.01, peak: 0.42, d: 1.1 }).connect(out);
        // Стон: два пилообразных голоса в полутоне — биения; формант ползёт вниз, вибрато неровное
        const groan = ctx.createGain();
        const formant = filter(ctx, 'bandpass', 520, 4);
        formant.frequency.setValueAtTime(520, t);
        formant.frequency.exponentialRampToValueAtTime(180, t + len);
        const voices = [osc(ctx, 'sawtooth', 73.4), osc(ctx, 'sawtooth', 77.8), osc(ctx, 'sawtooth', 36.7)];
        const wobble = osc(ctx, 'sine', 4.3), wobble2 = osc(ctx, 'sine', 0.7), wd = ctx.createGain(), wd2 = ctx.createGain();
        wd.gain.value = 3.5; wd2.gain.value = 6;
        wobble.connect(wd); wobble2.connect(wd2);
        voices.forEach(v => {
            wd.connect(v.frequency); wd2.connect(v.frequency);
            v.frequency.setValueAtTime(v.frequency.value, t);
            v.frequency.exponentialRampToValueAtTime(v.frequency.value * 0.82, t + len);
            v.connect(formant);
        });
        formant.connect(groan);
        env(ctx, groan, t + 0.05, { a: 0.35, peak: 0.5, d: len - 0.4 }).connect(out);
        // Бульканье гнили: шум через резонансный фильтр, частоту которого дёргает неровный пульс
        const n = noise(ctx, len);
        const gurgle = filter(ctx, 'lowpass', 260, 8);
        const pulse = osc(ctx, 'square', 7.5), pulse2 = osc(ctx, 'sine', 2.1), pd = ctx.createGain(), pd2 = ctx.createGain();
        pd.gain.value = 90; pd2.gain.value = 45;
        pulse.connect(pd).connect(gurgle.frequency); pulse2.connect(pd2).connect(gurgle.frequency);
        pulse.frequency.setValueAtTime(7.5, t);
        pulse.frequency.linearRampToValueAtTime(3.5, t + len);
        n.connect(gurgle);
        env(ctx, gurgle, t + 0.1, { a: 0.3, peak: 0.16, d: len - 0.3 }).connect(out);
        // Треск рвущейся ткани: редкие короткие сухие щелчки в первые полсекунды
        for (let i = 0; i < 9; i++) {
            const at = t + 0.02 + Math.random() * 0.55;
            whoosh(ctx, out, at, { from: 700 + Math.random() * 900, to: 400, len: 0.015 + Math.random() * 0.02, peak: 0.05 + Math.random() * 0.05, q: 2, a: 0.05 });
        }
        run([sub, ...voices, wobble, wobble2, n, pulse, pulse2], t, len + 0.1);
    }
};

/** Сыграть звук паутины (если включены); throttle — не чаще раза в N мс для одного имени */
const last = new Map();
export function playWeb(name, arg, { throttle = 0 } = {}) {
    const now = performance.now();
    if (throttle && now - (last.get(name) ?? -1e9) < throttle) return;
    last.set(name, now);
    const io = output();
    if (!io) return;
    try { SOUNDS[name]?.(io.ctx, io.out, io.ctx.currentTime + 0.01, arg); } catch (err) { console.warn(`gachadnd | звук паутины`, err); }
}
