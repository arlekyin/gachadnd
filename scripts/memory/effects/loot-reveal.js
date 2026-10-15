/**
 * Gacha Roguelike dnd5e — Выпадение кристаллов
 *
 * Добычу получают почти на каждом узле, поэтому зрелище — по редкости, и одно на всю добычу: по самому
 * редкому кристаллу (кристаллы всадников пока не в счёт).
 *  - серый, зелёный — ничего;
 *  - синий — отблеск на карточках в окне распределения (draft.js);
 *  - фиолетовый — вспышка цвета по краям экрана и звон;
 *  - красный — сцена у всех: экран темнеет, сверху падает звезда, удар, кристалл в лучах; окно
 *    распределения открывается после неё.
 * Мастер рассылает редкость и ждёт конца сцены у себя; у игроков она идёт по сообщению сокета.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket } from "../../core/socket.js";
import { stageCamera, shaker } from "../../cutscene/camera.js";
import { letterbox } from "../../cutscene/letterbox.js";
import { overlay } from "../../cutscene/overlay.js";
import { stowWindows } from "../../cutscene/windows.js";
import { clamp01, smooth, easeIn, easeOut, seeded } from "../../cutscene/math.js";
import { registerCues, playCue, tone, noise } from "../../cutscene/audio.js";
import { crackle, bass, slam, glass, flutter } from "../../cutscene/instruments.js";

const ORDER = ['gray', 'green', 'blue', 'purple', 'red'];
const COLORS = { blue: [0, 112, 221], purple: [163, 53, 238], red: [255, 0, 60] };
const CRYSTAL = new URL('../../../assets/icons/skills/red_fog_crystall.webp', import.meta.url).href;
// Красная сцена, мс: затемнение, падение звезды, удар, кристалл, уход
const T = { dim: 300, fall: 650, hit: 160, hold: 1100, out: 450 };
const PURPLE_MS = 700;

/** Самая редкая из выпавших (кристаллы всадников не в счёт) */
export function bestRarity(rarities) {
    return rarities.reduce((best, r) => ORDER.indexOf(r) > ORDER.indexOf(best) ? r : best, 'gray');
}

// ==========================================
// ЗВУКИ
// ==========================================

registerCues({
    // Фиолетовый: звон — высокие тона с обертонами и россыпь искр
    lootPurple(ctx, bus, t0) {
        for (const [f, g] of [[1320, 0.18], [1980, 0.1], [2640, 0.06]]) tone(ctx, bus, t0, { freq: [f, f * 0.98], gain: [[0, 0.0001], [0.01, g], [0.9, 0.0001]], duration: 0.95, send: 0.6 });
        crackle(ctx, bus, t0, { count: 18, spread: 0.35, level: 0.25, freq: [5000, 9000], send: 0.6 });
    },
    // Красный: нарастающий свист падения
    lootFall(ctx, bus, t0, { duration = 0.65 } = {}) {
        flutter(ctx, bus, t0, { freq: [700, 3200], q: 2, rate: [12, 30], level: 0.5, duration, send: 0.4 });
        bass(ctx, bus, t0, 'swell', { pitch: 1.1, level: 0.7, length: duration });
        noise(ctx, bus, t0, { type: 'highpass', freq: [1500, 4000], q: 0.7, gain: [[0, 0.0001], [duration, 0.3], [duration + 0.05, 0.0001]], duration: duration + 0.05, send: 0.3 });
    },
    // Красный: удар звезды и звон кристалла
    lootHit(ctx, bus, t0) {
        slam(ctx, bus, t0, { pitch: 0.9, body: 1.3, sub: 1.2, subLen: 1.2, rumble: 1, rumbleLen: 1.4, send: 0.6 });
        glass(ctx, bus, t0 + 0.03, { level: 0.35 });
        for (const [f, g] of [[880, 0.16], [1320, 0.1], [1760, 0.07]]) tone(ctx, bus, t0 + 0.05, { freq: [f, f], gain: [[0, 0.0001], [0.02, g], [1.6, 0.0001]], duration: 1.65, send: 0.7 });
    }
});

function cue(name, options = {}) {
    if (!game.settings.get(MODULE_ID, 'soundsEnabled')) return;
    playCue(name, { volume: game.settings.get(MODULE_ID, 'soundsVolume'), ...options });
}

// ==========================================
// ПОКАЗ
// ==========================================

/** Мастер: показать выпадение у всех и дождаться конца у себя */
export async function revealLoot(rarities) {
    const rarity = bestRarity(rarities.filter(r => ORDER.includes(r)));
    if (!['purple', 'red'].includes(rarity)) return;
    emit('lootReveal', { rarity });
    await playReveal(rarity);
}
onSocket('lootReveal', ({ rarity }) => playReveal(rarity));

let playing = false;

export function playReveal(rarity) {
    if (playing) return Promise.resolve(false);
    if (rarity === 'purple') return purpleFlash();
    if (rarity === 'red') return redStar();
    return Promise.resolve(false);
}

/** Фиолетовый: края экрана вспыхивают цветом и гаснут */
function purpleFlash() {
    playing = true;
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const [r, g, b] = COLORS.purple;
    const el = document.createElement('div');
    el.className = 'gd-impact gd-loot-edge';
    el.style.background = `radial-gradient(ellipse at center, rgba(${r}, ${g}, ${b}, 0) 45%, rgba(${r}, ${g}, ${b}, ${calm ? 0.25 : 0.55}) 100%)`;
    el.style.boxShadow = `inset 0 0 ${calm ? 40 : 90}px rgba(${r}, ${g}, ${b}, ${calm ? 0.4 : 0.8})`;
    document.body.append(el);
    cue('lootPurple');
    return new Promise(resolve => {
        const animation = el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: PURPLE_MS, easing: 'ease-out' });
        animation.onfinish = animation.oncancel = () => { el.remove(); playing = false; resolve(true); };
    });
}

let crystalImage = null;
function loadCrystal() {
    if (crystalImage) return Promise.resolve(crystalImage);
    return new Promise(resolve => {
        const img = new Image();
        // Фон картинки тёмный, но не чёрный: мягкая круглая маска убирает его края
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = c.height = 512;
            const g = c.getContext('2d');
            g.drawImage(img, 0, 0, 512, 512);
            const mask = g.createRadialGradient(256, 256, 120, 256, 256, 256);
            mask.addColorStop(0, 'rgba(0, 0, 0, 1)');
            mask.addColorStop(0.75, 'rgba(0, 0, 0, 0.6)');
            mask.addColorStop(1, 'rgba(0, 0, 0, 0)');
            g.globalCompositeOperation = 'destination-in';
            g.fillStyle = mask;
            g.fillRect(0, 0, 512, 512);
            resolve(crystalImage = c);
        };
        img.onerror = () => resolve(null);
        img.src = CRYSTAL;
    });
}

const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** Красный: падающая звезда, удар, кристалл в лучах */
async function redStar() {
    playing = true;
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const slow = Math.max(1, Number(game.settings.get(MODULE_ID, 'impactSlow')) || 1);
    const art = await loadCrystal();
    const restoreWindows = stowWindows();
    const cam = stageCamera();
    const bars = letterbox(0.1);
    const { ctx, W, H, remove } = overlay();
    const shake = shaker(20);
    const rnd = seeded(Math.floor(Math.random() * 1e6) + 1);
    const RED = COLORS.red, WHITE = [255, 230, 236];
    const sF = T.dim, sH = sF + T.fall, sC = sH + T.hit, sO = sC + T.hold, end = sO + T.out;
    const center = { x: W / 2, y: H * 0.47 }, start = { x: W * 0.82, y: -H * 0.1 };
    const rays = Array.from({ length: 14 }, () => ({ a: rnd() * Math.PI * 2, w: 0.04 + rnd() * 0.08, len: 0.35 + rnd() * 0.3, speed: (rnd() - 0.5) * 0.0004 }));
    const sparks = [];
    const cued = new Set();
    const once = (name, t, at, options) => { if (t >= at && !cued.has(name)) { cued.add(name); cue(name, options); } };

    return new Promise(resolve => {
        const t0 = performance.now();
        let lastT = 0, watchdog = null;
        const finish = () => {
            if (!playing) return;
            clearTimeout(watchdog);
            cam?.restore();
            bars.remove();
            remove();
            restoreWindows();
            playing = false;
            resolve(true);
        };
        // Сторож: кадры перестали идти — сцена не остаётся на экране
        const guard = () => {
            if (!playing) return;
            if (performance.now() - t0 > (end + 4000) * slow) return finish();
            watchdog = setTimeout(guard, 1000);
        };
        watchdog = setTimeout(guard, 1000);

        const frame = now => {
            if (!playing) return;
            try {
                const t = (now - t0) / slow, dt = Math.max(0, Math.min(50, t - lastT)) / 1000;
                lastT = t;
                if (t >= end) return finish();
                once('lootFall', t, sF, { duration: T.fall / 1000 * slow });
                once('lootHit', t, sH);
                if (t >= sH && !cued.has('kick')) {
                    cued.add('kick');
                    if (!calm) shake.kick(t, 26);
                    // Брызги от удара
                    for (let i = 0; i < (calm ? 30 : 90); i++) {
                        const a = rnd() * Math.PI * 2, v = (0.3 + rnd() * 0.7) * H;
                        sparks.push({ x: center.x, y: center.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.8, age: 0, life: 0.5 + rnd() * 0.9, size: 1.5 + rnd() * 2.5 });
                    }
                }
                const sh = shake.offset(t, 380);
                cam?.place({ k: 0, dx: sh.x, dy: sh.y });
                const dim = smooth(clamp01(t / T.dim)) * (1 - smooth(clamp01((t - sO) / T.out)));
                bars.show(dim);
                for (const p of sparks) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 2; p.vy = p.vy * (1 - dt * 2) + H * 0.25 * dt; }
                for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].age >= sparks[i].life) sparks.splice(i, 1);
                draw(t, dim);
            } catch (error) {
                console.error(`${MODULE_ID} | выпадение кристалла`, error);
                return finish();
            }
            requestAnimationFrame(frame);
        };

        const draw = (t, dim) => {
            const dpr = devicePixelRatio;
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = `rgba(6, 0, 2, ${0.72 * dim})`;
            ctx.fillRect(0, 0, W, H);
            ctx.globalCompositeOperation = 'lighter';

            // Падение: звезда с хвостом из угла в центр
            if (t >= sF && t < sH + 40) {
                const k = easeIn(clamp01((t - sF) / T.fall));
                const x = start.x + (center.x - start.x) * k, y = start.y + (center.y - start.y) * k;
                const tail = 0.18 + 0.25 * k;
                const tx = x - (center.x - start.x) * tail, ty = y - (center.y - start.y) * tail;
                for (const [w, a, col] of [[34, 0.08, RED], [14, 0.25, RED], [5, 0.8, WHITE]]) {
                    const grad = ctx.createLinearGradient(tx, ty, x, y);
                    grad.addColorStop(0, rgba(col, 0));
                    grad.addColorStop(1, rgba(col, a));
                    ctx.strokeStyle = grad;
                    ctx.lineWidth = w * dpr;
                    ctx.lineCap = 'round';
                    ctx.beginPath();
                    ctx.moveTo(tx, ty);
                    ctx.lineTo(x, y);
                    ctx.stroke();
                }
                const head = ctx.createRadialGradient(x, y, 0, x, y, H * 0.05);
                head.addColorStop(0, rgba(WHITE, 1));
                head.addColorStop(0.4, rgba(RED, 0.6));
                head.addColorStop(1, rgba(RED, 0));
                ctx.fillStyle = head;
                ctx.fillRect(x - H * 0.05, y - H * 0.05, H * 0.1, H * 0.1);
            }

            if (t >= sH) {
                const life = 1 - smooth(clamp01((t - sO) / T.out));
                // Лучи вокруг кристалла, медленно вращаются
                const grow = easeOut(clamp01((t - sH) / 300));
                for (const ray of rays) {
                    const a = ray.a + (t - sH) * ray.speed, len = H * ray.len * grow;
                    const grad = ctx.createLinearGradient(center.x, center.y, center.x + Math.cos(a) * len, center.y + Math.sin(a) * len);
                    grad.addColorStop(0, rgba(RED, 0.4 * life));
                    grad.addColorStop(1, rgba(RED, 0));
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.moveTo(center.x, center.y);
                    ctx.lineTo(center.x + Math.cos(a - ray.w) * len, center.y + Math.sin(a - ray.w) * len);
                    ctx.lineTo(center.x + Math.cos(a + ray.w) * len, center.y + Math.sin(a + ray.w) * len);
                    ctx.closePath();
                    ctx.fill();
                }
                // Ударная волна
                const wave = clamp01((t - sH) / 500);
                if (wave < 1) {
                    ctx.strokeStyle = rgba(RED, 0.7 * (1 - wave));
                    ctx.lineWidth = (10 * (1 - wave) + 1) * dpr;
                    ctx.beginPath();
                    ctx.arc(center.x, center.y, H * 0.6 * easeOut(wave), 0, Math.PI * 2);
                    ctx.stroke();
                }
                // Кристалл: дышит, слегка меняя размер
                if (art) {
                    const pop = easeOut(clamp01((t - sH) / 260));
                    const size = H * 0.42 * (0.6 + 0.4 * pop) * (1 + 0.02 * Math.sin(t * 0.006));
                    ctx.globalAlpha = life * pop;
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.drawImage(art, center.x - size / 2, center.y - size / 2, size, size);
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.globalAlpha = 1;
                }
                // Искры
                ctx.lineCap = 'round';
                for (const p of sparks) {
                    const a = 1 - p.age / p.life;
                    ctx.strokeStyle = rgba(p.size > 3 ? WHITE : RED, a * life);
                    ctx.lineWidth = p.size * dpr;
                    ctx.beginPath();
                    ctx.moveTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
                    ctx.lineTo(p.x, p.y);
                    ctx.stroke();
                }
            }
            ctx.globalCompositeOperation = 'source-over';

            // Удар: вспышка
            const flash = t >= sH ? 1 - clamp01((t - sH) / (T.hit + 200)) : 0;
            if (flash > 0) {
                ctx.fillStyle = rgba(calm ? [120, 0, 20] : [255, 210, 220], (calm ? 0.3 : 0.75) * flash * flash);
                ctx.fillRect(0, 0, W, H);
            }
        };
        requestAnimationFrame(frame);
    });
}
