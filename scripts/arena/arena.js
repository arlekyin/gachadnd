/**
 * Генератор арен — сборка сцены Foundry (прототип; если понравится — станет отдельным модулем)
 *
 * Планировка (layout.js) → картинка (paint.js) → загрузка в мир → одна сцена «Арена» перестраивается на каждый бой:
 * фон, стены из планировки (стволы, валуны, руины, брёвна; кроны — ограниченный обзор), «живая муть» над водой и
 * в перелесках (тусклые тёмные источники с анимацией «призрак», как в готовых наборах), свет друз Тумана,
 * погода по настроению; ночью — настоящая темнота: светят только друзы Тумана и святилище, видит тёмное зрение;
 * вода, топь и подлесок — трудная местность (регионы dnd5e); отряд — у левой кромки, враги — строем у правой: ближний бой впереди, стрелки сзади,
 * вожак в глубине по центру; у Монстров стая иногда заходит с флангов.
 *
 * game.gachadnd.arena.generate({ seed, mood, cols, rows, party: [actorId…], enemies: [actorId…], encounter, weather })
 * weather — 'rain'|'fog'|'wind' (weather.js): ставится поверх готовой арены, снимается кнопкой Мастера
 * encounter: { node: 'mob'|'elite'|'outpost'|'boss', leader: actorId, ranged: 0–1 } — схему и строй выбирает по нему;
 * ranged без значения — по атакам врагов
 */

import { MODULE_ID } from "../core/constants.js";
import { layout, connected, startCells, passable, reachable, rng, ribbon, VIGNETTES } from "./layout.js";
import { paint } from "./paint.js";
import { applyWeather, WEATHER } from "./weather.js";

const CELL = 140;
const FLAG = 'arena';
// Цвет «живой мути» по настроению
const MURK = { day: '#0f2a24', night: '#0a1426', fog: '#1d2422', rot: '#062420', blood: '#3f0d0d' };
const MOOD_WEATHER = { fog: 'fog' };
const WALL = { NONE: 0, LIMITED: 10, NORMAL: 20 };
// Ночь: темнота сцены без общего света — светят только источники на поле (в футах)
const NIGHT = { darkness: 0.6, pulse: { dim: 25, bright: 10 }, crystal: { dim: 25, bright: 8 } };
// Трудная местность: регион на вид — тип dnd5e и цвет (виден Мастеру на слое регионов)
const TERRAIN = {
    water: { name: 'Вода', type: 'liquid', color: '#3a7fa8' },
    mire: { name: 'Топь', type: 'mud', color: '#6b5a2e' },
    brush: { name: 'Подлесок', type: 'plants', color: '#4f8a3a' }
};

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
    // Видимость — для игрока: стволы, камни, пни и брёвна держат только шаг (иначе поле в чёрных дырах и клиньях
    // теней); кроны нарисованы сверху и взгляд не режут. Крупное — «ограниченный обзор»: за ним не видно, а сам
    // предмет не чернеет (одну такую стену взгляд проходит). Сплошные стены — только у руин
    const solid = { move: WALL.NORMAL, sight: WALL.NORMAL, light: WALL.NORMAL, sound: WALL.NONE };
    const low = { move: WALL.NORMAL, sight: WALL.LIMITED, light: WALL.LIMITED, sound: WALL.NONE };
    const step = { move: WALL.NORMAL, sight: WALL.NONE, light: WALL.NONE, sound: WALL.NONE };
    for (const o of plan.objects) {
        const x = o.x * CELL, y = o.y * CELL, r = o.r * CELL;
        if (['tree', 'pine', 'deadtree'].includes(o.kind)) {
            ring(x, y, CELL * 0.28, 6, step);
        } else if (o.kind === 'boulder' || o.kind === 'pillar') ring(x, y, r * 0.8, 8, low);
        else if (o.kind === 'rock') ring(x, y, r * 0.75, 6, step);
        else if (o.kind === 'stump') ring(x, y, r * 0.8, 6, step);
        else if (o.kind === 'log') {
            const dx = Math.cos(o.rot) * r, dy = Math.sin(o.rot) * r;
            walls.push({ c: [x - dx, y - dy, x + dx, y + dy].map(Math.round), ...step });
        } else if (o.kind === 'vignette') {
            const v = VIGNETTES[o.name];
            // Мелкие круги (камни, очаг) и круг со светом внутри (святилище) держат только шаг, крупные — обзор
            for (const [cx, cy, r] of v.circles) ring(x + cx * CELL, y + cy * CELL, r * CELL, 8, r < 0.9 || v.lights.length ? step : low);
            for (const [cx, cy, w, h] of v.rects) {
                const x0 = x + (cx - w / 2) * CELL, y0 = y + (cy - h / 2) * CELL, x1 = x0 + w * CELL, y1 = y0 + h * CELL;
                for (const c of [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]]) walls.push({ c: c.map(Math.round), ...(v.flat ? step : low) });
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

/**
 * Дождаться, пока арена встанет на экран. Кто уже стоит на арене, у того пересборка перерисовывает её — и не раз:
 * смена фона, размера, погоды; большая картинка грузится 5–8 секунд, и всё это время на экране снимок прошлой арены
 * и полупрорисованные регионы. Готово — когда холст готов и полсекунды не начинает новой перерисовки
 */
async function settled(sceneId, limit = 30000) {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const t0 = Date.now();
    await sleep(300);
    while (Date.now() - t0 < limit) {
        if (canvas.scene?.id !== sceneId || !canvas.ready || canvas.loading) { await sleep(200); continue; }
        let started = false;
        const id = Hooks.once('canvasInit', () => { started = true; });
        await sleep(600);
        Hooks.off('canvasInit', id);
        if (!started && canvas.ready && !canvas.loading) return;
    }
}

/** Тропа и ручей арены для погоды (грязь, разлив): точки через одну, в сотых клетки — флаг сцены не пухнет */
function terrainOf(plan) {
    const pts = path => path.filter((_, i) => i % 2 === 0).map(p => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
    const { path, stream } = plan.terrain;
    return { path: pts(path), stream: stream ? { path: pts(stream.path), width: Math.round(stream.width * 100) / 100 } : null };
}

/** Стрелок: атак издали не меньше, чем вблизи (активности атаки dnd5e) */
function isRanged(actor) {
    let near = 0, far = 0;
    for (const item of actor?.items ?? []) for (const a of item.system?.activities?.contents ?? []) {
        if (a.type !== 'attack') continue;
        if (a.attack?.type?.value === 'ranged') far++;
        else near++;
    }
    return far > 0 && far >= near;
}

/**
 * Строй врагов: роль → клетки по порядку предпочтения. Ближний бой — в 4–7 клетках от правой кромки, стрелки —
 * у самой кромки, вожак — между ними по центру, фланг — у верхнего и нижнего края на 55–72% ширины.
 * Только клетки, до которых отряд доходит
 */
function formation(plan) {
    const { cols, rows } = plan, cy = (plan.zones.enemies.y0 + plan.zones.enemies.y1) / 2;
    const reach = [...reachable(plan)].map(k => k.split(',').map(Number)).map(([x, y]) => ({ x, y }));
    const band = (x0, x1, tx, ty) => reach.filter(c => c.x >= x0 && c.x <= x1).sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty));
    const fx0 = Math.round(cols * 0.55), fx1 = Math.round(cols * 0.72), fx = (fx0 + fx1) / 2;
    return {
        melee: band(cols - 7, cols - 4, cols - 5.5, cy),
        ranged: band(cols - 3, cols - 1, cols - 1.5, cy),
        leader: band(cols - 4, cols - 2, cols - 3, cy),
        flankTop: band(fx0, fx1, fx, 1.5),
        flankBottom: band(fx0, fx1, fx, rows - 2.5),
        // Запас — вся правая половина, от кромки к центру
        any: band(Math.floor(cols / 2), cols - 1, cols - 2, cy)
    };
}

/**
 * Трудная местность: вода ручья (лента вдоль русла), топь озерец, подлесок — кусты и камыш. По региону на вид, форм
 * сколько угодно; поведение — «Трудная местность» dnd5e (тип учитывает, кто его не замечает), без dnd5e — двойная цена
 */
function regionsOf(plan) {
    const px = v => Math.round(v * CELL);
    const circle = (x, y, r) => ({ type: 'circle', x: px(x), y: px(y), radius: px(r) });
    const shapes = { water: [], mire: [], brush: [] };
    const { stream, pools = [] } = plan.terrain;
    if (stream) shapes.water.push({ type: 'polygon', points: ribbon(stream.path, stream.width).map(px) });
    // По мосту — сухо: прямоугольник моста вырезан из воды
    for (const b of plan.objects.filter(o => o.kind === 'vignette' && o.name === 'bridge')) if (stream) shapes.water.push({
        type: 'rectangle', x: px(b.x), y: px(b.y), width: px(b.w * 0.8), height: px(b.h), anchorX: 0.5, anchorY: 0.5, rotation: Math.toDegrees ? Math.toDegrees(b.rot ?? 0) : ((b.rot ?? 0) * 180) / Math.PI, hole: true
    });
    for (const p of pools) shapes.mire.push(circle(p.x, p.y, p.r * 0.9));
    for (const o of plan.objects) if (o.kind === 'bush' || o.kind === 'reeds') shapes.brush.push(circle(o.x, o.y, Math.max(0.5, o.r)));
    const dnd = !!CONFIG.RegionBehavior?.dataModels?.['dnd5e.difficultTerrain'];
    return Object.entries(shapes).filter(([, list]) => list.length).map(([kind, list]) => ({
        // Заперт: на слое регионов (он открывается и при шаблоне заклинания в v14) не показывается, правило работает
        name: TERRAIN[kind].name, color: TERRAIN[kind].color, shapes: list, locked: true,
        behaviors: [dnd
            ? { name: 'Трудная местность', type: 'dnd5e.difficultTerrain', system: { types: [TERRAIN[kind].type] } }
            : { name: 'Трудная местность', type: 'modifyMovementCost', system: { difficulties: Object.fromEntries(Object.keys(CONFIG.Token.movement?.actions ?? { walk: 1 }).map(a => [a, 2])) } }],
        flags: { [MODULE_ID]: { terrain: kind } }
    }));
}

/** Свет: «живая муть» в перелесках, друзы Тумана (над водой свет пока не ставим — вылезал за края сцены) */
function lightsOf(plan, mood) {
    const lights = [], night = mood === 'night';
    const murk = (x, y, dim) => night || lights.push({
        x: Math.round(x * CELL), y: Math.round(y * CELL), walls: true,
        config: { dim, bright: 0, color: MURK[mood] ?? MURK.day, alpha: 0.5, luminosity: 0.5, attenuation: 0.5, coloration: 1, animation: { type: 'ghost', speed: 3, intensity: 3 } }
    });
    for (const p of plan.terrain.patches.filter(p => p.type === 'forest')) if (p.x > 0 && p.y > 0 && p.x < plan.cols && p.y < plan.rows) murk(p.x, p.y, p.r * 4);
    for (const o of plan.objects.filter(o => o.kind === 'vignette')) for (const l of VIGNETTES[o.name].lights) lights.push({
        x: Math.round((o.x + l.x) * CELL), y: Math.round((o.y + l.y) * CELL), walls: true,
        config: { dim: night ? NIGHT[l.animation]?.dim ?? l.dim : l.dim, bright: night ? NIGHT[l.animation]?.bright ?? l.bright : l.bright, color: l.color, alpha: 0.5, luminosity: 0.5, attenuation: 0.6, coloration: 1, animation: { type: l.animation, speed: 3, intensity: 4 } }
    });
    for (const o of plan.objects.filter(o => o.kind === 'crystal')) lights.push({
        x: Math.round(o.x * CELL), y: Math.round(o.y * CELL), walls: true,
        config: { dim: night ? NIGHT.crystal.dim : 10, bright: night ? NIGHT.crystal.bright : 3, color: '#2ee6d6', alpha: 0.45, luminosity: 0.5, attenuation: 0.6, coloration: 1, animation: { type: 'pulse', speed: 2, intensity: 3 } }
    });
    return lights;
}

/**
 * Собрать арену: новая планировка, картинка, сцена, стены, свет, токены. Только Мастер.
 * @returns {Promise<{ scene, plan }>}
 */
export async function generateArena({ seed = foundry.utils.randomID(8), mood = 'day', biome = 'forest', cols = 28, rows = 20, encounter = {}, party = [], enemies = [], view = true, scheme = null, weather = null } = {}) {
    if (!game.user.isGM) return ui.notifications.warn('Арену собирает Мастер.');
    // Планировка: если путь от отряда к врагам перекрыт — другой сид
    const art = await loadArt(biome);
    const foes = enemies.map(id => game.actors.get(id)).filter(Boolean);
    encounter = { ...encounter, ranged: encounter.ranged ?? (foes.length ? foes.filter(isRanged).length / foes.length : undefined) };
    const vignettes = Object.keys(VIGNETTES).filter(n => art[`vignette-${n}-1`] || art[`vignette-${n}`]);
    const night = mood === 'night';
    let plan = layout({ cols, rows, seed, biome, encounter, vignettes, scheme, night });
    for (let i = 1; i < 8 && !connected(plan); i++) plan = layout({ cols, rows, seed: `${seed}-${i}`, biome, encounter, vignettes, scheme, night });
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
        background: { src }, tokenVision: true, weather: MOOD_WEATHER[mood] ?? '',
        environment: mood === 'night' ? { darknessLevel: NIGHT.darkness, globalLight: { enabled: false } } : { darknessLevel: 0, globalLight: { enabled: true } },
        [`flags.${MODULE_ID}.${FLAG}`]: { seed: plan.seed, mood, biome, cols, rows, scheme: plan.scheme, node: encounter.node ?? null, terrain: terrainOf(plan) }
    };
    // v14 держит фон в уровне сцены. Уровень — раньше сцены: смена фона уровня сама перерисовывает арену у всех, кто
    // на ней, и тогда перерисовка одна — уже с новым фоном (сцена следом меняет только флаги и погоду)
    const setLevel = async scene => {
        const level = scene.levels?.contents?.[0];
        if (level && level.background?.src !== src) await level.update({ 'background.src': src });
    };
    let scene = game.scenes.find(s => s.getFlag(MODULE_ID, FLAG));
    const viewing = !!scene && canvas.scene?.id === scene.id;
    if (scene) {
        await scene.deleteEmbeddedDocuments('Wall', scene.walls.map(w => w.id));
        await scene.deleteEmbeddedDocuments('AmbientLight', scene.lights.map(l => l.id));
        await scene.deleteEmbeddedDocuments('Token', scene.tokens.map(t => t.id));
        await scene.deleteEmbeddedDocuments('Region', scene.regions.map(r => r.id));
        await scene.deleteEmbeddedDocuments('Tile', scene.tiles.filter(t => t.getFlag(MODULE_ID, 'weather')).map(t => t.id));
        await setLevel(scene);
        // Погода прошлого боя не переходит в новый
        await scene.update({ ...data, [`flags.${MODULE_ID}.-=arenaWeather`]: null });
    } else {
        scene = await Scene.create(foundry.utils.expandObject(data));
        await setLevel(scene);
    }

    await scene.createEmbeddedDocuments('Wall', wallsOf(plan));
    await scene.createEmbeddedDocuments('AmbientLight', lightsOf(plan, mood));
    await scene.createEmbeddedDocuments('Region', regionsOf(plan));
    if (WEATHER[weather]) await applyWeather(scene, weather, { seed: plan.seed });

    // Токены. Существо крупнее клетки занимает w×w клеток: место — где все они проходимы и свободны, иначе большие
    // токены налезают друг на друга
    const open = passable(plan), taken = new Set();
    const fits = (x, y, w) => {
        for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) if (!open[y + dy]?.[x + dx] || taken.has(`${x + dx},${y + dy}`)) return false;
        return true;
    };
    const tokenAt = async (actor, cells) => {
        const w = Math.max(1, Math.round(actor.prototypeToken?.width || 1));
        const cell = cells.find(c => fits(c.x, c.y, w));
        if (!cell) return null;
        for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) taken.add(`${cell.x + dx},${cell.y + dy}`);
        return (await actor.getTokenDocument({ x: cell.x * CELL, y: cell.y * CELL })).toObject();
    };
    const tokens = [];
    // Отряд — у левой кромки
    const partyCells = startCells(plan, 'party', plan.cols * plan.rows);
    for (const actor of party.map(id => game.actors.get(id)).filter(Boolean)) {
        const t = await tokenAt(actor, partyCells);
        if (t) tokens.push(t);
    }
    // Враги — строем: вожак, стрелки, ближний бой; у Монстров от трёх бойцов ближнего боя — треть заходит с флангов
    const cells = formation(plan), R = rng(`${plan.seed}|formation`);
    const roles = foes.map((actor, i) => ({ actor, role: encounter.leader && actor.id === encounter.leader && !foes.slice(0, i).some(a => a.id === actor.id) ? 'leader' : isRanged(actor) ? 'ranged' : 'melee' }));
    const melee = roles.filter(r => r.role === 'melee');
    const flank = encounter.node === 'mob' && melee.length >= 3 && R() < 0.4;
    if (flank) melee.slice(-Math.max(1, Math.floor(melee.length / 3))).forEach((r, i) => { r.role = i % 2 ? 'flankBottom' : 'flankTop'; });
    const order = { leader: 0, ranged: 1, melee: 2, flankTop: 3, flankBottom: 3 };
    for (const { actor, role } of roles.sort((a, b) => order[a.role] - order[b.role])) {
        const t = await tokenAt(actor, cells[role]) ?? await tokenAt(actor, cells.any);
        if (t) tokens.push(t);
    }
    if (tokens.length) await scene.createEmbeddedDocuments('Token', tokens);
    plan.formation = { flank, roles: roles.map(r => r.role) };
    // Бой начинается уже на новой картинке
    if (!viewing && view) await scene.view();
    if (viewing || view) await settled(scene.id);
    return { scene, plan };
}

Hooks.once('ready', () => {
    game.gachadnd = Object.assign(game.gachadnd ?? {}, { arena: { generate: generateArena, layout } });
});
