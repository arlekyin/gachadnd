/**
 * Gacha Roguelike dnd5e — Жильцы Якоря
 *
 * Под куполом Якоря селятся жильцы — по одному за этаж, до конца забега. Мастер может поселить любого
 * в любой момент; если за этаж никто не пришёл, после Босса у купола ждут двое-трое из пула, и отряд
 * впускает одного. Услуги — за золото по Базе этажа (скидка торговцев действует):
 *   Кузнец памяти — Перековка: сменить тег обычного навыка или перенести его на другой навык. Раз за визит.
 *   Картограф     — сменить тип узла на ещё не начатой карте этажа (кроме Входа, Заставы и Босса), до 2 узлов.
 *   Ростовщик     — ячейки: кристалл в ячейке не пахнет, достать его можно в любой момент этажа вне боя.
 *                   До 3 ячеек на отряд, каждая следующая дороже. Вернувшись в Якорь, он кладёт то, что
 *                   не забрали, в Хранилище хозяина, и ячейки закрываются.
 *   Знахарь       — Очистка за полцены (не повышает цену следующих), сброс перегрева навыков персонажа
 *                   и «унять эхо»: эхо в ноль, Видение на полную после «заглушить» тоже снимается.
 *   Приманщик     — приманка из кристалла (синий и выше): первый прорыв Охоты Пожиратель тратит на неё —
 *                   съедает, Насыщение +1, отряд не трогает. Одна приманка за раз.
 *
 * Состояние — настройки мира: anchorResidents [{ id, floor }], residentsState { visit, smith, cells, offer, bait }.
 * Действия игроков выполняет Мастер (requestGM('residentOp')).
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM, onSocket, requestGM, notifyUser } from "../core/socket.js";
import { floorBase, getFloor, pay, shopDiscount, applyDiscount } from "./economy.js";
import { mapScene } from "./scene-travel.js";
import { isMemorySkill, updateActorSynergies } from "../memory/synergy/synergy.js";
import { SYNERGIES } from "../memory/synergy/synergy-tiers.js";
import { isCrystalItem } from "../memory/inventory.js";
import { getStash } from "../memory/stash.js";
import { heatOf } from "../memory/overheat.js";
import { addSatiety } from "./devourer-state.js";
import { echoOf, setEcho } from "../memory/echo/echo.js";
import { t } from "../core/i18n.js";

const esc = s => foundry.utils.escapeHTML(String(s ?? ''));
export const ANCHOR_OPENED = 'gachadnd.anchorOpened';
export const HUNT_BREACH = 'gachadnd.huntBreach';

export const RESIDENTS = {
    smith: { name: t('Кузнец памяти'), icon: 'fa-hammer', color: '#ff9a3c', line: t('Тег — не приговор. Подержи навык над углями, и он вспомнит, кем мог быть.') },
    cartographer: { name: t('Картограф'), icon: 'fa-compass-drafting', color: '#6fc3ff', line: t('Туман врёт. Я — реже. Покажи, куда не хочешь идти.') },
    broker: { name: t('Ростовщик'), icon: 'fa-vault', color: '#e8c35a', line: t('Ячейка не пахнет. Плати — и кристалл дождётся тебя где угодно на этаже.') },
    healer: { name: t('Знахарь'), icon: 'fa-mortar-pestle', color: '#7bd88f', line: t('Остудить голову или вырезать лишнее — выбирай, пока я добрый.') },
    lurer: { name: t('Приманщик'), icon: 'fa-bone', color: '#c77dff', line: t('Он жадный, а не умный. Дай ему блестяшку — и он забудет о вас. Ненадолго.') }
};

// Цены — доля Базы этажа
export const PRICES = { smith: 0.6, chart: 0.4, cell: 0.3, cool: 0.3, bait: 0.5, scar: 0.3, hush: 0.4 };
export const LIMITS = { chart: 2, cells: 3 };
const BAIT_RARITIES = ['blue', 'purple', 'red', 'orange'];
// Обычные навыки: уникальные (фиолетовые и красные) и всадники не перековываются
const COMMON = ['gray', 'green', 'blue'];
const CHART_TYPES = ['mob', 'elite', 'event', 'risk', 'shop', 'rest'];
const FIXED_NODES = ['start', 'boss', 'outpost'];

const flagsOf = item => item?.flags?.[MODULE_ID] ?? {};
const DEFAULT_STATE = { visit: 0, smith: {}, cells: [], offer: null, bait: null };

export function registerResidentSettings() {
    // Кнопка «Ячейки Ростовщика» на панели токенов — пока он живёт в Якоре
    game.settings.register(MODULE_ID, 'anchorResidents', { scope: 'world', config: false, type: Array, default: [], onChange: () => { refresh(); ui.controls?.render?.({ reset: true }); } });
    game.settings.register(MODULE_ID, 'residentsState', { scope: 'world', config: false, type: Object, default: DEFAULT_STATE, onChange: refresh });
}

export const residents = () => game.settings.get(MODULE_ID, 'anchorResidents') ?? [];
export const hasResident = id => residents().some(r => r.id === id);
export const residentsState = () => ({ ...DEFAULT_STATE, ...foundry.utils.deepClone(game.settings.get(MODULE_ID, 'residentsState') ?? {}) });
const saveState = state => game.settings.set(MODULE_ID, 'residentsState', state);
const isAnchorOpen = () => !!game.settings.get(MODULE_ID, 'anchorOpen');

/** Цена услуги для персонажа: доля Базы этажа со скидкой торговцев */
export function price(kind, actor, n = 1) {
    return applyDiscount(Math.round(floorBase() * PRICES[kind] * n), shopDiscount(actor));
}
/** Очистка у Знахаря — половина первой Очистки в магазине, без роста */
export function cleansePrice(actor) {
    return applyDiscount(Math.round(floorBase() * Number(game.settings.get(MODULE_ID, 'cleansePrice')) * 0.5), shopDiscount(actor));
}

export const allTags = () => SYNERGIES.map(s => s.tag).sort((a, b) => a.localeCompare(b));

// ==========================================
// ВАРИАНТЫ УСЛУГ
// ==========================================

/** Навыки, которые можно перековать: обычные навыки Памяти, не всадники, не неудаляемые */
export const forgeable = item => isMemorySkill(item) && COMMON.includes(flagsOf(item).rarity) && !flagsOf(item).horseman && !flagsOf(item).undeletable && !flagsOf(item).scar;
export const smithUsed = actor => residentsState().smith?.[actor.id] === residentsState().visit;

/** Навык, который Знахарь может очистить (как в магазине) */
export const cleansable = item => isMemorySkill(item) && !flagsOf(item).undeletable && !(flagsOf(item).horseman && !flagsOf(item).cleansed);
/** Навыки персонажа с перегревом (заём, потраченный заём или блок) */
export const heated = actor => actor.items.filter(i => isMemorySkill(i) && (heatOf(i).extra || heatOf(i).locked));

/** Кристаллы-приманки: синий и выше */
export const baitable = item => isCrystalItem(item) && BAIT_RARITIES.includes(flagsOf(item).rarity);

/** Карта этажа, которую можно править: начерчена, отряд на неё ещё не вышел */
export function chartMap() {
    const map = mapScene()?.getFlag(MODULE_ID, 'floorMap');
    if (!map?.nodes?.length || map.currentNodeId) return null;
    return map;
}
export const chartable = node => !FIXED_NODES.includes(node.type);
export const chartTypes = () => CHART_TYPES;

/** Отряд в бою: персонаж участвует в идущем бою */
const inCombat = actor => game.combats.some(c => c.started && c.combatants.some(x => x.actorId === actor.id));

// ==========================================
// ПРИХОД
// ==========================================

/** Пул: кто ещё не живёт в Якоре */
export const pool = () => Object.keys(RESIDENTS).filter(id => !hasResident(id));
const arrivedThisFloor = () => residents().some(r => r.floor === getFloor());

async function settle(id, how) {
    const list = residents();
    if (!RESIDENTS[id] || list.some(r => r.id === id)) return;
    await game.settings.set(MODULE_ID, 'anchorResidents', [...list, { id, floor: getFloor() }]);
    const state = residentsState();
    if (state.offer) { state.offer = null; await saveState(state); }
    const r = RESIDENTS[id];
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: t('Якорь') }),
        content: `<div class="gd-resident-card" style="--c:${r.color}"><i class="fas ${r.icon}"></i> <strong>${r.name}</strong> ${t('{how} и остаётся под куполом.', { how })}<br><em>«${esc(r.line)}»</em></div>`
    });
}

/** Отряд вернулся в Якорь: ячейки — в Хранилища, новый визит; после Босса — предложить жильца */
Hooks.on(ANCHOR_OPENED, async () => {
    if (!isActiveGM()) return;
    const state = residentsState();
    state.visit = (state.visit ?? 0) + 1;
    const returned = [];
    for (const cell of state.cells ?? []) {
        const owner = game.actors.get(cell.by);
        if (!cell.data || !owner) continue;
        const data = foundry.utils.deepClone(cell.data);
        data.flags ??= {};
        data.flags[MODULE_ID] = { ...data.flags[MODULE_ID], stash_key: foundry.utils.randomID() };
        await owner.setFlag(MODULE_ID, 'stash', [...getStash(owner), data]);
        returned.push(`${esc(owner.name)} — ${esc(data.name)}`);
    }
    state.cells = [];
    const map = mapScene()?.getFlag(MODULE_ID, 'floorMap');
    const bossDone = map?.nodes?.some(n => n.type === 'boss' && map.visitedNodes?.includes(n.id));
    const free = pool();
    if (bossDone && !arrivedThisFloor() && free.length && state.offer?.floor !== getFloor()) {
        const n = Math.min(free.length, free.length >= 3 && Math.random() < 0.5 ? 3 : 2);
        state.offer = { floor: getFloor(), ids: free.sort(() => Math.random() - 0.5).slice(0, n) };
    }
    await saveState(state);
    if (returned.length) await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: t('Ростовщик') }),
        content: `<div class="gd-resident-card" style="--c:${RESIDENTS.broker.color}"><i class="fas fa-vault"></i> ${t('Ячейки закрыты. Невзятое — в Хранилище: {v}.', { v: returned.join(', ') })}</div>`
    });
    if (state.offer) await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: t('Якорь') }),
        content: `<div class="gd-resident-card"><i class="fas fa-door-open"></i> ${t('У границы купола ждут: {v}. Отряд впускает одного — окно «Жильцы Якоря».', { v: state.offer.ids.map(id => `<strong>${RESIDENTS[id].name}</strong>`).join(', ') })}</div>`
    });
});

// ==========================================
// ПРИМАНКА: первый прорыв Охоты
// ==========================================

// anchor.js, отряд вошёл на узел в Охоте: ctx = { nodeType, breach, gm: [], players: [] }
Hooks.on(HUNT_BREACH, ctx => {
    const bait = residentsState().bait;
    if (!ctx.breach || !bait || bait.eaten) return;
    ctx.gm.push(`<br><i class="fas fa-bone"></i> <strong>${t('Приманка:')}</strong> ${t('этот прорыв Пожиратель тратит на неё — съедает «{v}» и уходит. Отряд он не трогает. Насыщение +1 — модуль включит эффект сам.', { v: esc(bait.name) })}`);
    ctx.players.push(t('Где-то в стороне хрустит кристалл — и гул в сумках на время затихает.'));
    ctx.tasks.push((async () => {
        const state = residentsState();
        state.bait = null;
        await saveState(state);
        await addSatiety(1, t('съел приманку «{name}»', { name: bait.name }));
    })());
});

// ==========================================
// ОПЕРАЦИИ (выполняет Мастер)
// ==========================================

const chat = (id, text) => ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: RESIDENTS[id].name }),
    content: `<div class="gd-resident-card" style="--c:${RESIDENTS[id].color}"><i class="fas ${RESIDENTS[id].icon}"></i> ${text}</div>`
});

async function charge(userId, actor, cost) {
    if (await pay(actor, cost)) return true;
    notifyUser(userId, t('{name}: не хватает золота ({cost} зм).', { name: actor.name, cost }));
    return false;
}

async function performOp({ op, userId, ...data }) {
    const user = game.users.get(userId);
    const actor = data.actorId ? game.actors.get(data.actorId) : null;
    const owns = a => user?.isGM || a?.testUserPermission(user, 'OWNER');
    const deny = text => notifyUser(userId, text);

    if (op === 'settle') {
        if (!user?.isGM) return;
        return settle(data.id, t('приходит в Якорь'));
    }
    if (op === 'choose') {
        const offer = residentsState().offer;
        if (!offer?.ids.includes(data.id)) return deny(t('Этого жильца у купола уже нет.'));
        return settle(data.id, t('проходит под купол — отряд впустил'));
    }
    if (op === 'evict') {
        if (!user?.isGM) return;
        await game.settings.set(MODULE_ID, 'anchorResidents', residents().filter(r => r.id !== data.id));
        return;
    }

    if (!actor || !owns(actor)) return;
    const need = id => {
        if (!hasResident(id)) { deny(t('{name} не живёт в Якоре.', { name: RESIDENTS[id].name })); return false; }
        return true;
    };
    const inAnchor = () => {
        if (isAnchorOpen()) return true;
        deny(t('Это можно только в Якоре.'));
        return false;
    };

    if (op === 'forge') {
        if (!need('smith') || !inAnchor()) return;
        if (smithUsed(actor)) return deny(t('{name}: Кузнец уже перековал навык в этот визит.', { name: actor.name }));
        const item = actor.items.get(data.itemId);
        if (!forgeable(item)) return deny(t('Этот навык не перековать.'));
        const tags = [...(flagsOf(item).tags ?? [])];
        if (!tags.includes(data.tag)) return deny(t('У навыка нет такого тега.'));
        const cost = price('smith', actor);
        let text;
        if (data.mode === 'move') {
            const target = actor.items.get(data.targetId);
            if (!forgeable(target) || target.id === item.id) return deny(t('На этот навык тег не перенести.'));
            if ((flagsOf(target).tags ?? []).includes(data.tag)) return deny(t('У навыка уже есть этот тег.'));
            if (tags.length < 2) return deny(t('Последний тег не перенести: навык останется без тега.'));
            if (!(await charge(userId, actor, cost))) return;
            await item.setFlag(MODULE_ID, 'tags', tags.filter(t => t !== data.tag));
            await target.setFlag(MODULE_ID, 'tags', [...(flagsOf(target).tags ?? []), data.tag]);
            text = t('перенёс тег «{v}» с «{v2}» на «{v3}»', { v: esc(data.tag), v2: esc(item.name), v3: esc(target.name) });
        } else {
            if (!allTags().includes(data.newTag) || tags.includes(data.newTag)) return deny(t('Такой тег не подходит.'));
            if (!(await charge(userId, actor, cost))) return;
            await item.setFlag(MODULE_ID, 'tags', tags.map(t => t === data.tag ? data.newTag : t));
            text = t('перековал «{v}»: «{v2}» → «{v3}»', { v: esc(item.name), v2: esc(data.tag), v3: esc(data.newTag) });
        }
        const state = residentsState();
        state.smith = { ...state.smith, [actor.id]: state.visit };
        await saveState(state);
        await updateActorSynergies(actor);
        return chat('smith', `${t('Для')} <strong>${esc(actor.name)}</strong> ${t('{text} за {cost} зм.', { text, cost })}`);
    }

    if (op === 'chart') {
        if (!need('cartographer') || !inAnchor()) return;
        const map = chartMap();
        if (!map) return deny(t('Картограф правит только начерченную карту, на которую отряд ещё не вышел.'));
        if ((map.charted ?? 0) >= LIMITS.chart) return deny(t('Картограф уже переписал {chart} узла на этой карте.', { chart: LIMITS.chart }));
        const node = map.nodes.find(n => n.id === data.nodeId);
        if (!node || !chartable(node) || !CHART_TYPES.includes(data.type) || node.type === data.type) return deny(t('Этот узел так не переписать.'));
        const cost = price('chart', actor);
        if (!(await charge(userId, actor, cost))) return;
        const { MAP_DATA } = await import('./map.js');
        const copy = foundry.utils.deepClone(map);
        const was = copy.nodes.find(n => n.id === node.id);
        Object.assign(was, { type: data.type, label: MAP_DATA.LABELS[data.type], icon: MAP_DATA.ICONS[data.type], color: MAP_DATA.COLORS[data.type] });
        copy.charted = (copy.charted ?? 0) + 1;
        await mapScene().setFlag(MODULE_ID, 'floorMap', copy);
        return chat('cartographer', `${t('Для')} <strong>${esc(actor.name)}</strong> ${t('переписал узел: «{v}» → «{v2}» ({cost} зм).', { v: MAP_DATA.LABELS[node.type], v2: MAP_DATA.LABELS[data.type], cost })}`);
    }

    if (op === 'cellOpen') {
        if (!need('broker') || !inAnchor()) return;
        const state = residentsState();
        if (state.cells.length >= LIMITS.cells) return deny(t('Больше {cells} ячеек Ростовщик не открывает.', { cells: LIMITS.cells }));
        const cost = price('cell', actor, state.cells.length + 1);
        if (!(await charge(userId, actor, cost))) return;
        state.cells.push({ id: foundry.utils.randomID(), by: actor.id, data: null });
        await saveState(state);
        return chat('broker', `<strong>${esc(actor.name)}</strong> ${t('открывает ячейку за {cost} зм.', { cost })}`);
    }
    if (op === 'cellPut') {
        if (!need('broker') || !inAnchor()) return;
        const state = residentsState();
        const cell = state.cells.find(c => c.id === data.cellId);
        const item = actor.items.get(data.itemId);
        if (!cell || cell.data) return deny(t('Ячейка занята.'));
        if (!isCrystalItem(item)) return deny(t('В ячейку кладут кристаллы.'));
        const stored = item.toObject();
        delete stored._id;
        delete stored._stats;
        stored.system = { ...stored.system, quantity: 1 };
        const qty = Number(item.system?.quantity ?? 1);
        if (qty > 1) await item.update({ 'system.quantity': qty - 1 });
        else await item.delete();
        Object.assign(cell, { data: stored, by: actor.id });
        await saveState(state);
        return chat('broker', `<strong>${esc(actor.name)}</strong> ${t('кладёт в ячейку «{v}». Она больше не пахнет.', { v: esc(stored.name) })}`);
    }
    if (op === 'cellTake') {
        if (!need('broker')) return;
        if (inCombat(actor)) return deny(t('В бою ячейку не открыть.'));
        const state = residentsState();
        const cell = state.cells.find(c => c.id === data.cellId);
        if (!cell?.data) return deny(t('Ячейка пуста.'));
        const stored = cell.data;
        cell.data = null;
        await saveState(state);
        await actor.createEmbeddedDocuments('Item', [stored]);
        return chat('broker', `<strong>${esc(actor.name)}</strong> ${t('забирает из ячейки «{v}».', { v: esc(stored.name) })}`);
    }

    if (op === 'cleanse') {
        if (!need('healer') || !inAnchor()) return;
        const item = actor.items.get(data.itemId);
        if (!cleansable(item)) return deny(t('Этот навык не очистить.'));
        const cost = cleansePrice(actor);
        if (!(await charge(userId, actor, cost))) return;
        await item.delete({ gachadndCleanse: true });
        return chat('healer', `${t('Очистил Память')} <strong>${esc(actor.name)}</strong> ${t('от «{v}» за {cost} зм.', { v: esc(item.name), cost })}`);
    }
    if (op === 'scar') {
        if (!need('healer') || !inAnchor()) return;
        const item = actor.items.get(data.itemId);
        if (!isMemorySkill(item) || !flagsOf(item).scar) return deny(t('Это не шрам.'));
        const cost = price('scar', actor);
        if (!(await charge(userId, actor, cost))) return;
        await item.delete({ gachadndCleanse: true, gachadndScar: true });
        await updateActorSynergies(actor);
        return chat('healer', `${t('Залечил шрам')} <strong>${esc(actor.name)}</strong>${t(': «{v}» ({cost} зм).', { v: esc(item.name), cost })}`);
    }
    if (op === 'cool') {
        if (!need('healer') || !inAnchor()) return;
        const hot = heated(actor);
        if (!hot.length) return deny(t('{name}: перегрева нет.', { name: actor.name }));
        const cost = price('cool', actor);
        if (!(await charge(userId, actor, cost))) return;
        await actor.updateEmbeddedDocuments('Item', hot.map(i => ({ _id: i.id, [`flags.${MODULE_ID}.heat`]: { ...heatOf(i), extra: 0, locked: false } })));
        return chat('healer', `${t('Остудил')} <strong>${esc(actor.name)}</strong>${t(': {v} — перегрев снят ({cost} зм).', { v: hot.map(i => `«${esc(i.name)}»`).join(', '), cost })}`);
    }
    if (op === 'hush') {
        if (!need('healer') || !inAnchor()) return;
        const e = echoOf(actor);
        if (!e.value && !e.full) return deny(t('{name}: эхо и так молчит.', { name: actor.name }));
        const cost = price('hush', actor);
        if (!(await charge(userId, actor, cost))) return;
        // Голос и прочитанные воспоминания остаются: эхо стихает, история — нет
        await setEcho(actor, { value: 0, full: false, surge: null, foresee: null });
        return chat('healer', `${t('Унял эхо')} <strong>${esc(actor.name)}</strong>${t(': голоса прежних владельцев стихли ({cost} зм).', { cost })}`);
    }

    if (op === 'bait') {
        if (!need('lurer') || !inAnchor()) return;
        const state = residentsState();
        if (state.bait) return deny(t('Приманка уже ждёт Пожирателя.'));
        const item = actor.items.get(data.itemId);
        if (!baitable(item)) return deny(t('Приманка — синий кристалл или дороже.'));
        const cost = price('bait', actor);
        if (!(await charge(userId, actor, cost))) return;
        const qty = Number(item.system?.quantity ?? 1);
        const bait = { name: item.name, rarity: flagsOf(item).rarity, by: actor.id };
        if (qty > 1) await item.update({ 'system.quantity': qty - 1 });
        else await item.delete();
        state.bait = bait;
        await saveState(state);
        return chat('lurer', `<strong>${esc(actor.name)}</strong> ${t('отдаёт «{v}» и {cost} зм. Приманка спрятана: первый прорыв Охоты Пожиратель потратит на неё.', { v: esc(bait.name), cost })}`);
    }
}

export const request = payload => requestGM('residentOp', payload);
let queue = Promise.resolve();
onSocket('residentOp', message => {
    if (!isActiveGM()) return;
    queue = queue.then(() => performOp(message.payload)).catch(error => console.error(`${MODULE_ID} | Жильцы Якоря`, error));
    return queue;
});

/** Мастер селит жильца — из окна или макросом: game.gachadnd.settleResident('smith') */
export async function settleResident(id) {
    if (!game.user.isGM) return ui.notifications.warn(t('Селит жильцов Мастер.'));
    if (!RESIDENTS[id]) return ui.notifications.warn(t('Нет такого жильца: {id}. Есть: {v}.', { id, v: Object.keys(RESIDENTS).join(', ') }));
    if (hasResident(id)) return ui.notifications.warn(t('{name} уже живёт в Якоре.', { name: RESIDENTS[id].name }));
    if (arrivedThisFloor()) {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t('Жилец Якоря') },
            content: t('<p>На этом этаже жилец уже пришёл (правило — один за этаж). Поселить ещё одного?</p>'), rejectClose: false
        });
        if (!ok) return;
    }
    return request({ op: 'settle', id });
}

// Окна перерисовываются по изменению настроек
function refresh() {
    Hooks.callAll('gachadnd.residentsChanged');
}

