/**
 * Gacha Roguelike dnd5e — Счётчик ауры: картинка и звук (у каждого клиента)
 *
 *   - над токеном с аурой — пять ромбов: золотые — аура, красные — долг; вокруг — кольцо по порогу;
 *   - изменение ауры — «+1000 aura» / «−1000 aura» над токеном, при росте — волна;
 *   - долг −5 — печальный тромбон;
 *   - аура 5 — тема героя (файл из настроек или синтез) и волна раз в 6 секунд до 15 футов:
 *     видно, докуда достаёт страх. В спокойном режиме волн по таймеру нет.
 * Всё строится по флагу персонажа: изменения приходят обычным updateActor.
 */

import { MODULE_ID } from "../../core/constants.js";
import { registerCues, playCue, tone, noise, duckScene } from "../../cutscene/audio.js";
import { MAX, MIN, auraOf, auraText } from "./aura.js";

const PULSE_MS = 6000;
const PULSE_FT = 15;
const BAR = 2.4;
const GOLD = 0xffd34d;
const RED = 0xe0453a;

const setting = (key, fallback) => { try { return game.settings.get(MODULE_ID, key) ?? fallback; } catch (error) { return fallback; } };
const calm = () => !!setting('impactCalm', false);
const sound = (name, options = {}) => {
    if (!setting('soundsEnabled', false)) return;
    playCue(name, { volume: setting('soundsVolume', 0.5), ...options });
};

export function registerAuraSettings() {
    game.settings.register(MODULE_ID, 'auraTheme', {
        name: 'Тема героя (Счётчик ауры)',
        hint: 'Музыка, которая играет, пока аура персонажа на максимуме. Пусто — встроенный синтезированный бит.',
        scope: 'world', config: true, type: String, filePicker: 'audio', default: ''
    });
    game.settings.register(MODULE_ID, 'auraMusicVolume', {
        name: 'Громкость темы героя',
        hint: '0 — тема не играет у вас.',
        scope: 'client', config: true, type: Number, range: { min: 0, max: 1, step: 0.05 }, default: 0.35,
        onChange: () => { stopTheme(); refresh(); }
    });
}

// ==========================================
// ЗВУКИ
// ==========================================

// Бит темы: такт 4/4, 100 ударов в минуту; бас — ми минор
const RIFF = [82.41, 82.41, 98, 110, 82.41, 123.47, 110, 98];
registerCues({
    auraUp(ctx, bus, t0) {
        for (const [n, f] of [392, 587, 784].entries()) tone(ctx, bus, t0 + n * 0.05, { type: 'triangle', freq: [f, f], gain: [[0, 0.18], [0.35, 0.0001]], duration: 0.4, send: 0.5 });
    },
    auraDown(ctx, bus, t0) {
        tone(ctx, bus, t0, { type: 'sine', freq: [330, 165], gain: [[0, 0.2], [0.4, 0.0001]], duration: 0.45, send: 0.3 });
    },
    // Тромбон «ва-ва-ва-ваа»: долг дошёл до −5
    auraShame(ctx, bus, t0) {
        for (const [n, f] of [233.08, 220, 207.65].entries()) tone(ctx, bus, t0 + n * 0.32, { type: 'sawtooth', freq: [f, f * 0.98], gain: [[0, 0.0001], [0.03, 0.12], [0.26, 0.0001]], duration: 0.3, send: 0.2 });
        tone(ctx, bus, t0 + 0.96, { type: 'sawtooth', freq: [196, 180], gain: [[0, 0.0001], [0.04, 0.13], [0.9, 0.0001]], duration: 1, send: 0.3 });
    },
    auraBeat(ctx, bus, t0) {
        const beat = BAR / 4, eighth = beat / 2;
        for (let i = 0; i < 4; i++) {
            const t = t0 + i * beat;
            if (i % 2 === 0) tone(ctx, bus, t, { type: 'sine', freq: [140, 42], gain: [[0, 0.55], [0.28, 0.0001]], duration: 0.3, send: 0.05 });
            else noise(ctx, bus, t, { type: 'bandpass', freq: [1800, 1400], q: 0.8, gain: [[0, 0.0001], [0.005, 0.22], [0.16, 0.0001]], duration: 0.18 });
        }
        for (let i = 0; i < 8; i++) {
            const t = t0 + i * eighth;
            noise(ctx, bus, t, { type: 'highpass', freq: [7000, 7000], gain: [[0, 0.0001], [0.003, i % 2 ? 0.05 : 0.08], [0.05, 0.0001]], duration: 0.06 });
            const f = RIFF[i];
            tone(ctx, bus, t, { type: 'sawtooth', freq: [f, f], gain: [[0, 0.0001], [0.01, 0.07], [eighth * 0.9, 0.0001]], duration: eighth, send: 0.1 });
        }
    }
});

let theme = null;

function startTheme() {
    const volume = Number(setting('auraMusicVolume', 0.35));
    if (theme || !(volume > 0)) return;
    theme = { restore: duckScene(0.35, 800, 1200) };
    const src = setting('auraTheme', '');
    if (src) {
        const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
        const state = theme;
        Promise.resolve(helper?.play({ src, volume, autoplay: true, loop: true }, false)).then(music => {
            if (theme === state) state.music = music;
            else music?.stop?.();
        }).catch(error => console.warn(`${MODULE_ID} | тема героя`, error));
    } else {
        const bar = () => playCue('auraBeat', { volume });
        bar();
        theme.timer = setInterval(bar, BAR * 1000);
    }
    window.gachadndAuraTheme = true;
}

function stopTheme() {
    if (!theme) return;
    clearInterval(theme.timer);
    const music = theme.music;
    if (music) {
        try { music.fade?.(0, { duration: 900 }); } catch { /* уже остановлена */ }
        setTimeout(() => { try { music.stop?.(); } catch { /* уже остановлена */ } }, music.fade ? 1000 : 0);
    }
    theme.restore?.();
    theme = null;
    window.gachadndAuraTheme = false;
}

// ==========================================
// КАРТИНКА
// ==========================================

const layer = () => canvas?.interface ?? null;
const overlays = new Map();   // tokenId → { box, gems, ring, value }
const waves = [];
let lastPulse = 0;
let ticking = false;

/** Ромбы и кольцо над токеном */
function drawOverlay(entry, value) {
    const { gems, ring, token } = entry;
    const size = canvas.grid.size;
    const step = Math.max(16, size * 0.3), r = step * 0.42;
    gems.clear();
    const color = value < 0 ? RED : GOLD;
    for (let i = 0; i < MAX; i++) {
        const x = (i - (MAX - 1) / 2) * step;
        const lit = i < Math.abs(value);
        gems.lineStyle(2, lit ? 0x2a1200 : 0xffffff, lit ? 0.9 : 0.5).beginFill(lit ? color : 0x000000, lit ? 1 : 0.45);
        gems.drawPolygon([x, -r, x + r, 0, x, r, x - r, 0]).endFill();
    }
    ring.clear();
    const level = Math.abs(value);
    if (level >= 2) {
        const radius = Math.max(token.w, token.h) / 2 + 4;
        ring.lineStyle(level >= 4 ? 4 : 2, color, level >= 5 ? 0.9 : level >= 4 ? 0.7 : 0.45).drawCircle(0, 0, radius);
    }
    entry.value = value;
}

function place(entry) {
    const { token, box, gems } = entry;
    const center = token.center;
    box.position.set(center.x, center.y);
    gems.position.set(0, -token.h / 2 - Math.max(16, canvas.grid.size * 0.3) * 0.7);
    box.visible = token.visible !== false;
}

/** Пересобрать, у каких токенов есть аура */
export function refresh() {
    const parent = layer();
    if (!parent || !canvas.tokens) return;
    const seen = new Set();
    let hero = false;
    for (const token of canvas.tokens.placeables ?? []) {
        const state = auraOf(token.actor);
        if (!state) continue;
        const value = state.value;
        const id = token.document.id;
        seen.add(id);
        let entry = overlays.get(id);
        if (!entry || entry.box.destroyed || entry.token !== token) {
            entry?.box.destroy({ children: true });
            const box = new PIXI.Container();
            const ring = box.addChild(new PIXI.Graphics()), gems = box.addChild(new PIXI.Graphics());
            box.eventMode = 'none';
            parent.addChild(box);
            entry = { box, ring, gems, token, value: null };
            overlays.set(id, entry);
        }
        if (entry.value !== value) drawOverlay(entry, value);
        place(entry);
        if (value >= MAX && token.visible !== false) hero = true;
    }
    for (const [id, entry] of overlays) {
        if (seen.has(id)) continue;
        entry.box.destroy({ children: true });
        overlays.delete(id);
    }
    if (hero) startTheme(); else stopTheme();
    ensureTicker();
}

/** Волна от токена до 15 футов */
export function pulse(token, strong = false) {
    const parent = layer();
    if (!parent || !token) return;
    const g = new PIXI.Graphics();
    g.eventMode = 'none';
    parent.addChild(g);
    const from = Math.max(token.w, token.h) / 2;
    const to = from + PULSE_FT / (canvas.scene?.grid?.distance ?? canvas.dimensions?.distance ?? 5) * canvas.grid.size;
    waves.push({ g, token, from, to, start: performance.now(), duration: strong ? 1600 : 1200, width: strong ? 6 : 4 });
    window.gachadndAuraWaves = (window.gachadndAuraWaves ?? 0) + 1;
    ensureTicker();
}

function frame() {
    const now = performance.now();
    for (const entry of overlays.values()) if (!entry.box.destroyed) place(entry);
    for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i];
        const t = Math.min(1, (now - w.start) / w.duration);
        if (t >= 1 || w.g.destroyed || !w.g.parent) {
            if (!w.g.destroyed) w.g.destroy();
            waves.splice(i, 1);
            continue;
        }
        const ease = 1 - (1 - t) ** 3;
        const c = w.token.center;
        w.g.clear().lineStyle(w.width * (1 - t * 0.6), GOLD, 0.85 * (1 - t)).drawCircle(c.x, c.y, w.from + (w.to - w.from) * ease);
    }
    // Аура 5: волна по таймеру
    if (!calm() && now - lastPulse >= PULSE_MS) {
        let any = false;
        for (const entry of overlays.values()) {
            if (entry.value >= MAX && entry.token.visible !== false) { pulse(entry.token, true); any = true; }
        }
        if (any) lastPulse = now;
    }
    if (!overlays.size && !waves.length) stopTicker();
}

function ensureTicker() {
    const ticker = canvas?.app?.ticker;
    if (ticking || !ticker || (!overlays.size && !waves.length)) return;
    ticker.add(frame);
    ticking = true;
}
function stopTicker() {
    canvas?.app?.ticker?.remove(frame);
    ticking = false;
}

// ==========================================
// ПОДПИСКИ
// ==========================================

const shown = new Map();   // actorId → отметка последнего показанного изменения

function float(token, delta) {
    const up = delta > 0;
    const top = CONST.TEXT_ANCHOR_POINTS?.TOP ?? 2;
    canvas.interface?.createScrollingText?.(token.center, auraText(delta), {
        anchor: top, direction: top, fontSize: 30, fill: up ? '#ffd34d' : '#9aa0a6', stroke: '#000000', strokeThickness: 5,
        jitter: 0.15, duration: 2200, distance: canvas.grid.size
    });
}

Hooks.on('updateActor', (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.aura`)) return;
    const last = actor.getFlag(MODULE_ID, 'aura')?.last;
    if (last?.at && shown.get(actor.id) !== last.at) {
        shown.set(actor.id, last.at);
        const token = actor.getActiveTokens?.()[0];
        if (token && last.delta) {
            float(token, last.delta);
            if (last.delta > 0) { pulse(token); sound('auraUp'); }
            else if (actor.getFlag(MODULE_ID, 'aura')?.value <= MIN && actor.getFlag(MODULE_ID, 'aura')?.active) sound('auraShame');
            else sound('auraDown');
        }
    }
    refresh();
});
// Сцена закрывается: картинка ауры уходит вместе с ней
Hooks.on('canvasTearDown', () => {
    for (const entry of overlays.values()) if (!entry.box.destroyed) entry.box.destroy({ children: true });
    for (const w of waves) if (!w.g.destroyed) w.g.destroy();
    overlays.clear();
    waves.length = 0;
    stopTicker();
});
Hooks.on('canvasReady', () => refresh());
Hooks.on('createToken', () => refresh());
Hooks.on('deleteToken', () => refresh());
Hooks.on('updateToken', () => refresh());
