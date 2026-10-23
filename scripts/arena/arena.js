/**
 * Генератор арен — сборка сцены Foundry (прототип; если понравится — станет отдельным модулем)
 *
 * Планировка (layout.js) → картинка (paint.js) → загрузка в мир → одна сцена «Арена» перестраивается на каждый бой:
 * фон, стены из планировки (стволы, валуны, руины, брёвна; кроны — ограниченный обзор), «живая муть» над водой и
 * в перелесках (тусклые тёмные источники с анимацией «призрак», как в готовых наборах), свет друз Тумана,
 * погода по настроению; отряд — у левой кромки, враги — у правой.
 *
 * game.gachadnd.arena.generate({ seed, mood, cols, rows, party: [actorId…], enemies: [actorId…], encounter })
 */

import { MODULE_ID } from "../core/constants.js";
import { layout, connected, startCells, passable, VIGNETTES } from "./layout.js";
import { paint } from "./paint.js";

const CELL = 140;
const FLAG = 'arena';
// Цвет «живой мути» по настроению
const MURK = { day: '#0f2a24', night: '#0a1426', fog: '#1d2422', rot: '#062420', blood: '#3f0d0d' };
const WEATHER = { fog: 'fog' };
const WALL = { NONE: 0, LIMITED: 10, NORMAL: 20 };

const filePicker = () => foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;

/** Готовые картинки биома: assets/battlemap/<биом>/<имя>.png|webp — имя без расширения */
async function loadArt(biome) {
    const art = {};
    try {
        const { files } = await filePicker().browse('data', `modules/${MODULE_ID}/assets/battlemap/${biome}`);
        await Promise.all(files.filter(f => /\.(png|webp|jpe?g)$/i.test(f)).map(src => new Promise(resolve => {
            const img = new Image();
            img.onload = () => { art[src.split('/').pop().replace(/\.[^.]+$/, '')] = img; resolve(); };
            img.onerror = resolve;
            img.src = src;
        })));
    } catch (err) { /* папки ещё нет — рисуем заглушки */ }
    return art;
}

/** Стены из планировки: в пикселях сцены */
function wallsOf(plan) {
    const walls = [];
    const ring = (x, y, r, n, flags) => {
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
            walls.push({ c: [x + Math.cos(a) * r, y + Math.sin(a) * r, x + Math.cos(b) * r, y + Math.sin(b) * r].map(v => Math.round(v)), ...flags });
        }
    };
    const solid = { move: WALL.NORMAL, sight: WALL.NORMAL, light: WALL.NORMAL, sound: WALL.NONE };
    const low = { move: WALL.NORMAL, sight: WALL.LIMITED, light: WALL.LIMITED, sound: WALL.NONE };
    const canopy = { move: WALL.NONE, sight: WALL.LIMITED, light: WALL.NONE, sound: WALL.NONE };
    for (const o of plan.objects) {
        const x = o.x * CELL, y = o.y * CELL, r = o.r * CELL;
        if (['tree', 'pine', 'deadtree'].includes(o.kind)) {
            ring(x, y, CELL * 0.28, 6, solid);
            if (o.kind !== 'deadtree') ring(x, y, r * 0.72, 10, canopy);
        } else if (o.kind === 'boulder' || o.kind === 'pillar') ring(x, y, r * 0.8, 8, solid);
        else if (o.kind === 'rock') ring(x, y, r * 0.75, 6, low);
        else if (o.kind === 'stump') ring(x, y, r * 0.8, 6, { ...low, sight: WALL.NONE, light: WALL.NONE });
        else if (o.kind === 'log') {
            const dx = Math.cos(o.rot) * r, dy = Math.sin(o.rot) * r;
            walls.push({ c: [x - dx, y - dy, x + dx, y + dy].map(Math.round), ...low });
        } else if (o.kind === 'vignette') {
            const v = VIGNETTES[o.name];
            for (const [cx, cy, r] of v.circles) ring(x + cx * CELL, y + cy * CELL, r * CELL, 8, solid);
            for (const [cx, cy, w, h] of v.rects) {
                const x0 = x + (cx - w / 2) * CELL, y0 = y + (cy - h / 2) * CELL, x1 = x0 + w * CELL, y1 = y0 + h * CELL;
                for (const c of [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]]) walls.push({ c: c.map(Math.round), ...low });
            }
        } else if (o.kind === 'ruin') {
            // Как в paint.js: стена вдоль оси и вторая — поперёк, от угла
            const t = CELL * 0.62, len = (o.len ?? 3) * CELL, c = Math.cos(o.rot), s = Math.sin(o.rot);
            const at = (u, v) => [x + u * c - v * s, y + u * s + v * c];
            walls.push({ c: [...at(-t / 2, 0), ...at(len - t / 2, 0)].map(Math.round), ...solid });
            if (o.shape !== 'I') walls.push({ c: [...at(0, -t / 2), ...at(0, len * 0.75 - t / 2)].map(Math.round), ...solid });
        }
    }
    return walls;
}

/** Свет: «живая муть» в перелесках, друзы Тумана (над водой свет пока не ставим — вылезал за края сцены) */
function lightsOf(plan, mood) {
    const lights = [];
    const murk = (x, y, dim) => lights.push({
        x: Math.round(x * CELL), y: Math.round(y * CELL), walls: true,
        config: { dim, bright: 0, color: MURK[mood] ?? MURK.day, alpha: 0.5, luminosity: 0.5, attenuation: 0.5, coloration: 1, animation: { type: 'ghost', speed: 3, intensity: 3 } }
    });
    for (const p of plan.terrain.patches.filter(p => p.type === 'forest')) if (p.x > 0 && p.y > 0 && p.x < plan.cols && p.y < plan.rows) murk(p.x, p.y, p.r * 4);
    for (const o of plan.objects.filter(o => o.kind === 'vignette')) for (const l of VIGNETTES[o.name].lights) lights.push({
        x: Math.round((o.x + l.x) * CELL), y: Math.round((o.y + l.y) * CELL), walls: true,
        config: { dim: l.dim, bright: l.bright, color: l.color, alpha: 0.5, luminosity: 0.5, attenuation: 0.6, coloration: 1, animation: { type: l.animation, speed: 3, intensity: 4 } }
    });
    for (const o of plan.objects.filter(o => o.kind === 'crystal')) lights.push({
        x: Math.round(o.x * CELL), y: Math.round(o.y * CELL), walls: true,
        config: { dim: 10, bright: 3, color: '#2ee6d6', alpha: 0.45, luminosity: 0.5, attenuation: 0.6, coloration: 1, animation: { type: 'pulse', speed: 2, intensity: 3 } }
    });
    return lights;
}

/**
 * Собрать арену: новая планировка, картинка, сцена, стены, свет, токены. Только Мастер.
 * @returns {Promise<{ scene, plan }>}
 */
export async function generateArena({ seed = foundry.utils.randomID(8), mood = 'day', biome = 'forest', cols = 28, rows = 20, encounter = {}, party = [], enemies = [], view = true, scheme = null } = {}) {
    if (!game.user.isGM) return ui.notifications.warn('Арену собирает Мастер.');
    // Планировка: если путь от отряда к врагам перекрыт — другой сид
    const art = await loadArt(biome);
    const vignettes = Object.keys(VIGNETTES).filter(n => art[`vignette-${n}-1`] || art[`vignette-${n}`]);
    let plan = layout({ cols, rows, seed, biome, encounter, vignettes, scheme });
    for (let i = 1; i < 8 && !connected(plan); i++) plan = layout({ cols, rows, seed: `${seed}-${i}`, biome, encounter, vignettes, scheme });
    const canvas = paint(plan, { cell: CELL, mood, art });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
    const dir = `worlds/${game.world.id}/gachadnd-arena`;
    const FP = filePicker();
    await FP.createDirectory('data', dir).catch(() => {});
    const name = `arena-${plan.seed}-${mood}.webp`;
    await FP.upload('data', dir, new File([blob], name, { type: 'image/webp' }), {}, { notify: false });
    const src = `${dir}/${name}`;

    // Одна сцена «Арена» — перестраивается на каждый бой, мир не пухнет
    const data = {
        name: 'Арена', width: cols * CELL, height: rows * CELL, padding: 0,
        grid: { size: CELL, distance: 5, units: 'ft', type: 1, alpha: 0.12 },
        background: { src }, tokenVision: true, weather: WEATHER[mood] ?? '',
        environment: { darknessLevel: 0, globalLight: { enabled: true } },
        [`flags.${MODULE_ID}.${FLAG}`]: { seed: plan.seed, mood, biome, cols, rows }
    };
    let scene = game.scenes.find(s => s.getFlag(MODULE_ID, FLAG));
    if (scene) {
        await scene.deleteEmbeddedDocuments('Wall', scene.walls.map(w => w.id));
        await scene.deleteEmbeddedDocuments('AmbientLight', scene.lights.map(l => l.id));
        await scene.deleteEmbeddedDocuments('Token', scene.tokens.map(t => t.id));
        await scene.update(data);
    } else scene = await Scene.create(foundry.utils.expandObject(data));
    // v14 держит фон в уровне сцены — подстраховка, если поле background не перенеслось
    const level = scene.levels?.contents?.[0];
    if (level && level.background?.src !== src) await level.update({ 'background.src': src });

    await scene.createEmbeddedDocuments('Wall', wallsOf(plan));
    await scene.createEmbeddedDocuments('AmbientLight', lightsOf(plan, mood));

    // Токены: отряд у левой кромки, враги у правой. Существо крупнее клетки занимает w×w клеток: место — где все
    // они проходимы и свободны, иначе большие токены налезают друг на друга
    const open = passable(plan), taken = new Set();
    const fits = (x, y, w) => {
        for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) if (!open[y + dy]?.[x + dx] || taken.has(`${x + dx},${y + dy}`)) return false;
        return true;
    };
    const place = async (ids, side) => {
        const actors = ids.map(id => game.actors.get(id)).filter(Boolean);
        const cells = startCells(plan, side, plan.cols * plan.rows);
        const tokens = [];
        for (const actor of actors) {
            const w = Math.max(1, Math.round(actor.prototypeToken?.width || 1));
            const cell = cells.find(c => fits(c.x, c.y, w));
            if (!cell) break;
            for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) taken.add(`${cell.x + dx},${cell.y + dy}`);
            const t = await actor.getTokenDocument({ x: cell.x * CELL, y: cell.y * CELL });
            tokens.push(t.toObject());
        }
        if (tokens.length) await scene.createEmbeddedDocuments('Token', tokens);
    };
    await place(party, 'party');
    await place(enemies, 'enemies');
    if (view) await scene.view();
    return { scene, plan };
}

Hooks.once('ready', () => {
    game.gachadnd = Object.assign(game.gachadnd ?? {}, { arena: { generate: generateArena, layout } });
});
