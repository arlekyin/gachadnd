/**
 * Gacha Roguelike dnd5e — Встречи на боевых узлах (docs/quickstart.md, «Бой на узле»)
 *
 * Отряд вошёл на узел Монстры, Элита, Застава или Босс — Мастеру шёпот с готовой встречей: монстры SRD
 * (компендиум dnd5e.monsters, есть у каждого стола) по бюджету опыта dnd5e 2024 (CONFIG.DND5E.ENCOUNTER_DIFFICULTY,
 * на каждого героя по его уровню) и по биому этажа. Сила: Монстры — средняя, Элита — тяжёлая, Застава — тяжёлая
 * на уровень отряда + 1, Босс — тяжёлая с запасом и вожаком.
 *
 * Состав — из одной стаи биома (болотная нежить, пауки, разбойники…): у Элиты, Заставы и Босса сначала вожак
 * (самый сильный, кто влезает в долю бюджета), остальное — рядовыми по весам строк. Стаи — случайные таблицы
 * «Встречи: <биом>: <стая>»: из компендиума модуля (src/tables/encounters.yaml), а таблица мира с тем же названием
 * её заменяет, новая — добавляет стаю. Строка — монстр (SRD, свой актёр мира или из другого компендиума)
 * или текст с именем монстра SRD.
 *
 * Кнопки: «На арену» — генератор арен (arena/arena.js) строит поле по узлу и состоянию этажа (arenaFor): размер
 * и схема — по узлу, настроение — по порче узла, ступеням Босса и биому, враги — строем; «На эту сцену» —
 * враги в нескольких клетках от отряда; «Другой состав»; «Сам» — модуль ничего не ставит. Монстры
 * импортируются в мир один раз (папка «Лабиринт: монстры») и ставятся отдельными токенами. Бой создаётся
 * с участниками, начинает его и бросает инициативу Мастер. Шёпот — отключаемая подсказка hintEncounters.
 */

import { MODULE_ID } from "../core/constants.js";
import { hint } from "../core/prefs.js";
import { onRenderChatMessage } from "../core/chat-hooks.js";
import { partyActors } from "./horsemen.js";
import { BIOMES, currentBiome } from "./biomes.js";
import { getFloor } from "./economy.js";
import { mapScene } from "./scene-travel.js";
import { webStage, isEaten, touchedSet } from "./web-graph.js";

const PACK = 'dnd5e.monsters';
const TABLES = `${MODULE_ID}.gacha-tables`;
const PREFIX = 'Встречи';
const FOLDER = 'Лабиринт: монстры';
// Сила встречи по узлу: столбец бюджета (0 — низкая, 1 — средняя, 2 — тяжёлая), запас, прибавка уровня,
// доля бюджета на вожака (0 — без вожака)
const NODES = {
    mob: { label: 'Монстры', tier: 1, scale: 1, plus: 0, leader: 0, name: 'средняя' },
    elite: { label: 'Элита', tier: 2, scale: 1, plus: 0, leader: 0.5, name: 'тяжёлая' },
    outpost: { label: 'Застава', tier: 2, scale: 1, plus: 1, leader: 0.5, name: 'тяжёлая, на уровень выше' },
    boss: { label: 'Босс', tier: 2, scale: 1.25, plus: 0, leader: 0.6, name: 'тяжёлая с запасом' }
};
// Погода на арене: доля боёв узла под погодой (Монстры — никогда, рядовой бой остаётся быстрым)
const WEATHER_CHANCE = { mob: 0, elite: 0.5, outpost: 1, boss: 1 };
const WEATHER_NAMES = { rain: 'ливень', fog: 'туман Предела', wind: 'ветер' };
// Арена по узлу: размер в клетках (крупнее бой — шире поле)
const ARENA_SIZE = { mob: [24, 18], elite: [28, 20], outpost: [28, 20], boss: [30, 22] };
const SCHEME_NAMES = { glade: 'поляна', edge: 'опушка', thicket: 'чаща', swamp: 'топь', ruins: 'руины', crossing: 'переправа', hill: 'холм' };
const MOOD_NAMES = { day: 'день', night: 'ночь', fog: 'туман', rot: 'порча', blood: 'кровь' };
const FRACTION_XP = { 0: 10, 0.125: 25, 0.25: 50, 0.5: 100 };
export const xpOfCr = cr => (cr < 1 ? FRACTION_XP[cr] ?? 10 : CONFIG.DND5E.CR_EXP_LEVELS?.[cr] ?? 0);
const levelOf = actor => Math.max(1, Number(actor?.system?.details?.level) || 1);

/** Бюджет опыта встречи на отряд для узла */
export function budgetFor(type, party = partyActors()) {
    const node = NODES[type];
    if (!node) return 0;
    const table = CONFIG.DND5E.ENCOUNTER_DIFFICULTY ?? [];
    const heroes = party.length ? party : [{}];
    return Math.round(heroes.reduce((sum, a) => sum + (table[Math.min(20, levelOf(a) + node.plus)]?.[node.tier] ?? 0), 0) * node.scale);
}

let monsterIndex = null;
/** Монстры SRD: по английскому имени, русскому имени и id — { key, name, id, uuid, cr, xp } */
async function monsters() {
    if (monsterIndex) return monsterIndex;
    monsterIndex = { byName: new Map(), byId: new Map() };
    const pack = game.packs.get(PACK);
    if (!pack) return monsterIndex;
    const index = await pack.getIndex({ fields: ['system.details.cr'] });
    for (const e of index.contents) {
        const cr = Number(e.system?.details?.cr) || 0;
        const m = { name: e.name, id: e._id, uuid: `Compendium.${PACK}.Actor.${e._id}`, cr, xp: xpOfCr(cr) };
        monsterIndex.byId.set(e._id, m);
        monsterIndex.byName.set(e.originalName ?? e.name, m);
        monsterIndex.byName.set(e.name, m);
    }
    return monsterIndex;
}

/** Строка таблицы → монстр с весом: ссылка на актёра (SRD, мир, другой компендиум) или текст с именем SRD */
async function memberOf(result, index) {
    const weight = Math.max(1, Number(result.weight) || 1);
    // v13+: ссылка строки — documentUuid (у текстовой строки её нет)
    const uuid = result.type === 'document' ? result.documentUuid : null;
    if (uuid) {
        const srd = uuid.startsWith(`Compendium.${PACK}.Actor.`) ? index.byId.get(uuid.split('.').pop()) : null;
        if (srd) return { ...srd, key: uuid, weight };
        const actor = await fromUuid(uuid).catch(() => null);
        if (!(actor instanceof Actor)) return null;
        const cr = Number(actor.system?.details?.cr) || 0;
        return { key: uuid, name: actor.name, uuid, cr, xp: xpOfCr(cr), weight };
    }
    const srd = index.byName.get(String(result.name ?? result.text ?? '').trim());
    return srd ? { ...srd, key: srd.uuid, weight } : null;
}

/**
 * Стаи биома: [[название, монстры по силе]]. Таблицы компендиума, поверх — таблицы мира с тем же названием и
 * новые. Нет ни одной таблицы биома (этажи без своего биома) — все таблицы встреч
 */
export async function packsOf(biome) {
    const index = await monsters();
    const tables = new Map();
    const pack = game.packs.get(TABLES);
    for (const t of pack ? await pack.getDocuments() : []) tables.set(t.name, t);
    for (const t of game.tables.contents) if (t.name.startsWith(`${PREFIX}: `)) tables.set(t.name, t);
    const prefix = `${PREFIX}: ${BIOMES[biome]?.name ?? BIOMES.labyrinth.name}: `;
    let mine = [...tables.values()].filter(t => t.name.startsWith(prefix));
    if (!mine.length) mine = [...tables.values()];
    const out = [];
    for (const t of mine) {
        const members = (await Promise.all(t.results.contents.map(r => memberOf(r, index)))).filter(Boolean).sort((a, b) => a.xp - b.xp);
        if (members.length) out.push([t.name.split(': ').slice(2).join(': ') || t.name, members]);
    }
    return out;
}

const pick = (list, rnd) => list[Math.floor(rnd() * list.length)];
// По весам строк таблицы
const pickWeighted = (list, rnd) => {
    const total = list.reduce((sum, m) => sum + (m.weight ?? 1), 0);
    let roll = rnd() * total;
    for (const m of list) if ((roll -= m.weight ?? 1) < 0) return m;
    return list.at(-1);
};

/**
 * Состав встречи: [{ key, name, id, cr, xp, count }], стая, опыт и бюджет. rnd — случайность (для проверок с зерном)
 * @returns {Promise<{ type, biome, group, budget, xp, creatures }|null>}
 */
export async function buildEncounter(type, { party = partyActors(), biome = currentBiome(), rnd = Math.random, avoid = null } = {}) {
    const node = NODES[type];
    if (!node) return null;
    const budget = budgetFor(type, party);
    const maxCount = Math.max(2, party.length + 2);
    // Стая годится, если её слабейший влезает в бюджет, а сильнейшие набирают хотя бы половину
    const all = (await packsOf(biome)).filter(([, list]) => list.length && list[0].xp <= budget);
    const strong = all.filter(([, list]) => (list.filter(m => m.xp <= budget).at(-1)?.xp ?? 0) * maxCount >= budget / 2);
    const groups = strong.length ? strong : all;
    if (!groups.length) return null;
    // Другой состав — по возможности из другой стаи
    const choices = groups.length > 1 && avoid ? groups.filter(([g]) => g !== avoid) : groups;
    const [group, list] = pick(choices, rnd);
    const chosen = [];
    let left = budget;
    if (node.leader) {
        // Вожак — сильнейший, кто берёт не больше 60% бюджета (доля узла — нижняя планка, если такой есть)
        const fits = list.filter(m => m.xp <= budget * Math.max(node.leader, 0.6));
        const leader = fits.at(-1) ?? list[0];
        chosen.push(leader); left -= leader.xp;
    }
    // Рядовые: случайные из стаи, кто влезает в остаток; не больше maxCount существ
    for (let guard = 0; guard < 40 && chosen.length < maxCount; guard++) {
        const fits = list.filter(m => m.xp <= left && (!node.leader || m.xp < chosen[0].xp || list.length === 1));
        if (!fits.length) break;
        // Предпочтение тем, кто уже в составе: стая из 2–3 видов, а не зоопарк
        const kinds = new Set(chosen.map(m => m.key));
        const same = fits.filter(m => kinds.has(m.key));
        // Не больше трёх видов: третий вид — последний новый
        if (kinds.size >= 3 && !same.length) break;
        const m = kinds.size >= 2 && same.length ? pickWeighted(same, rnd) : pickWeighted(fits, rnd);
        chosen.push(m); left -= m.xp;
    }
    if (!chosen.length) chosen.push(list[0]);
    const byKey = new Map();
    for (const m of chosen) byKey.set(m.key, { ...m, count: (byKey.get(m.key)?.count ?? 0) + 1 });
    const creatures = [...byKey.values()].sort((a, b) => b.xp - a.xp);
    return { type, biome, group, budget, xp: creatures.reduce((s, m) => s + m.xp * m.count, 0), creatures };
}

// ==========================================
// ШЁПОТ МАСТЕРУ
// ==========================================

/**
 * Арена для встречи по состоянию этажа. Настроение: узел тронут или съеден Пожирателем — порча; Босс набрал
 * ступени — кровь на всех боях этажа; город — ночь; иначе день. Близость самого Пожирателя на картинку не
 * ложится — её показывают предвестия поверх любой сцены. Погода — на Элите в половине боёв, на Заставе и Боссе
 * всегда (галочка hintWeather): ливень, туман или ветер
 */
export function arenaFor(enc, enemies = [], { map = mapScene()?.getFlag(MODULE_ID, 'floorMap'), rnd = Math.random } = {}) {
    const here = map?.web ? map.currentNodeId : null;
    const [mood, why] = here && (isEaten(map, here) || touchedSet(map).has(here)) ? ['rot', 'узел тронут Пожирателем']
        : webStage(map?.web?.ticks ?? 0) > 0 ? ['blood', 'Босс набрал ступени']
        : enc.biome === 'town' ? ['night', 'город в глуши']
        : ['day', null];
    const [cols, rows] = ARENA_SIZE[enc.type] ?? [28, 20];
    const leader = NODES[enc.type]?.leader ? enemies[0] ?? null : null;
    const weather = hint('hintWeather') && rnd() < (WEATHER_CHANCE[enc.type] ?? 0) ? pick(Object.keys(WEATHER_NAMES), rnd) : null;
    return { biome: 'forest', mood, why, cols, rows, weather, encounter: { node: enc.type, leader } };
}

function cardHtml(enc, state = 'wait') {
    const node = NODES[enc.type];
    const list = enc.creatures.map(m => `<li>${m.count > 1 ? `${m.count} × ` : ''}${m.name} <small>(опасность ${m.cr < 1 ? `1/${Math.round(1 / m.cr)}` : m.cr})</small></li>`).join('');
    const buttons = state === 'wait'
        ? `<div class="gd-stone-buttons"><button type="button" data-gd-enc="arena"><i class="fas fa-mountain-sun"></i> На арену</button><button type="button" data-gd-enc="here"><i class="fas fa-location-dot"></i> На эту сцену</button><button type="button" data-gd-enc="reroll"><i class="fas fa-dice"></i> Другой состав</button><button type="button" data-gd-enc="skip">Сам</button></div>`
        : `<p><em>${state === 'skip' ? 'Мастер собирает бой сам.' : 'Враги на поле — бой создан, инициатива за Мастером.'}</em></p>`
            + (enc.arena ? `<p><small>Арена: ${SCHEME_NAMES[enc.arena.scheme] ?? enc.arena.scheme}, ${MOOD_NAMES[enc.arena.mood] ?? enc.arena.mood}${enc.arena.why ? ` — ${enc.arena.why}` : ''}${enc.arena.weather ? `; ${WEATHER_NAMES[enc.arena.weather]}` : ''}${enc.arena.flank ? '; часть стаи заходит с флангов' : ''}.</small></p>` : '');
    return `<div class="gd-scent-chat gd-enc-card"><i class="fas fa-skull-crossbones"></i> <strong>${node.label}: ${enc.group}</strong>
        <p>Сила — ${node.name}: ${enc.xp} из ${enc.budget} опыта.</p><ul>${list}</ul>${buttons}</div>`;
}

/** Предложить встречу Мастеру (вызывается при входе отряда на узел) */
export async function offerEncounter(type) {
    if (!NODES[type] || !game.user.isGM || (game.users.activeGM && game.users.activeGM.id !== game.user.id) || !hint('hintEncounters')) return null;
    const enc = await buildEncounter(type);
    if (!enc) return null;
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Лабиринт' }),
        whisper: game.users.filter(u => u.isGM).map(u => u.id),
        content: cardHtml(enc),
        flags: { [MODULE_ID]: { encounter: { ...enc, state: 'wait' } } }
    });
}
Hooks.on('gachadnd.nodeEntered', type => { offerEncounter(type).catch(error => console.error(`${MODULE_ID} | встреча`, error)); });

// ==========================================
// РАССТАНОВКА
// ==========================================

/** Монстры встречи — актёры мира: свой актёр мира — как есть, из компендиума — импорт один раз (папка «Лабиринт: монстры») */
async function worldActors(enc) {
    let folder = game.folders.find(f => f.type === 'Actor' && f.name === FOLDER);
    const ids = [];
    for (const m of enc.creatures) {
        const uuid = m.uuid ?? `Compendium.${PACK}.Actor.${m.id}`;
        let actor = uuid.startsWith('Actor.') ? game.actors.get(uuid.split('.')[1]) : game.actors.find(a => a.getFlag(MODULE_ID, 'encounterSource') === uuid);
        if (!actor) {
            const [, scope, name, , id] = uuid.split('.');
            const pack = game.packs.get(`${scope}.${name}`);
            if (!pack) continue;
            folder ??= await Folder.create({ name: FOLDER, type: 'Actor', color: '#3a2b2b' });
            actor = await game.actors.importFromCompendium(pack, id, { folder: folder.id });
            await actor.setFlag(MODULE_ID, 'encounterSource', uuid);
        }
        for (let i = 0; i < m.count; i++) ids.push(actor.id);
    }
    return ids;
}

/**
 * Враги на текущей сцене: в нескольких клетках правее отряда (или от центра обзора), свободными клетками.
 * Существо крупнее клетки занимает w×w клеток — место ищется целиком
 */
async function placeHere(ids) {
    const scene = canvas.scene, size = scene.grid.size;
    const party = new Set(partyActors().map(a => a.id));
    const own = scene.tokens.filter(t => party.has(t.actorId));
    const base = own.length
        ? { x: Math.round((Math.max(...own.map(t => t.x)) + size * 5) / size), y: Math.round(own.reduce((s, t) => s + t.y, 0) / own.length / size) }
        : { x: Math.round(canvas.stage.pivot.x / size), y: Math.round(canvas.stage.pivot.y / size) };
    const taken = new Set();
    for (const t of scene.tokens) for (let dy = 0; dy < (t.height || 1); dy++) for (let dx = 0; dx < (t.width || 1); dx++) taken.add(`${Math.round(t.x / size) + dx},${Math.round(t.y / size) + dy}`);
    const free = (x, y, w) => {
        for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) if (taken.has(`${x + dx},${y + dy}`)) return false;
        return true;
    };
    // Клетки — колонками по 4 от точки, вглубь вправо
    const cells = [];
    for (let col = 0; col < 40; col++) for (let row = -1; row < 3; row++) cells.push({ x: base.x + col, y: base.y + row });
    const docs = [];
    for (const id of ids) {
        const actor = game.actors.get(id);
        const w = Math.max(1, Math.round(actor.prototypeToken?.width || 1));
        const cell = cells.find(c => free(c.x, c.y, w));
        if (!cell) break;
        for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) taken.add(`${cell.x + dx},${cell.y + dy}`);
        const t = await actor.getTokenDocument({ x: cell.x * size, y: cell.y * size });
        docs.push(t.toObject());
    }
    await scene.createEmbeddedDocuments('Token', docs);
    return scene;
}

/** Бой сцены с отрядом и врагами — участники добавлены, инициатива и начало за Мастером */
async function makeCombat(scene) {
    let combat = game.combats.find(c => c.scene?.id === scene.id && !c.started) ?? await Combat.create({ scene: scene.id, active: true });
    const inCombat = new Set(combat.combatants.map(c => c.tokenId));
    const tokens = scene.tokens.filter(t => t.actor && !inCombat.has(t.id));
    if (tokens.length) await combat.createEmbeddedDocuments('Combatant', tokens.map(t => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, hidden: t.hidden })));
    return combat;
}

async function resolve(message, action) {
    const enc = message.getFlag(MODULE_ID, 'encounter');
    if (!enc || enc.state !== 'wait') return;
    if (action === 'skip') return message.update({ content: cardHtml(enc, 'skip'), [`flags.${MODULE_ID}.encounter.state`]: 'skip' });
    if (action === 'reroll') {
        const next = await buildEncounter(enc.type, { biome: enc.biome, avoid: enc.group });
        if (!next) return;
        return message.update({ content: cardHtml(next), [`flags.${MODULE_ID}.encounter`]: { ...next, state: 'wait' } });
    }
    await message.update({ [`flags.${MODULE_ID}.encounter.state`]: 'placing' });
    try {
        const enemies = await worldActors(enc);
        let scene, arena = null;
        if (action === 'arena') {
            const generate = game.gachadnd?.arena?.generate;
            const { why, ...options } = arenaFor(enc, enemies);
            let plan;
            ({ scene, plan } = await generate({ ...options, party: partyActors().map(a => a.id), enemies }));
            arena = { scheme: plan.scheme, mood: options.mood, why, flank: !!plan.formation?.flank, weather: options.weather };
            await scene.activate();
        } else scene = await placeHere(enemies);
        await makeCombat(scene);
        await message.update({ content: cardHtml({ ...enc, arena }, 'placed'), [`flags.${MODULE_ID}.encounter.state`]: 'placed', [`flags.${MODULE_ID}.encounter.arena`]: arena });
    } catch (error) {
        await message.update({ [`flags.${MODULE_ID}.encounter.state`]: 'wait' });
        throw error;
    }
}

onRenderChatMessage((message, html) => {
    const enc = message.getFlag?.(MODULE_ID, 'encounter');
    if (!enc || !html?.querySelectorAll || !game.user.isGM) return;
    html.querySelectorAll('[data-gd-enc]').forEach(b => {
        b.disabled = enc.state !== 'wait';
        b.addEventListener('click', event => {
            event.preventDefault();
            html.querySelectorAll('[data-gd-enc]').forEach(x => { x.disabled = true; });
            resolve(message, b.dataset.gdEnc).catch(error => console.error(`${MODULE_ID} | встреча`, error));
        });
    });
});

export const encounterApi = { build: buildEncounter, offer: offerEncounter, budget: budgetFor, packs: packsOf, arena: arenaFor, resolve };
