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
import { layout, connected, startCells } from "./layout.js";
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
        } else if (o.kind === 'ruin') {
            // Как в paint.js: стена вдоль оси и вторая — поперёк, от угла
            const t = CELL * 0.62, len = (o.len ?? 3) * CELL, c = Math.cos(o.rot), s = Math.sin(o.rot);
            const at = (u, v) => [x + u * c - v * s, y + u * s + v * c];
            walls.push({ c: [...at(-t / 2, 0), ...at(len - t / 2, 0)].map(Math.round), ...solid });
            walls.push({ c: [...at(0, -t / 2), ...at(0, len * 0.75 - t / 2)].map(Math.round), ...solid });
        }
    }
    return walls;
}

/** Свет: «живая муть» над водой и в перелесках, друзы Тумана */
function lightsOf(plan, mood) {
    const lights = [];
    const murk = (x, y, dim) => lights.push({
        x: Math.round(x * CELL), y: Math.round(y * CELL), walls: true,
        config: { dim, bright: 0, color: MURK[mood] ?? MURK.day, alpha: 0.5, luminosity: 0.5, attenuation: 0.5, coloration: 1, animation: { type: 'ghost', speed: 3, intensity: 3 } }
    });
    const s = plan.terrain.stream;
    if (s) s.path.forEach((p, i) => { if (i % 6 === 0 && p.x > 0 && p.y > 0 && p.x < plan.cols && p.y < plan.rows) murk(p.x, p.y, 6 + s.width * 2); });
    for (const p of plan.terrain.patches.filter(p => p.type === 'forest')) if (p.x > 0 && p.y > 0 && p.x < plan.cols && p.y < plan.rows) murk(p.x, p.y, p.r * 4);
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
export async function generateArena({ seed = foundry.utils.randomID(8), mood = 'day', biome = 'forest', cols = 28, rows = 20, encounter = {}, party = [], enemies = [], view = true } = {}) {
    if (!game.user.isGM) return ui.notifications.warn('Арену собирает Мастер.');
    // Планировка: если путь от отряда к врагам перекрыт — другой сид
    let plan = layout({ cols, rows, seed, biome, encounter });
    for (let i = 1; i < 8 && !connected(plan); i++) plan = layout({ cols, rows, seed: `${seed}-${i}`, biome, encounter });

    const art = await loadArt(biome);
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
        name: 'Арена', width: cols * CELL, height: rows * CELL, padding: 0.05,
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

    // Токены: отряд у левой кромки, враги у правой
    const place = async (ids, side) => {
        const actors = ids.map(id => game.actors.get(id)).filter(Boolean);
        const cells = startCells(plan, side, actors.length);
        const tokens = [];
        for (const [i, actor] of actors.entries()) {
            const cell = cells[i]; if (!cell) break;
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
