/**
 * Gacha Roguelike dnd5e — Предвестия Пожирателя
 *
 * Мастер отсчитывает приход Пожирателя: за 3 хода — лёгкий холод, иней по краям экрана; за 2 — холод
 * сильнее, запах гнили и металла; за 1 — мир выцветает в мёртвую бирюзу (#006964 … #02fbf2, ближе
 * к тёмному); пришёл — по краям туман и размытие. Стадия — настройка мира: её видят все клиенты,
 * и она переживает перезагрузку и смену сцены.
 *
 * Всё рисует один шейдер поверх сцены Foundry: только поле, интерфейс остаётся чистым. Переходы
 * между стадиями плавные; в спокойном режиме (impactCalm) туман и иней не движутся.
 */

import { MODULE_ID } from "../core/constants.js";
import { stageFilter } from "../cutscene/stage.js";

export const OMEN_STAGES = {
    off: { label: 'Нет', frost: 0, tint: 0, fog: 0, blur: 0 },
    3: { label: '3', frost: 0.45, tint: 0, fog: 0, blur: 0, text: 'Лёгкий холод касается пальцев и покалывает кончики.' },
    2: { label: '2', frost: 0.85, tint: 0.12, fog: 0, blur: 0, text: 'Холод пробирает сильнее. В воздухе — запах гнили и металла.' },
    1: { label: '1', frost: 0.85, tint: 0.75, fog: 0.15, blur: 0, text: 'Цвета уходят из мира. Всё вокруг — мёртвая бирюза, как свет со дна.' },
    here: { label: 'Здесь', frost: 0.3, tint: 0.75, fog: 1, blur: 1, text: 'Ткань узла рвётся. Из тумана по краям мира выходит Пожиратель.' }
};
const ORDER = ['off', '3', '2', '1', 'here'];
const FADE_MS = 2500;

const SHADER = `
precision highp float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 inputSize;
uniform vec4 outputFrame;
uniform vec4 inputClamp;
uniform float uTime;
uniform float uFrost;
uniform float uTint;
uniform float uFog;
uniform float uBlur;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
}

void main() {
    // Координаты экрана 0…1 и расстояние от центра: 0 — центр, около 1 — середина края, 1.4 — угол
    vec2 uv = vTextureCoord * inputSize.xy / outputFrame.zw;
    float aspect = outputFrame.z / outputFrame.w;
    vec2 p = vec2(uv.x * aspect, uv.y);
    float e = length((uv - 0.5) * 2.0);
    vec4 color = texture2D(uSampler, vTextureCoord);

    // Размытие к краям: кольцо выборок, радиус растёт от центра
    float radius = uBlur * smoothstep(0.55, 1.3, e) * 14.0;
    if (radius > 0.5) {
        vec4 sum = color;
        for (int i = 0; i < 16; i++) {
            float a = float(i) * 0.3927 + 0.2;
            float r = radius * (i < 8 ? 1.0 : 0.5);
            sum += texture2D(uSampler, clamp(vTextureCoord + vec2(cos(a), sin(a)) * r * inputSize.zw, inputClamp.xy, inputClamp.zw));
        }
        color = sum / 17.0;
    }

    // Мёртвая бирюза: яркость → от почти чёрной глубины через #006964 к #02fbf2 только в бликах
    float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    vec3 teal = mix(vec3(0.0, 0.05, 0.05), vec3(0.0, 0.41, 0.39), smoothstep(0.0, 0.65, lum));
    teal = mix(teal, vec3(0.01, 0.98, 0.95), smoothstep(0.72, 1.0, lum) * 0.55);
    // Бирюза сильна у краёв и слабеет к центру: в центре мир только слегка зеленеет
    float radial = smoothstep(0.2, 1.15, e);
    vec3 greened = color.rgb * vec3(0.8, 1.0, 0.93) + vec3(0.0, 0.025, 0.02) * color.a;
    color.rgb = mix(color.rgb, mix(greened, teal * color.a, radial), uTint);

    // Иней: неровная кромка от всех краёв внутрь, толще в углах; холод слегка гасит цвета
    float edgeDist = min(min(uv.x, 1.0 - uv.x) * aspect, min(uv.y, 1.0 - uv.y));
    float crystals = fbm(p * 18.0 + 3.7);
    float veins = fbm(p * vec2(42.0, 9.0) + 1.3);
    float band = uFrost * (0.07 + 0.05 * smoothstep(0.9, 1.4, e)) * (1.0 + sin(uTime * 0.9) * 0.04);
    float reach = edgeDist + (crystals - 0.5) * band * 0.9;
    float frost = (1.0 - smoothstep(0.0, band, reach)) * step(0.001, uFrost);
    float rime = frost * frost * (0.35 + 0.65 * veins) * (0.45 + 0.4 * uFrost);
    float glint = smoothstep(0.86, 0.97, noise(p * 120.0 + uTime * 0.15)) * frost * frost;
    color.rgb = mix(color.rgb, mix(color.rgb, vec3(lum) * color.a, 0.25), uFrost * 0.35);
    color = mix(color, vec4(vec3(0.8, 0.92, 0.97) * (0.75 + 0.25 * crystals), 1.0), rime);
    color.rgb += glint * 0.4;

    // Туман: два медленных слоя навстречу друг другу, гуще к краям
    float f1 = fbm(p * 2.6 + vec2(uTime * 0.035, uTime * 0.012));
    float f2 = fbm(p * 4.1 - vec2(uTime * 0.02, -uTime * 0.03) + 7.3);
    float mist = smoothstep(0.35, 0.85, f1 * 0.6 + f2 * 0.5);
    float fog = uFog * clamp(smoothstep(0.35, 1.25, e) + 0.12, 0.0, 1.0) * mist;
    color = mix(color, vec4(vec3(0.42, 0.55, 0.55) * (0.7 + 0.3 * f2), 1.0), fog * 0.85);

    gl_FragColor = color;
}`;

export function registerOmenSettings() {
    game.settings.register(MODULE_ID, 'devourerOmen', {
        scope: 'world', config: false, type: String, default: 'off',
        onChange: value => { applyOmen(value); Hooks.callAll('gachadnd.omenChanged', value); }
    });
}

export function getOmen() {
    try {
        const value = String(game.settings.get(MODULE_ID, 'devourerOmen'));
        return OMEN_STAGES[value] ? value : 'off';
    } catch (err) {
        return 'off';
    }
}

/** Мастер ставит стадию: 'off', '3', '2', '1', 'here'. Игрокам — строка ощущений в чат */
export async function setOmen(stage) {
    if (!game.user.isGM) return ui.notifications.warn('Предвестия Пожирателя ставит Мастер.');
    stage = String(stage);
    if (!OMEN_STAGES[stage] || stage === getOmen()) return;
    await game.settings.set(MODULE_ID, 'devourerOmen', stage);
    const text = OMEN_STAGES[stage].text;
    if (text) await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Туман' }),
        content: `<div class="gd-scent-chat gd-omen-chat"><i class="fas fa-snowflake"></i> <em>${text}</em></div>`
    });
}

// ==========================================
// ШЕЙДЕР ПОВЕРХ СЦЕНЫ
// ==========================================

let state = null;

function ensureFilter() {
    if (!canvas?.ready || !canvas.stage || !globalThis.PIXI) return null;
    if (state && canvas.stage.filters?.includes(state.handle.filter)) return state;
    const filter = new PIXI.Filter(undefined, SHADER, { uTime: 0, uFrost: 0, uTint: 0, uFog: 0, uBlur: 0 });
    const handle = stageFilter(filter);
    const now = performance.now();
    state = { handle, from: { ...OMEN_STAGES.off }, to: { ...OMEN_STAGES.off }, start: now, born: now };
    const tick = () => {
        if (!state || state.handle.filter !== filter) return canvas.app.ticker.remove(tick);
        const t = performance.now();
        const k = Math.min(1, (t - state.start) / FADE_MS);
        const ease = k * k * (3 - 2 * k);
        const u = filter.uniforms;
        for (const key of ['frost', 'tint', 'fog', 'blur']) u[`u${key[0].toUpperCase()}${key.slice(1)}`] = state.from[key] + (state.to[key] - state.from[key]) * ease;
        // В спокойном режиме туман и иней стоят на месте
        if (!game.settings.get(MODULE_ID, 'impactCalm')) u.uTime = (t - state.born) / 1000;
        // Стадия ушла, переход закончен — фильтр снимается, сцена рисуется как обычно
        if (k >= 1 && ORDER.indexOf(state.target) <= 0) dropFilter();
    };
    state.tick = tick;
    canvas.app.ticker.add(tick);
    return state;
}

function dropFilter() {
    if (!state) return;
    canvas.app?.ticker.remove(state.tick);
    state.handle.remove();
    state = null;
}

/** Перейти к стадии плавно; instant — сразу (загрузка мира, смена сцены) */
function applyOmen(stage = getOmen(), { instant = false } = {}) {
    const target = OMEN_STAGES[stage] ?? OMEN_STAGES.off;
    if (stage === 'off' && !state) return;
    const s = ensureFilter();
    if (!s) return;
    const u = s.handle.filter.uniforms;
    // Переход начинается с того, что на экране сейчас, даже если прошлый ещё не закончился
    s.from = instant ? { ...target } : { frost: u.uFrost, tint: u.uTint, fog: u.uFog, blur: u.uBlur };
    s.to = { ...target };
    s.target = stage;
    s.start = performance.now();
}

// Сцена перерисована (загрузка мира, переход на другую сцену) — стадия возвращается без перехода
Hooks.on('canvasReady', () => {
    state = null;
    const stage = getOmen();
    if (stage !== 'off') applyOmen(stage, { instant: true });
});
Hooks.on('canvasTearDown', () => dropFilter());

export function nextOmen(stage = getOmen()) {
    return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(stage) + 1)];
}
