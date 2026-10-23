/**
 * Gacha Roguelike dnd5e — Встречи на боевых узлах (docs/quickstart.md, «Бой на узле»)
 *
 * Отряд вошёл на узел Монстры, Элита, Застава или Босс — Мастеру шёпот с готовой встречей: монстры SRD
 * (компендиум dnd5e.monsters, есть у каждого стола) по бюджету опыта dnd5e 2024 (CONFIG.DND5E.ENCOUNTER_DIFFICULTY,
 * на каждого героя по его уровню) и по биому этажа. Сила: Монстры — средняя, Элита — тяжёлая, Застава — тяжёлая
 * на уровень отряда + 1, Босс — тяжёлая с запасом и вожаком.
 *
 * Состав — из одной стаи биома (болотная нежить, пауки, разбойники…): у Элиты, Заставы и Босса сначала вожак
 * (самый сильный, кто влезает в долю бюджета), остальное — рядовыми. Монстров ищут по английскому имени
 * (originalName), поэтому встречи работают и с переводом компендиума, и без него.
 *
 * Кнопки: «На арену» — генератор арен (arena/arena.js) строит поле, отряд слева, враги справа; «На эту сцену» —
 * враги в нескольких клетках от отряда; «Другой состав»; «Сам» — модуль ничего не ставит. Монстры
 * импортируются в мир один раз (папка «Лабиринт: монстры») и ставятся отдельными токенами. Бой создаётся
 * с участниками, начинает его и бросает инициативу Мастер. Шёпот — отключаемая подсказка hintEncounters.
 */

import { MODULE_ID } from "../core/constants.js";
import { hint } from "../core/prefs.js";
import { onRenderChatMessage } from "../core/chat-hooks.js";
import { partyActors } from "./horsemen.js";
import { currentBiome } from "./biomes.js";
import { getFloor } from "./economy.js";

const PACK = 'dnd5e.monsters';
const FOLDER = 'Лабиринт: монстры';
// Сила встречи по узлу: столбец бюджета (0 — низкая, 1 — средняя, 2 — тяжёлая), запас, прибавка уровня,
// доля бюджета на вожака (0 — без вожака)
const NODES = {
    mob: { label: 'Монстры', tier: 1, scale: 1, plus: 0, leader: 0, name: 'средняя' },
    elite: { label: 'Элита', tier: 2, scale: 1, plus: 0, leader: 0.5, name: 'тяжёлая' },
    outpost: { label: 'Застава', tier: 2, scale: 1, plus: 1, leader: 0.5, name: 'тяжёлая, на уровень выше' },
    boss: { label: 'Босс', tier: 2, scale: 1.25, plus: 0, leader: 0.6, name: 'тяжёлая с запасом' }
};
// Стаи биомов: английские имена SRD. Болото и лес — до Заставы первого этажа, город в глуши — после
const PACKS_BY_BIOME = {
    swamp: {
        'Нежить топей': ['Zombie', 'Skeleton', 'Ghoul', 'Shadow', 'Ghast', "Will-o'-Wisp", 'Ogre Zombie'],
        'Болотные твари': ['Giant Frog', 'Giant Poisonous Snake', 'Swarm of Insects', 'Crocodile', 'Giant Toad', 'Lizardfolk', 'Giant Constrictor Snake'],
        'Пауки': ['Giant Wolf Spider', 'Swarm of Spiders', 'Giant Spider', 'Ettercap'],
        'Звери леса': ['Wolf', 'Boar', 'Panther', 'Black Bear', 'Dire Wolf', 'Brown Bear', 'Giant Boar'],
        'Лесная нечисть': ['Awakened Shrub', 'Violet Fungus', 'Satyr', 'Dryad', 'Awakened Tree', 'Sea Hag']
    },
    town: {
        'Разбойники': ['Bandit', 'Thug', 'Scout', 'Bandit Captain', 'Berserker'],
        'Культ': ['Cultist', 'Acolyte', 'Cult Fanatic', 'Priest'],
        'Крысы': ['Giant Rat', 'Swarm of Rats', 'Wererat'],
        'Упыри': ['Zombie', 'Ghoul', 'Ghast', 'Specter'],
        'Гноллы': ['Hyena', 'Gnoll', 'Giant Hyena']
    }
};
PACKS_BY_BIOME.labyrinth = { ...PACKS_BY_BIOME.swamp, ...PACKS_BY_BIOME.town };

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
/** Монстры SRD по английскому имени: { name, id, cr, xp } */
async function monsters() {
    if (monsterIndex) return monsterIndex;
    const pack = game.packs.get(PACK);
    if (!pack) return (monsterIndex = new Map());
    const index = await pack.getIndex({ fields: ['system.details.cr'] });
    monsterIndex = new Map(index.contents.map(e => {
        const cr = Number(e.system?.details?.cr) || 0;
        return [e.originalName ?? e.name, { key: e.originalName ?? e.name, name: e.name, id: e._id, cr, xp: xpOfCr(cr) }];
    }));
    return monsterIndex;
}

const pick = (list, rnd) => list[Math.floor(rnd() * list.length)];

/**
 * Состав встречи: [{ key, name, id, cr, xp, count }], стая, опыт и бюджет. rnd — случайность (для проверок с зерном)
 * @returns {Promise<{ type, biome, group, budget, xp, creatures }|null>}
 */
export async function buildEncounter(type, { party = partyActors(), biome = currentBiome(), rnd = Math.random, avoid = null } = {}) {
    const node = NODES[type];
    if (!node) return null;
    const budget = budgetFor(type, party);
    const index = await monsters();
    const maxCount = Math.max(2, party.length + 2);
    // Стая годится, если её слабейший влезает в бюджет, а сильнейшие набирают хотя бы половину
    const all = Object.entries(PACKS_BY_BIOME[biome] ?? PACKS_BY_BIOME.labyrinth)
        .map(([group, names]) => [group, names.map(n => index.get(n)).filter(Boolean).sort((a, b) => a.xp - b.xp)])
        .filter(([, list]) => list.length && list[0].xp <= budget);
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
        const m = kinds.size >= 2 && same.length ? pick(same, rnd) : pick(fits, rnd);
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

function cardHtml(enc, state = 'wait') {
    const node = NODES[enc.type];
    const list = enc.creatures.map(m => `<li>${m.count > 1 ? `${m.count} × ` : ''}${m.name} <small>(опасность ${m.cr < 1 ? `1/${Math.round(1 / m.cr)}` : m.cr})</small></li>`).join('');
    const buttons = state === 'wait'
        ? `<div class="gd-stone-buttons"><button type="button" data-gd-enc="arena"><i class="fas fa-mountain-sun"></i> На арену</button><button type="button" data-gd-enc="here"><i class="fas fa-location-dot"></i> На эту сцену</button><button type="button" data-gd-enc="reroll"><i class="fas fa-dice"></i> Другой состав</button><button type="button" data-gd-enc="skip">Сам</button></div>`
        : `<p><em>${state === 'skip' ? 'Мастер собирает бой сам.' : 'Враги на поле — бой создан, инициатива за Мастером.'}</em></p>`;
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

/** Монстры встречи — актёры мира: импорт из SRD один раз, папка «Лабиринт: монстры» */
async function worldActors(enc) {
    const pack = game.packs.get(PACK);
    let folder = game.folders.find(f => f.type === 'Actor' && f.name === FOLDER);
    folder ??= await Folder.create({ name: FOLDER, type: 'Actor', color: '#3a2b2b' });
    const ids = [];
    for (const m of enc.creatures) {
        const uuid = `Compendium.${PACK}.Actor.${m.id}`;
        let actor = game.actors.find(a => a.getFlag(MODULE_ID, 'encounterSource') === uuid);
        if (!actor) {
            actor = await game.actors.importFromCompendium(pack, m.id, { folder: folder.id });
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
        let scene;
        if (action === 'arena') {
            const generate = game.gachadnd?.arena?.generate;
            ({ scene } = await generate({ biome: 'forest', mood: enc.biome === 'town' ? 'night' : 'day', party: partyActors().map(a => a.id), enemies }));
            await scene.activate();
        } else scene = await placeHere(enemies);
        await makeCombat(scene);
        await message.update({ content: cardHtml(enc, 'placed'), [`flags.${MODULE_ID}.encounter.state`]: 'placed' });
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

export const encounterApi = { build: buildEncounter, offer: offerEncounter, budget: budgetFor, resolve };
