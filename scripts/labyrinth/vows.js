/**
 * Gacha Roguelike dnd5e — Обеты на Элите
 *
 * Отряд вошёл на Элиту — у всех окно: по два случайных обета на группу (способности, враги, количество, поле).
 * Галочки общие, «Готовы» жмут игроки, «В бой» — Мастер; он же снимает и заменяет обеты. Сумма весов — ступень
 * награды (LADDER): больше кристаллов, потом золото и редкий кристалл. Прибавку даёт только победа.
 *
 * Состояние — настройка мира vowsState { phase, node, offered, chosen, ready, paid }; пишет её Мастер, игроки просят
 * через сокет. Фазы: choose — окно открыто; sealed — обеты приняты, идёт бой; won — победа, награда ждёт генератор.
 * Новый узел снимает состояние.
 *
 * Сборка боя — встреча (encounters.js) ждёт конца выбора: состав и арена читают обеты сами. Всё остальное работает
 * в бою без Мастера: флаг боя vows { ids, weight } ставится в начале боя, снимается вместе с боем.
 *   hunger — в конце боя −1 заряд каждому надетому навыку, который не применяли (снимок трат в начале боя);
 *   lapse — случайный надетый навык спит (просыпается в scars.js по combatId);
 *   facets — камни Огранки гаснут (FACET_BLOCKS); threads — счёт тегов на ступень ниже (TAG_COUNT_MODIFIERS);
 *   tempered — вожак +50 % ПЗ; vengeance — смерть врага даёт соседу-врагу временные ПЗ; undying — первый убитый
 *   встаёт в конце раунда; ambush — в первом раунде ходы героев пропускаются, навыки и реакции не применяются;
 *   wave — на 3-м раунде рядовые из этой же стаи, где дальше всего от врагов; closing — туман сжимает поле,
 *   герой за границей в начале хода получает урон.
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM, onSocket, requestGM } from "../core/socket.js";
import { hint } from "../core/prefs.js";
import { onRenderChatMessage } from "../core/chat-hooks.js";
import { HOOKS as MEMORY_HOOKS } from "../memory/memory-api.js";
import { GachaLootTerminal, rarityWeights } from "../memory/loot.js";
import { isMemorySkill, isAwake, updateActorSynergies, TAG_COUNT_MODIFIERS } from "../memory/synergy/synergy.js";
import { getSynergyDictionary } from "../memory/synergy/synergy-data.js";
import { FACET_BLOCKS, facetState } from "../memory/facet/facet.js";
import { sleepSkill } from "../memory/skills/living/common.js";
import { isScar } from "../memory/skills/living/scars.js";
import { DUNGEON_BIOMES } from "../arena/dungeon.js";
import { currentBiome } from "./biomes.js";
import { partyActors } from "./horsemen.js";
import { mapScene } from "./scene-travel.js";
import { t } from "../core/i18n.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const WINDOW_ID = 'gachadnd-vows';
const FLAG = 'vows';
const esc = s => foundry.utils.escapeHTML(String(s ?? ''));

export const VOW_GROUPS = {
    skills: { label: t('Способности'), icon: 'fa-brain' },
    foes: { label: t('Враги'), icon: 'fa-skull' },
    count: { label: t('Количество'), icon: 'fa-users' },
    field: { label: t('Поле боя'), icon: 'fa-mountain-sun' }
};

// Рядовых на отряд: подмога — на двух героев один, стая и волна — на каждого героя
const halfParty = n => Math.ceil(n / 2);

export const VOWS = {
    hunger: { group: 'skills', weight: 1, name: t('Голодный Туман'), icon: 'fa-wind', text: () => t('В конце боя каждый герой теряет по заряду с каждого надетого навыка, который не применял в этом бою.') },
    lapse: { group: 'skills', weight: 2, name: t('Провал в Памяти'), icon: 'fa-moon', text: () => t('Один случайный надетый навык у каждого героя спит весь бой, пассивные тоже.') },
    facets: { group: 'skills', weight: 2, name: t('Потухшие грани'), icon: 'fa-gem', text: () => t('Камни Огранки в этом бою не работают.') },
    threads: { group: 'skills', weight: 3, name: t('Разорванные нити'), icon: 'fa-link-slash', text: () => t('Синергии в этом бою на ступень ниже.') },
    tempered: { group: 'foes', weight: 1, name: t('Закалка'), icon: 'fa-heart-circle-plus', text: () => t('Вожак получает +50 % ПЗ.') },
    vengeance: { group: 'foes', weight: 2, name: t('Месть стаи'), icon: 'fa-shield-heart', text: () => t('Когда враг гибнет, ближайший к нему другой враг получает временные ПЗ: четверть максимума ПЗ павшего.') },
    undying: { group: 'foes', weight: 2, name: t('Не упокоен'), icon: 'fa-skull-crossbones', text: () => t('Первый убитый враг встаёт в конце раунда с половиной ПЗ.') },
    ambush: { group: 'foes', weight: 3, name: t('Засада'), icon: 'fa-eye-slash', text: () => t('Весь первый раунд отряд пропускает: без ходов и без реакций, враги действуют свободно.') },
    reinforce: { group: 'count', weight: 1, name: t('Подмога'), icon: 'fa-user-plus', text: n => t('Рядовых врагов больше: +{v}.', { v: halfParty(n) }) },
    horde: { group: 'count', weight: 2, name: t('Густая стая'), icon: 'fa-users', text: n => t('Рядовых врагов больше: +{v}.', { v: n }) },
    wave: { group: 'count', weight: 2, name: t('Вторая волна'), icon: 'fa-water', text: n => t('На 3-м раунде приходят ещё {v} рядовых этой же стаи — за спиной отряда.', { v: n }) },
    second: { group: 'count', weight: 3, name: t('Второй вожак'), icon: 'fa-crown', text: () => t('В составе два вожака.') },
    storm: { group: 'field', weight: 1, name: t('Непогода'), icon: 'fa-cloud-showers-heavy', text: () => t('Погода на арене будет точно.') },
    pincers: { group: 'field', weight: 1, name: t('Клещи'), icon: 'fa-arrows-left-right-to-line', text: () => t('Часть стаи заходит с флангов.') },
    narrow: { group: 'field', weight: 2, name: t('Теснина'), icon: 'fa-compress', text: () => t('Поле меньше обычного: 20 × 14 клеток.') },
    closing: { group: 'field', weight: 3, name: t('Смыкание'), icon: 'fa-circle-notch', text: () => t('Со 2-го раунда туман каждый раунд сжимает поле на клетку; герой за его границей в начале хода получает урон силовым полем.') }
};
/** Складываться не должны: выбор одного снимает другой */
const EXCLUSIVE = { reinforce: 'horde', horde: 'reinforce' };
/** Не выпадают в одном окне: падение ступени и так гасит часть камней */
const NOT_TOGETHER = [['facets', 'threads']];
/** Что Мастер учитывает сам, если не собирал бой кнопками: на обычной сцене — поле, без кнопок — и состав */
export const ARENA_VOWS = ['storm', 'pincers', 'narrow'];
export const CREW_VOWS = ['reinforce', 'horde', 'second'];

// Награда: кристаллов на игрока сверх 1,5 у Элиты, множитель золота, редкий кристалл
const RARE_TIER = { blue: ['blue', 'purple', 'red'], purple: ['purple', 'red'] };
export const LADDER = [
    { min: 0, bonus: 0, gold: 1, rare: null },
    { min: 1, bonus: 0.5, gold: 1, rare: null },
    { min: 3, bonus: 1, gold: 1, rare: null },
    { min: 5, bonus: 1, gold: 1.5, rare: 'blue' },
    { min: 7, bonus: 1, gold: 2, rare: 'purple' }
];
const BASE_CRYSTALS = 1.5;
const RARE_NAMES = { blue: t('синего'), purple: t('фиолетового') };

export const weightOf = ids => ids.reduce((sum, id) => sum + (VOWS[id]?.weight ?? 0), 0);
export const rungOf = weight => LADDER.findLast(r => weight >= r.min);
const number = v => String(v).replace('.', ',');

/** Награда ступени словами */
export function rewardText(rung) {
    const parts = [t('{v} кристалла на игрока', { v: number(BASE_CRYSTALS + rung.bonus) })];
    if (rung.gold > 1) parts.push(t('золото ×{v}', { v: number(rung.gold) }));
    if (rung.rare) parts.push(t('один кристалл не ниже {v}', { v: RARE_NAMES[rung.rare] }));
    return parts.join(', ');
}

export function registerVowsSettings() {
    game.settings.register(MODULE_ID, 'vowsState', {
        scope: 'world', config: false, type: Object, default: {},
        onChange: value => (value?.phase === 'choose' ? VowsWindow.show() : VowsWindow.close())
    });
}

export const getVows = () => game.settings.get(MODULE_ID, 'vowsState') ?? {};
const setVows = value => game.settings.set(MODULE_ID, 'vowsState', value);
export const vowsOn = () => hint('hintVows');
const currentNode = () => {
    const map = mapScene()?.getFlag(MODULE_ID, 'floorMap');
    return map?.nodes?.find(n => n.id === map.currentNodeId) ?? null;
};
const announce = (html, whisper = false) => ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: t('Лабиринт') }),
    ...(whisper ? { whisper: game.users.filter(u => u.isGM).map(u => u.id) } : {}),
    content: `<div class="gd-scent-chat gd-vow-card">${html}</div>`
});

// ==========================================
// ВЫБОР: ЧТО ПРЕДЛОЖИТЬ
// ==========================================

const wakingSkills = actor => actor.items.filter(i => isMemorySkill(i) && isAwake(i));
const sleepable = actor => wakingSkills(actor).filter(i => !isScar(i) && !i.flags[MODULE_ID].horseman);
const hasUses = item => Number(item.system?.uses?.max) > 0;

/** Обет, который отряду ничего не стоит, не выпадает: иначе награда даром (нет камней, синергий, зарядов; под землёй нет погоды) */
function eligible(party = partyActors()) {
    const half = Math.ceil(party.length / 2);
    const most = test => party.filter(test).length >= half;
    const under = DUNGEON_BIOMES.has(currentBiome());
    const off = new Set();
    if (!most(a => wakingSkills(a).some(hasUses))) off.add('hunger');
    if (!most(a => sleepable(a).length)) off.add('lapse');
    if (!most(a => facetState(a).placements.some(p => p.active))) off.add('facets');
    if (!most(a => a.effects.some(e => e.flags?.[MODULE_ID]?.is_synergy))) off.add('threads');
    if (under) { off.add('storm'); off.add('pincers'); }
    return Object.keys(VOWS).filter(id => !off.has(id));
}

const shuffled = (list, rnd = Math.random) => list.map(v => [rnd(), v]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
const clashes = (id, list) => NOT_TOGETHER.some(pair => pair.includes(id) && pair.some(other => other !== id && list.includes(other)));

/** Обетов на группу в окне */
const PER_GROUP = 2;
export function offerVows({ party = partyActors(), rnd = Math.random } = {}) {
    const pool = eligible(party);
    const offered = [];
    for (const group of Object.keys(VOW_GROUPS)) {
        const mine = [];
        for (const id of shuffled(pool.filter(v => VOWS[v].group === group), rnd)) {
            if (mine.length < PER_GROUP && !clashes(id, mine)) mine.push(id);
        }
        offered.push(...mine);
    }
    return offered;
}

/** Вход на Элиту: окно у всех (Мастер). Встреча ждёт конца выбора */
export async function beginVows(node = currentNode()) {
    if (!game.user.isGM) return null;
    return setVows({ phase: 'choose', node: node?.id ?? null, offered: offerVows(), chosen: [], ready: [] });
}

// Отряд вошёл на узел: Элита — обеты, другой узел снимает прошлые
Hooks.on('gachadnd.nodeEntered', type => {
    if (!isActiveGM()) return;
    const run = type === 'elite' && vowsOn() ? beginVows() : (getVows().phase ? setVows({}) : null);
    Promise.resolve(run).catch(error => console.error(`${MODULE_ID} | обеты`, error));
});

// ==========================================
// ВЫБОР: ОПЕРАЦИИ (выполняет Мастер)
// ==========================================

/** Обеты приняты: карточка всем с кнопкой победы у Мастера; встреча собирается уже с ними */
export async function sealVows() {
    const state = getVows();
    if (state.phase !== 'choose') return;
    const chosen = state.chosen ?? [];
    if (!chosen.length) await setVows({});
    else {
        await setVows({ ...state, phase: 'sealed', ready: [] });
        const weight = weightOf(chosen);
        const list = chosen.map(id => `<li><i class="fas ${VOWS[id].icon}"></i> <strong>${VOWS[id].name}.</strong> ${VOWS[id].text(partyActors().length)}</li>`).join('');
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: t('Лабиринт') }),
            content: `<div class="gd-scent-chat gd-vow-card"><i class="fas fa-scroll"></i> <strong>${t('Обеты приняты: вес {v}.', { v: weight })}</strong><ul>${list}</ul><p>${t('За победу: {v}.', { v: rewardText(rungOf(weight)) })}</p><div class="gd-stone-buttons gd-vow-gm"><button type="button" data-gd-vow="win"><i class="fas fa-trophy"></i> ${t('Победа: к добыче')}</button></div></div>`,
            flags: { [MODULE_ID]: { vowCard: true } }
        });
        if (!hint('hintEncounters')) {
            const manual = chosen.filter(id => ARENA_VOWS.includes(id) || CREW_VOWS.includes(id)).map(id => VOWS[id].name);
            if (manual.length) await announce(t('Встречи выключены: обеты «{v}» Мастер учитывает сам.', { v: manual.join('», «') }), true);
        }
    }
    Hooks.callAll('gachadnd.vowsSealed', chosen);
}

async function performOp({ op, id, userId }) {
    const state = foundry.utils.deepClone(getVows());
    if (state.phase !== 'choose') return;
    const user = game.users.get(userId);
    if (op === 'toggle') {
        if (!state.offered.includes(id)) return;
        state.chosen = state.chosen.includes(id) ? state.chosen.filter(v => v !== id) : [...state.chosen.filter(v => v !== EXCLUSIVE[id]), id];
        // Выбор поменялся — согласие снимается, как в обмене
        state.ready = [];
    } else if (op === 'ready') {
        if (user?.isGM) return;
        state.ready = state.ready.includes(userId) ? state.ready.filter(v => v !== userId) : [...state.ready, userId];
    } else if (op === 'reroll' && user?.isGM) {
        const others = state.offered.filter(v => v !== id);
        const next = shuffled(eligible().filter(v => VOWS[v].group === VOWS[id]?.group && !state.offered.includes(v) && !clashes(v, others)))[0];
        if (!next) return ui.notifications.info(t('В этой группе обетов на замену больше нет.'));
        state.offered = state.offered.map(v => (v === id ? next : v));
        state.chosen = state.chosen.filter(v => v !== id);
        state.ready = [];
    } else if (op === 'seal' && user?.isGM) return sealVows();
    else return;
    await setVows(state);
}

let queue = Promise.resolve();
onSocket('vowsOp', message => {
    if (!isActiveGM()) return;
    queue = queue.then(() => performOp(message.payload)).catch(error => console.error(`${MODULE_ID} | обеты`, error));
    return queue;
});
const request = payload => requestGM('vowsOp', payload);

// ==========================================
// ОКНО
// ==========================================

export class VowsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: WINDOW_ID,
        classes: ['gachadnd-vows'],
        tag: 'div',
        window: { title: t('Обеты Элиты'), icon: 'fas fa-scroll', resizable: true },
        position: { width: 760, height: 'auto' },
        actions: {
            toggle: (event, target) => request({ op: 'toggle', id: target.dataset.id }),
            reroll: (event, target) => request({ op: 'reroll', id: target.dataset.id }),
            ready: () => request({ op: 'ready' }),
            seal: () => request({ op: 'seal' })
        }
    };

    static PARTS = { body: { template: 'modules/gachadnd/templates/vows/body.hbs' } };

    static async show() {
        const existing = foundry.applications.instances?.get(WINDOW_ID);
        const app = existing ?? new VowsWindow();
        await app.render({ force: true });
        app.bringToFront?.();
        return app;
    }

    static close() {
        foundry.applications.instances?.get(WINDOW_ID)?.close();
    }

    async _prepareContext() {
        const state = getVows();
        if (state.phase !== 'choose') return { active: false };
        const n = partyActors().length;
        const weight = weightOf(state.chosen);
        const rung = rungOf(weight);
        const next = LADDER.find(r => r.min > weight);
        const players = game.users.filter(u => u.active && !u.isGM);
        return {
            active: true, isGM: game.user.isGM, weight,
            mineReady: state.ready.includes(game.user.id),
            allReady: players.length > 0 && players.every(u => state.ready.includes(u.id)),
            reward: rewardText(rung),
            next: next ? t('Следующая ступень — вес {v}: {reward}.', { v: next.min, reward: rewardText(next) }) : null,
            ladder: LADDER.map(r => ({ min: r.min, on: r === rung, reached: weight >= r.min })),
            players: players.map(u => ({ name: u.character?.name ?? u.name, img: u.character?.img ?? u.avatar ?? 'icons/svg/mystery-man.svg', ready: state.ready.includes(u.id) })),
            groups: Object.entries(VOW_GROUPS).map(([key, group]) => ({
                ...group,
                vows: state.offered.filter(id => VOWS[id].group === key).map(id => ({
                    id, name: VOWS[id].name, icon: VOWS[id].icon, text: VOWS[id].text(n), weight: VOWS[id].weight,
                    pips: Array(VOWS[id].weight).fill(0), on: state.chosen.includes(id)
                }))
            })).filter(g => g.vows.length)
        };
    }
}

// Выбор уже идёт, когда игрок подключается, — окно открывается и у него
Hooks.once('ready', () => {
    if (getVows().phase === 'choose') VowsWindow.show();
});

// ==========================================
// БОЙ: КАКИЕ ОБЕТЫ ДЕЙСТВУЮТ
// ==========================================

export const combatVows = combat => combat?.getFlag(MODULE_ID, FLAG)?.ids ?? [];
const combatOf = actor => game.combats?.find(c => combatVows(c).length && c.combatants.some(cb => cb.actor?.id === actor?.id)) ?? null;
const actorVow = (actor, id) => combatVows(combatOf(actor)).includes(id);
const isHero = actor => actor?.type === 'character' && actor.hasPlayerOwner;
const heroesIn = combat => combat.combatants.map(c => c.actor).filter(isHero);
const hostilesIn = combat => combat.combatants.filter(c => c.token?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE && c.actor);
const crOf = actor => Number(actor?.system?.details?.cr) || 0;
const hpOf = actor => actor?.system?.attributes?.hp ?? {};

// Разорванные нити: счёт тега опускается ниже достигнутого порога. Камни и связки считают теги так же
TAG_COUNT_MODIFIERS.push((actor, counts) => {
    if (!actorVow(actor, 'threads')) return;
    const dictionary = getSynergyDictionary();
    for (const [tag, count] of Object.entries(counts)) {
        const steps = (dictionary[tag]?.thresholds ?? []).map(s => s.count).sort((a, b) => a - b);
        const reached = steps.findLastIndex(step => count >= step);
        if (reached < 0) continue;
        counts[tag] = reached > 0 ? steps[reached - 1] : steps[0] - 1;
    }
});

// Потухшие грани
FACET_BLOCKS.push(actor => actorVow(actor, 'facets'));

// Засада: в первом раунде герой ничего не применяет — и реакцией тоже
Hooks.on('dnd5e.preUseActivity', activity => {
    const actor = activity?.item?.actor;
    if (!isHero(actor) || !actorVow(actor, 'ambush') || combatOf(actor)?.round !== 1) return;
    ui.notifications.warn(t('Засада: отряд пропускает первый раунд.'));
    return false;
});

// ==========================================
// БОЙ: НАЧАЛО
// ==========================================

/** Закалка: вожак (со Вторым вожаком — оба) получает +50 % ПЗ до конца боя */
async function temper(combat, ids) {
    const leaders = hostilesIn(combat).sort((a, b) => crOf(b.actor) - crOf(a.actor)).slice(0, ids.includes('second') ? 2 : 1);
    for (const { actor } of leaders) {
        const hp = hpOf(actor);
        if (!hp.max) continue;
        const extra = Math.round(hp.max * 0.5);
        await actor.createEmbeddedDocuments('ActiveEffect', [{
            name: VOWS.tempered.name, img: 'icons/svg/regen.svg', origin: actor.uuid,
            changes: [{ key: 'system.attributes.hp.max', mode: 2, value: String(extra) }],
            flags: { [MODULE_ID]: { vowBoost: combat.id } }
        }]);
        await actor.update({ 'system.attributes.hp.value': (Number(hp.value) || 0) + extra });
    }
}

/** Снимок трат надетых навыков: кто в конце боя не изменился — не применялся */
function spentSnapshot(combat) {
    const out = {};
    for (const actor of heroesIn(combat)) {
        out[actor.id] = Object.fromEntries(wakingSkills(actor).filter(hasUses).map(i => [i.id, Number(i.system.uses.spent) || 0]));
    }
    return out;
}

/** Поставить обеты на бой: флаг, сон навыков, вожак, туман */
export async function applyVows(combat, ids) {
    const weight = weightOf(ids);
    await combat.update({ [`flags.${MODULE_ID}.${FLAG}`]: { ids, weight }, ...(ids.includes('hunger') ? { [`flags.${MODULE_ID}.vowSpent`]: spentSnapshot(combat) } : {}) });
    const lines = [];
    if (ids.includes('lapse')) {
        const asleep = [];
        for (const actor of heroesIn(combat)) {
            const list = sleepable(actor);
            const item = list[Math.floor(Math.random() * list.length)];
            if (!item) continue;
            await sleepSkill(item, { combatId: combat.id, reason: t('обет «Провал в Памяти», до конца боя') });
            asleep.push(`«${esc(item.name)}» (${esc(actor.name)})`);
        }
        if (asleep.length) lines.push(t('<strong>Провал в Памяти.</strong> Спят: {v}.', { v: asleep.join(', ') }));
    }
    if (ids.includes('threads') || ids.includes('facets')) for (const actor of heroesIn(combat)) await updateActorSynergies(actor);
    if (ids.includes('tempered')) await temper(combat, ids);
    if (ids.includes('ambush')) lines.push(t('<strong>Засада!</strong> Отряд пропускает первый раунд.'));
    if (lines.length) await announce(lines.join('<br>'));
    await skipAmbushed(combat);
}

Hooks.on('combatStart', async combat => {
    // Обеты — узла, на котором отряд стоит; по пройденным узлам паутины отряд идёт без входа на узел
    if (!isActiveGM() || !getVows().phase || getVows().node !== (currentNode()?.id ?? null)) return;
    // Бой начали, не закрыв окно, — принимается то, что отмечено
    if (getVows().phase === 'choose') await sealVows();
    const state = getVows();
    if (state.phase === 'sealed' && state.chosen?.length) await applyVows(combat, state.chosen);
});

// ==========================================
// БОЙ: ХОДЫ И РАУНДЫ
// ==========================================

// Смена хода приходит и после пропуска: один пропуск на ход
const skipped = new Set();
async function skipAmbushed(combat) {
    if (!combatVows(combat).includes('ambush') || combat.round !== 1 || !isHero(combat.combatant?.actor)) return;
    const key = `${combat.id}|${combat.round}|${combat.turn}`;
    if (skipped.has(key)) return;
    skipped.add(key);
    await combat.nextTurn();
}

/** Клетки арены без токенов: самые дальние от врагов, куда от отряда есть прямой проход */
function behindParty(combat, count) {
    const scene = combat.scene, size = scene.grid.size, d = scene.dimensions;
    const centre = list => ({ x: list.reduce((s, c) => s + c.x, 0) / list.length, y: list.reduce((s, c) => s + c.y, 0) / list.length });
    const heroes = combat.combatants.filter(c => isHero(c.actor)).map(c => c.token).filter(Boolean);
    const foes = hostilesIn(combat).map(c => c.token).filter(Boolean);
    if (!heroes.length || !foes.length) return [];
    const from = centre(heroes), enemy = centre(foes);
    const taken = new Set();
    for (const token of scene.tokens) for (let dy = 0; dy < (token.height || 1); dy++) for (let dx = 0; dx < (token.width || 1); dx++) taken.add(`${Math.round((token.x - d.sceneX) / size) + dx},${Math.round((token.y - d.sceneY) / size) + dy}`);
    const cells = [];
    for (let row = 0; row < Math.floor(d.sceneHeight / size); row++) for (let col = 0; col < Math.floor(d.sceneWidth / size); col++) {
        if (taken.has(`${col},${row}`)) continue;
        const x = d.sceneX + col * size, y = d.sceneY + row * size;
        // Не вплотную к герою: волна приходит к отряду, а не на него
        if (heroes.some(h => Math.hypot(h.x - x, h.y - y) < size * 2)) continue;
        cells.push({ x, y, far: Math.hypot(x - enemy.x, y - enemy.y) });
    }
    cells.sort((a, b) => b.far - a.far);
    const onCanvas = canvas.scene?.id === scene.id && canvas.ready;
    const sweep = foundry.canvas?.geometry?.ClockwiseSweepPolygon ?? globalThis.ClockwiseSweepPolygon;
    const open = c => {
        if (!onCanvas || !sweep?.testCollision) return true;
        const half = size / 2;
        return !sweep.testCollision({ x: from.x + half, y: from.y + half }, { x: c.x + half, y: c.y + half }, { type: 'move', mode: 'any' });
    };
    const out = [];
    for (const cell of cells) {
        if (out.length >= count) break;
        if (open(cell)) out.push(cell);
    }
    return out;
}

/** Рядовой стаи: кого в бою больше всех, при равенстве — слабейший */
function rankOf(combat) {
    const kinds = new Map();
    for (const c of hostilesIn(combat)) {
        const id = c.token?.actorId;
        if (id) kinds.set(id, (kinds.get(id) ?? 0) + 1);
    }
    return [...kinds.entries()].map(([id, count]) => ({ actor: game.actors.get(id), count })).filter(k => k.actor)
        .sort((a, b) => b.count - a.count || crOf(a.actor) - crOf(b.actor))[0]?.actor ?? null;
}

/** Вторая волна: по рядовому на героя, за спиной отряда */
async function callWave(combat) {
    if (combat.getFlag(MODULE_ID, 'vowWave')) return;
    await combat.setFlag(MODULE_ID, 'vowWave', true);
    const actor = rankOf(combat);
    const cells = actor ? behindParty(combat, heroesIn(combat).length) : [];
    if (!cells.length) return announce(t('<strong>Вторая волна</strong> не нашла, где выйти: Мастер ставит её сам.'), true);
    const docs = [];
    for (const cell of cells) docs.push((await actor.getTokenDocument({ x: cell.x, y: cell.y })).toObject());
    const tokens = await combat.scene.createEmbeddedDocuments('Token', docs);
    const added = await combat.createEmbeddedDocuments('Combatant', tokens.map(token => ({ tokenId: token.id, sceneId: combat.scene.id, actorId: token.actorId, hidden: token.hidden })));
    await combat.rollInitiative(added.map(c => c.id), { updateTurn: false });
    await announce(`<i class="fas ${VOWS.wave.icon}"></i> ${t('<strong>Вторая волна:</strong> {name} × {v} за спиной отряда.', { name: esc(actor.name), v: tokens.length })}`);
}

// Смыкание: регион тумана по краям поля, раз в раунд на клетку уже
const CLOSING = 'vowClosing';
function closingInset(scene, round) {
    const d = scene.dimensions, size = scene.grid.size;
    const limit = Math.max(0, Math.floor(Math.min(d.sceneWidth, d.sceneHeight) / size / 2) - 3);
    return Math.min(limit, Math.max(0, round - 1));
}
function closingShapes(scene, inset) {
    const d = scene.dimensions, cut = inset * scene.grid.size;
    const rect = (x, y, width, height) => ({ type: 'rectangle', x, y, width, height, rotation: 0, anchorX: 0, anchorY: 0 });
    return [
        rect(d.sceneX, d.sceneY, d.sceneWidth, cut),
        rect(d.sceneX, d.sceneY + d.sceneHeight - cut, d.sceneWidth, cut),
        rect(d.sceneX, d.sceneY + cut, cut, d.sceneHeight - cut * 2),
        rect(d.sceneX + d.sceneWidth - cut, d.sceneY + cut, cut, d.sceneHeight - cut * 2)
    ];
}
async function closeIn(combat) {
    const scene = combat.scene;
    const inset = closingInset(scene, combat.round);
    if (!inset) return;
    const shapes = closingShapes(scene, inset);
    const region = scene.regions.find(r => r.getFlag(MODULE_ID, CLOSING) === combat.id);
    if (region) return region.update({ shapes });
    return scene.createEmbeddedDocuments('Region', [{
        name: VOWS.closing.name, color: '#6d4fa3', shapes, locked: true,
        visibility: CONST.REGION_VISIBILITY?.ALWAYS ?? 2,
        flags: { [MODULE_ID]: { [CLOSING]: combat.id } }
    }]);
}
/** Герой начал ход за границей тумана: урон по уровню, бросок виден всем */
async function burnOutside(combat) {
    const actor = combat.combatant?.actor, token = combat.combatant?.token;
    if (!isHero(actor) || !token) return;
    const scene = combat.scene, d = scene.dimensions, size = scene.grid.size;
    const cut = closingInset(scene, combat.round) * size;
    if (!cut) return;
    const x = token.x + (token.width || 1) * size / 2, y = token.y + (token.height || 1) * size / 2;
    const inside = x >= d.sceneX + cut && x <= d.sceneX + d.sceneWidth - cut && y >= d.sceneY + cut && y <= d.sceneY + d.sceneHeight - cut;
    if (inside) return;
    const level = Math.max(1, Number(actor.system?.details?.level) || 1);
    const roll = await new Roll(`${1 + Math.floor(level / 4)}d6`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: t('Смыкание: туман жжёт {name} — урон силовым полем', { name: esc(actor.name) }) });
    await actor.applyDamage([{ value: roll.total, type: 'force' }]);
}

/** Не упокоен: первый убитый встаёт в конце раунда */
async function raiseUndying(combat) {
    const state = combat.getFlag(MODULE_ID, 'vowUndying');
    if (!state || state.rose) return;
    await combat.setFlag(MODULE_ID, 'vowUndying', { ...state, rose: true });
    const combatant = combat.combatants.get(state.combatant);
    const actor = combatant?.actor;
    if (!actor) return;
    await actor.update({ 'system.attributes.hp.value': Math.max(1, Math.floor((hpOf(actor).max || 2) / 2)) });
    await combatant.update({ defeated: false });
    if (actor.statuses?.has('dead')) await actor.toggleStatusEffect('dead', { active: false }).catch(() => {});
    await announce(`<i class="fas ${VOWS.undying.icon}"></i> ${t('<strong>Не упокоен:</strong> {name} встаёт с половиной ПЗ.', { name: esc(actor.name) })}`);
}

Hooks.on('updateCombat', async (combat, changed) => {
    if (!isActiveGM() || !('turn' in changed || 'round' in changed)) return;
    const ids = combatVows(combat);
    if (!ids.length) return;
    try {
        if ('round' in changed && combat.round >= 2) {
            if (ids.includes('undying')) await raiseUndying(combat);
            if (ids.includes('closing')) await closeIn(combat);
            if (ids.includes('wave') && combat.round >= 3) await callWave(combat);
        }
        if (ids.includes('closing')) await burnOutside(combat);
        await skipAmbushed(combat);
    } catch (error) { console.error(`${MODULE_ID} | обеты`, error); }
});

/** Смерть врага: первый встанет, а соседу достанутся временные ПЗ. Один раз на врага */
Hooks.on('updateActor', async (actor, changes) => {
    if (!isActiveGM() || isHero(actor) || foundry.utils.getProperty(changes, 'system.attributes.hp.value') !== 0) return;
    for (const combat of game.combats ?? []) {
        const ids = combatVows(combat);
        if (!ids.includes('vengeance') && !ids.includes('undying')) continue;
        const fallen = hostilesIn(combat).find(c => c.actor === actor || c.actor?.uuid === actor.uuid);
        if (!fallen) continue;
        const done = combat.getFlag(MODULE_ID, 'vowFallen') ?? [];
        if (done.includes(fallen.id)) continue;
        await combat.setFlag(MODULE_ID, 'vowFallen', [...done, fallen.id]);
        if (ids.includes('undying') && !combat.getFlag(MODULE_ID, 'vowUndying')) await combat.setFlag(MODULE_ID, 'vowUndying', { combatant: fallen.id, rose: false });
        if (!ids.includes('vengeance')) continue;
        const near = hostilesIn(combat).filter(c => c.id !== fallen.id && (Number(hpOf(c.actor).value) || 0) > 0 && c.token)
            .sort((a, b) => Math.hypot(a.token.x - fallen.token.x, a.token.y - fallen.token.y) - Math.hypot(b.token.x - fallen.token.x, b.token.y - fallen.token.y))[0];
        if (!near) continue;
        const temp = Math.ceil((Number(hpOf(actor).max) || 0) / 4);
        // Временные ПЗ не складываются: остаётся большее
        if (temp > (Number(hpOf(near.actor).temp) || 0)) await near.actor.update({ 'system.attributes.hp.temp': temp });
        await announce(`<i class="fas ${VOWS.vengeance.icon}"></i> ${t('<strong>Месть стаи:</strong> {name} получает {temp} временных ПЗ.', { name: esc(near.name), temp })}`);
    }
});

// ==========================================
// КОНЕЦ БОЯ И НАГРАДА
// ==========================================

/** Голодный Туман: −1 заряд каждому надетому навыку, чьи траты не менялись с начала боя */
async function drainUnused(combat) {
    const snapshot = combat.getFlag(MODULE_ID, 'vowSpent') ?? {};
    const lines = [];
    for (const [actorId, skills] of Object.entries(snapshot)) {
        const actor = game.actors.get(actorId);
        if (!actor) continue;
        const lost = [];
        for (const [itemId, spent] of Object.entries(skills)) {
            const item = actor.items.get(itemId);
            const now = Number(item?.system?.uses?.spent) || 0;
            if (!item || now !== spent || now >= Number(item.system.uses.max)) continue;
            await item.update({ 'system.uses.spent': now + 1 }, { gachadndDrain: true });
            lost.push(`«${esc(item.name)}»`);
        }
        if (lost.length) lines.push(`${esc(actor.name)}: ${lost.join(', ')}`);
    }
    if (lines.length) await announce(`<i class="fas ${VOWS.hunger.icon}"></i> ${t('<strong>Голодный Туман</strong> забирает заряды:')}<br>${lines.join('<br>')}`);
}

/** Победа: награда ждёт генератор; у Мастера он открывается на Элите */
export async function winVows() {
    const state = getVows();
    if (state.phase !== 'sealed') return;
    await setVows({ ...state, phase: 'won' });
    await announce(`<i class="fas fa-trophy"></i> ${t('<strong>Обеты выполнены.</strong> За победу: {v}.', { v: rewardText(rungOf(weightOf(state.chosen))) })}`);
    if (game.user.isGM) await GachaLootTerminal.open({ room: 'elite' });
}

Hooks.on('deleteCombat', async combat => {
    const ids = combatVows(combat);
    if (!isActiveGM() || !ids.length) return;
    try {
        if (ids.includes('hunger')) await drainUnused(combat);
        for (const c of hostilesIn(combat)) {
            const boosts = c.actor.effects?.filter(e => e.flags?.[MODULE_ID]?.vowBoost === combat.id).map(e => e.id) ?? [];
            if (boosts.length) await c.actor.deleteEmbeddedDocuments('ActiveEffect', boosts);
        }
        const regions = combat.scene?.regions.filter(r => r.getFlag(MODULE_ID, CLOSING) === combat.id).map(r => r.id) ?? [];
        if (regions.length) await combat.scene.deleteEmbeddedDocuments('Region', regions);
        if (ids.includes('threads') || ids.includes('facets')) for (const actor of heroesIn(combat)) await updateActorSynergies(actor);
        // Все враги пали — победа сама; иначе решает Мастер: могли и сбежать, и договориться
        const alive = hostilesIn(combat).filter(c => (Number(hpOf(c.actor).value) || 0) > 0);
        if (getVows().phase !== 'sealed') return;
        if (!alive.length) return await winVows();
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: t('Лабиринт') }),
            whisper: game.users.filter(u => u.isGM).map(u => u.id),
            content: `<div class="gd-scent-chat gd-vow-card">${t('Бой закончен, врагов на ногах: {v}. Это победа?', { v: alive.length })}<div class="gd-stone-buttons gd-vow-gm"><button type="button" data-gd-vow="win"><i class="fas fa-trophy"></i> ${t('Победа: к добыче')}</button></div></div>`,
            flags: { [MODULE_ID]: { vowCard: true } }
        });
    } catch (error) { console.error(`${MODULE_ID} | обеты`, error); }
});

onRenderChatMessage((message, html) => {
    if (!message.getFlag?.(MODULE_ID, 'vowCard') || !html?.querySelector) return;
    // Кнопка — только у Мастера и пока обеты в силе
    if (!game.user.isGM || getVows().phase !== 'sealed') return html.querySelector('.gd-vow-gm')?.remove();
    html.querySelector('[data-gd-vow="win"]')?.addEventListener('click', event => {
        event.preventDefault();
        event.currentTarget.disabled = true;
        winVows().catch(error => console.error(`${MODULE_ID} | обеты`, error));
    });
});

/** Редкость не ниже заказанной: по весам этажа */
function rareRoll(rare) {
    const weights = rarityWeights();
    const list = RARE_TIER[rare].map(r => [r, weights[r] ?? 0]);
    let roll = Math.random() * list.reduce((s, [, w]) => s + w, 0);
    for (const [rarity, weight] of list) if ((roll -= weight) < 0) return rarity;
    return rare;
}

// Добыча Элиты после победы: прибавка по ступени, один раз. Застава тоже берёт комнату Элиты — её не трогаем
Hooks.on(MEMORY_HOOKS.lootPlanned, plan => {
    const state = getVows();
    if (plan.roomType !== 'elite' || !state.phase || state.phase === 'choose' || state.paid) return;
    if ((currentNode()?.id ?? null) !== state.node) return;
    if (state.phase === 'sealed') return ui.notifications.info(t('Обеты ещё не отмечены выполненными: прибавки в этой добыче нет. Кнопка — в карточке обетов.'));
    const rung = rungOf(weightOf(state.chosen));
    const total = plan.players * rung.bonus;
    plan.extra += Math.floor(total) + (Math.random() < total - Math.floor(total) ? 1 : 0);
    if (rung.rare) plan.rarities.push(rareRoll(rung.rare));
    plan.goldScale = (plan.goldScale ?? 1) * rung.gold;
    plan.lines.push(`<div style="text-align: center; margin-top: 8px; color: #e0c58a;"><i class="fas fa-scroll"></i> ${t('Обеты выполнены: {v}.', { v: rewardText(rung) })}</div>`);
    setVows({ ...state, paid: true }).catch(error => console.error(`${MODULE_ID} | обеты`, error));
});

export const vowsApi = { open: () => VowsWindow.show(), begin: beginVows, seal: sealVows, win: winVows, state: getVows, offer: offerVows, list: VOWS, ladder: LADDER };
