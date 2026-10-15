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

import { tone, noise, registerCues } from "../../cutscene/audio.js";
import { click, crackle, bass, slam, glass, flutter } from "../../cutscene/instruments.js";

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


// ==========================================
// ЗВУКИ МОМЕНТОВ
// ==========================================

const RECIPES = {
    // Кинополосы: низкий короткий удар-заставка, как начало сцены в кино
    bars(ctx, bus, t0) {
        bass(ctx, bus, t0, 'swell', { pitch: 1, level: 0.9, length: 0.5 });
        bass(ctx, bus, t0 + 0.5, 'kick', { pitch: 0.6, level: 0.7, length: 0.8 });
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
        // Напряжение: гул тянется вверх и обрывается вместе со вдохом
        tone(ctx, bus, t0, { freq: [32, 64], gain: [[0, 0.0001], [duration * 0.95, 0.7], [duration + 0.015, 0.0001]], duration: duration + 0.02, deep: true, send: 0.1 });
    },
    // Рывок: свист проходит слева направо и затихает за ~60 мс до касания — перед ударом тишина
    lunge(ctx, bus, t0) {
        noise(ctx, bus, t0, { type: 'bandpass', freq: [700, 3500], q: 2, gain: [[0, 0.0001], [0.09, 0.8], [0.14, 0.0001]], duration: 0.16, pan: -0.3, send: 0.25 });
        noise(ctx, bus, t0 + 0.02, { type: 'bandpass', freq: [900, 4200], q: 2, gain: [[0, 0.0001], [0.08, 0.6], [0.12, 0.0001]], duration: 0.14, pan: 0.4, send: 0.25 });
    },
    // Касание: самый тяжёлый удар — ниже и дольше обычного, с глухим толчком, мощным суббасом
    // и вторым раскатом через 70 мс (эхо взрыва); треск молний по всей панораме, звон в ушах
    contact(ctx, bus, t0) {
        // Хвост баса кончается к первому кулаку: дальше бас — у самих кулаков
        slam(ctx, bus, t0, { pitch: 0.8, body: 1.8, sub: 1.6, subLen: 0.55, rumble: 1.3, rumbleLen: 0.9, send: 0.65 });
        // Толчок: плотный низ середины, через перегруз
        noise(ctx, bus, t0, { type: 'lowpass', freq: [450, 140], q: 1.2, gain: [[0, 1.6], [0.25, 0.0001]], duration: 0.28, driven: true, send: 0.3 });
        // Эхо взрыва
        for (const pan of [-0.7, 0.7]) noise(ctx, bus, t0 + 0.07, { type: 'lowpass', freq: [1500, 90], q: 0.6, gain: [[0, 0.0001], [0.03, 0.9], [0.6, 0.0001]], duration: 0.65, pan, send: 0.5 });
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
        bass(ctx, bus, t0, 'kick', { pitch: k * 1.1, level: 1.3, length: 0.6 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [380 * k, 120], q: 1.1, gain: [[0, 1.1], [0.16, 0.0001]], duration: 0.18, driven: true, pan: pan * 0.5, send: 0.2 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [2600 * k, 300], q: 0.6, gain: [[0, 0.8], [0.26, 0.0001]], duration: 0.28, pan, send: 0.4 });
        glass(ctx, bus, t0 + 0.004, { level: 0.3, pan });
    },
    // Пятый кулак: тяжёлый удар и стекло громче — экран трескается по-настоящему
    punchFinal(ctx, bus, t0) {
        // Самый глубокий бас — ниже касания; кончается к началу полёта
        slam(ctx, bus, t0, { pitch: 0.65, body: 1.7, sub: 1.5, subLen: 0.5, rumble: 1.1, rumbleLen: 0.6, send: 0.55 });
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
        bass(ctx, bus, t0, 'thud', { pitch: 1, level: 1, length: 0.35 });
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

registerCues(RECIPES);

// Для проверки звуков отрисовкой в файл
export { renderCue, createBus } from "../../cutscene/audio.js";
