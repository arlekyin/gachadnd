/**
 * Катсцены — инструменты синтеза: атака, треск, бас разных видов, тяжёлый удар, треск стекла,
 * рвущийся свист. Строятся из кирпичей audio.js; звуки сцен собираются из них.
 */

import { noise, tone, route, envelope, noiseBuffer } from "./audio.js";

export function click(ctx, bus, t0, level = 1, freq = 3500, send = 0.15) {
    noise(ctx, bus, t0, { type: 'highpass', freq: [freq, freq], q: 0.7, gain: [[0, level], [0.012, 0.0001]], duration: 0.015, send });
}

// Треск: россыпь коротких щелчков по всей панораме — электричество, обломки
export function crackle(ctx, bus, t0, { count = 40, spread = 0.4, level = 0.5, freq = [2500, 6000], send = 0.35 } = {}) {
    for (let i = 0; i < count; i++) {
        const t = t0 + Math.random() ** 1.6 * spread;
        const f = freq[0] + Math.random() * (freq[1] - freq[0]);
        noise(ctx, bus, t, {
            type: 'bandpass', freq: [f, f * 0.8], q: 4, duration: 0.02, send, pan: (Math.random() - 0.5) * 1.6,
            gain: [[0, level * (0.3 + Math.random() * 0.7)], [0.004 + Math.random() * 0.012, 0.0001]]
        });
    }
}

// Бас у каждого этапа свой — чтобы удары не звучали одним и тем же гулом:
//  kick  — короткий упругий толчок, тон падает за доли секунды, без хвоста (кулаки 1–4);
//  drop  — толчок и долгий суббас, падающий глубоко вниз (касание, пятый кулак);
//  swell — нарастающий гул без удара, тон поднимается (кинополосы, вдох);
//  thud  — грязный глухой удар шумом, без тона, коротко (приземление).
// Всё — через басовую шину с гармониками: на динамиках ноутбука бас тоже слышен
export function bass(ctx, bus, t0, kind, { pitch = 1, level = 1, length = 1 } = {}) {
    if (kind === 'kick') {
        tone(ctx, bus, t0, { freq: [230 * pitch, 58 * pitch], gain: [[0, 1.4 * level], [0.09, 0.0001]], duration: 0.1, deep: true, send: 0.04 });
        tone(ctx, bus, t0, { freq: [95 * pitch, 52 * pitch], gain: [[0, 0.9 * level], [length * 0.22, 0.0001]], duration: length * 0.22 + 0.03, deep: true, send: 0.03 });
    } else if (kind === 'drop') {
        tone(ctx, bus, t0, { freq: [170 * pitch, 40 * pitch], gain: [[0, 1.5 * level], [0.15, 0.0001]], duration: 0.16, deep: true, send: 0.05 });
        tone(ctx, bus, t0 + 0.004, { freq: [78 * pitch, 22], gain: [[0, 0.0001], [0.015, level], [length * 0.4, level * 0.7], [length, 0.0001]], duration: length + 0.05, deep: true, send: 0.1 });
    } else if (kind === 'swell') {
        tone(ctx, bus, t0, { freq: [30 * pitch, 52 * pitch], gain: [[0, 0.0001], [length * 0.85, level], [length, 0.0001]], duration: length + 0.02, deep: true, send: 0.2 });
    } else if (kind === 'thud') {
        noise(ctx, bus, t0, { type: 'lowpass', freq: [260 * pitch, 60], q: 2.5, gain: [[0, 2.2 * level], [length, 0.0001]], duration: length + 0.03, deep: true, send: 0.03 });
    }
}

// Тяжёлый удар: атака, тело с падающим тоном через перегруз, суббас, раскат по сторонам
export function slam(ctx, bus, t0, { pitch = 1, body = 1.4, sub = 1.1, subLen = 1.1, rumble = 1.1, rumbleLen = 1.5, send = 0.5 } = {}) {
    click(ctx, bus, t0, 1.3, 2800 * pitch);
    tone(ctx, bus, t0, { freq: [170 * pitch, 42 * pitch], gain: [[0, body], [0.5, 0.0001]], duration: 0.55, driven: true, send: send * 0.6 });
    bass(ctx, bus, t0, 'drop', { pitch, level: sub, length: subLen });
    for (const pan of [-0.55, 0.55]) {
        noise(ctx, bus, t0, { type: 'lowpass', freq: [4200, 110], q: 0.5, gain: [[0, rumble * 0.7], [0.03, rumble * 0.8], [rumbleLen, 0.0001]], duration: rumbleLen + 0.05, pan, send });
    }
}

// Треск стекла в духе файтингов: не звон, а короткий сухой хлёсткий «кш-ш». Зажатый жёстким
// перегрузом треск, плотная россыпь хруста за 0,1 с и металлический призвук (частотная модуляция
// с некратным соотношением — «дзынь» без ноты), почти без хвоста
export function glass(ctx, bus, t0, { level = 0.35, pan = 0 } = {}) {
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
export function flutter(ctx, bus, t0, { freq = [2000, 400], q = 1.8, rate = [34, 14], level = 1, duration = 0.4, pan = 0, send = 0.3 } = {}) {
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
