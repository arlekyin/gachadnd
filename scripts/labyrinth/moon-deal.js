/**
 * Gacha Roguelike dnd5e — Сделка луны (после Босса этажа)
 *
 * Над телом Босса луна предлагает отряду обмен: три лота из пула, общие весы. Игроки кладут на весы
 * жертвы — навыки, Кости Хитов, максимум ПЗ, слоты Памяти, кристаллы из Хранилища, золото. Луна по
 * кусочкам собирает себе аватары: всё, что легло на весы, она забирает. Когда вес дотягивает до цены
 * выбранного лота, Мастер скрепляет сделку печатью: жертвы списываются окончательно, лот выдаётся.
 * Один лот за сделку; от сделки можно отказаться без потерь. Дизайн — docs/floor-resolution.md.
 *
 * Состояние — в узле Босса на карте этажа (флаг сцены floorMap): deal { lots, lot, offers, status }.
 * Игроки не меняют флаги сцены: их действия уходят Мастеру через сокет (dealOp) и выполняются по очереди.
 */

import { MODULE_ID } from "../core/constants.js";
import { mapScene } from "./scene-travel.js";
import { partyActors } from "./horsemen.js";
import { floorBase, getFloor, wealth, pay } from "./economy.js";
import { isActiveGM, onSocket, emit, requestGM, notifyUser } from "../core/socket.js";
import { isMemorySkill, naturalSlotCap, setSkillEquipped, updateActorSynergies } from "../memory/synergy/synergy.js";
import { getStash } from "../memory/stash.js";
import { addSkillToMemory } from "../memory/inventory.js";
import { currentSkillName } from "../memory/crystals.js";
import { findBoss } from "./moon-boons.js";
import { t } from "../core/i18n.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Вес навыка по редкости; кристалл из Хранилища — вдвое легче */
export const WEIGHT = { gray: 1, green: 2, blue: 3, purple: 5, red: 8 };
const RARITY_LABEL = { gray: t('серый'), green: t('зелёный'), blue: t('синий'), purple: t('фиолетовый'), red: t('красный') };
const RARITY_COLOR = { gray: '#9ea3ad', green: '#5fbf6a', blue: '#4f8fe0', purple: '#a46ae8', red: '#e0485c' };
// Уникальные (фиолетовые и красные) не копируются и не сплавляются: у них личный эффект
const COMMON = ['gray', 'green', 'blue'];

export const LOTS = {
    copy: { name: t('Чужая память'), price: 5, icon: 'fa-clone', text: t('копия навыка товарища') },
    devour: { name: t('Натравить Пожирателя'), price: 6, icon: 'fa-paw', text: t('однажды он придёт за вашими врагами') },
    echo: { name: t('Отголосок Босса'), price: 7, icon: 'fa-crown', text: t('однажды он встанет на вашу сторону') },
    fuse: { name: t('Сплав'), price: 9, icon: 'fa-link', text: t('два навыка — одна память, один слот') }
};

/** Тело и золото: вес и подписи */
const BODY = {
    hd: { label: t('Кость Хитов'), short: t('Кость Хитов'), w: 2, icon: 'fa-bone' },
    hp: { label: t('−5 к максимуму ПЗ'), short: t('−5 ПЗ'), w: 2, icon: 'fa-droplet' },
    slot: { label: t('−1 к пределу Памяти'), short: t('осколок маски'), w: 6, icon: 'fa-masks-theater' },
    gold: { label: t('золото'), short: t('½ Базы'), w: 1, icon: 'fa-coins' }
};
const HP_LOSS = 5;
const goldChunk = () => Math.round(floorBase() * 0.5);

const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '');

/**
 * Отряд сделки — персонажи игроков. Без игроков (Мастер готовит или проверяет сцену один) —
 * персонажи с токенами на текущей сцене.
 */
export function dealParty() {
    const party = partyActors();
    if (party.length) return party;
    const here = new Set(canvas?.scene?.tokens.map(t => t.actorId) ?? []);
    return game.actors.filter(a => a.type === 'character' && here.has(a.id) && !a.getFlag(MODULE_ID, 'devoured'));
}
const flagsOf = item => item?.flags?.[MODULE_ID] ?? {};

// ==========================================
// СОСТОЯНИЕ
// ==========================================

export function currentDealNode(scene = mapScene()) {
    const map = scene?.getFlag(MODULE_ID, 'floorMap');
    const node = map?.nodes?.find(n => n.id === map.currentNodeId);
    return node?.type === 'boss' ? { map, node } : null;
}

async function saveDeal(found, deal) {
    const copy = foundry.utils.deepClone(found.map);
    copy.nodes.find(n => n.id === found.node.id).deal = deal;
    await mapScene().setFlag(MODULE_ID, 'floorMap', copy);
}

/** Лоты следующей Сделки — заранее (событие «подсмотреть»): одни и те же на этаже, где их подсмотрели */
export function presetDealLots(floor = getFloor()) {
    const preset = game.settings.get(MODULE_ID, 'dealPreset');
    if (preset?.floor === floor && preset.lots?.length) return preset.lots;
    return null;
}
export async function rollDealLots(floor = getFloor()) {
    const lots = presetDealLots(floor) ?? Object.keys(LOTS).sort(() => Math.random() - 0.5).slice(0, 3);
    await game.settings.set(MODULE_ID, 'dealPreset', { floor, lots });
    return lots;
}

function newDeal() {
    const pool = [...(presetDealLots() ?? Object.keys(LOTS).sort(() => Math.random() - 0.5).slice(0, 3))];
    // Порядок на сцене — по цене: слева дешевле
    const lots = pool.sort((a, b) => LOTS[a].price - LOTS[b].price);
    return { floor: getFloor(), lots, lot: lots[lots.length - 1], offers: [], status: 'open' };
}

const weightOf = deal => deal.offers.reduce((sum, o) => sum + o.w, 0);

// ==========================================
// ЖЕРТВЫ
// ==========================================

/** Навык, который можно сжечь на весах: экипированный навык Памяти, не неудаляемый и не всадник */
const burnable = item => isMemorySkill(item) && flagsOf(item).is_active && !flagsOf(item).undeletable
    && !flagsOf(item).horseman && !flagsOf(item).scar && WEIGHT[flagsOf(item).rarity];

const mainClass = actor => actor.items.filter(i => i.type === 'class').sort((a, b) => (b.system.levels ?? 0) - (a.system.levels ?? 0))[0] ?? null;

/**
 * Что персонаж ещё может положить на весы, с учётом уже положенного.
 * @returns {object[]} { kind, ref, w, label, short, icon, color, rarity }
 */
export function sacrifices(actor, offers = []) {
    const mine = offers.filter(o => o.actorId === actor.id);
    const count = kind => mine.filter(o => o.kind === kind).length;
    const list = [];

    for (const item of actor.items.filter(burnable)) {
        if (mine.some(o => o.kind === 'skill' && o.ref === item.id)) continue;
        // Пара Сплава сгорает целиком — на весах она весит обоими навыками
        const partner = actor.items.get(flagsOf(item).fused?.partner);
        if (flagsOf(item).fused?.secondary && partner) continue;
        const rarity = flagsOf(item).rarity;
        const w = WEIGHT[rarity] + (partner ? WEIGHT[flagsOf(partner).rarity] ?? 0 : 0);
        list.push({ kind: 'skill', ref: item.id, w, rarity, color: RARITY_COLOR[rarity],
            label: `${RARITY_LABEL[rarity]} «${item.name}»${partner ? t(' и «{name}»', { name: partner.name }) : ''}`, short: item.name });
    }

    const hdMax = Number(actor.system.attributes?.hd?.max) || 0;
    if (mainClass(actor) && hdMax - count('hd') > 1) list.push({ kind: 'hd', ref: 'hd', ...BODY.hd });
    const hpMax = Number(actor.system.attributes?.hp?.max) || 0;
    if (hpMax - HP_LOSS * (count('hp') + 1) >= 1) list.push({ kind: 'hp', ref: 'hp', ...BODY.hp });
    if (naturalSlotCap(actor) - count('slot') > 1) list.push({ kind: 'slot', ref: 'slot', ...BODY.slot });

    for (const entry of getStash(actor)) {
        const key = entry.flags?.[MODULE_ID]?.stash_key;
        const rarity = entry.flags?.[MODULE_ID]?.rarity;
        if (!key || !WEIGHT[rarity]) continue;
        const left = (Number(entry.system?.quantity) || 1) - mine.filter(o => o.kind === 'stash' && o.ref === key).length;
        if (left <= 0) continue;
        list.push({ kind: 'stash', ref: key, w: WEIGHT[rarity] / 2, rarity, color: RARITY_COLOR[rarity],
            label: t('кристалл «{v}» из Хранилища', { v: String(entry.name).replace(/^Кристалл:\s*/, '') }), short: String(entry.name).replace(/^Кристалл:\s*/, ''), left });
    }

    if (wealth(actor) >= goldChunk() * (count('gold') + 1)) {
        list.push({ kind: 'gold', ref: 'gold', ...BODY.gold, label: t('{v} зм', { v: goldChunk() }) });
    }
    return list;
}

/** Списать жертвы одного персонажа — только Мастер, после печати */
async function takeFrom(actor, offers) {
    const of = kind => offers.filter(o => o.kind === kind);
    for (const o of of('skill')) {
        const item = actor.items.get(o.ref);
        if (item) await item.delete({ gachadndMoon: true });
    }
    if (of('hd').length) {
        const cls = mainClass(actor);
        const old = String(cls?._source.system.hd?.additional ?? '').trim();
        const n = of('hd').length;
        const next = !old ? `-${n}` : Number.isFinite(Number(old)) ? String(Number(old) - n) : `${old} - ${n}`;
        if (cls) await cls.update({ 'system.hd.additional': next });
    }
    if (of('hp').length) {
        const loss = HP_LOSS * of('hp').length;
        const total = (Number(actor.getFlag(MODULE_ID, 'moonHp')) || 0) + loss;
        await actor.setFlag(MODULE_ID, 'moonHp', total);
        const override = actor._source.system.attributes?.hp?.max;
        if (override != null) {
            // Максимум задан вручную — бонусы dnd5e к нему не прибавляются: уменьшается само число
            const max = Math.max(1, Number(override) - loss);
            await actor.update({ 'system.attributes.hp.max': max, 'system.attributes.hp.value': Math.min(actor.system.attributes.hp.value, max) });
        } else {
            // Максимум считается по классам: эффект на листе, видно, сколько забрала луна
            const data = {
                name: t('Луна: забранная плоть'), img: 'icons/svg/blood.svg',
                description: `<p>${t('Луна забрала {total} ПЗ максимума — навсегда.', { total })}</p>`,
                changes: [{ key: 'system.attributes.hp.bonuses.overall', mode: 2, value: `-${total}` }],
                flags: { [MODULE_ID]: { moonHp: true } }
            };
            const existing = actor.effects.find(e => e.flags?.[MODULE_ID]?.moonHp);
            if (existing) await existing.update(data);
            else await actor.createEmbeddedDocuments('ActiveEffect', [data]);
        }
    }
    if (of('slot').length) {
        await actor.setFlag(MODULE_ID, 'extra_slots', (Number(actor.getFlag(MODULE_ID, 'extra_slots')) || 0) - of('slot').length);
    }
    if (of('stash').length) {
        const stash = getStash(actor);
        for (const o of of('stash')) {
            const i = stash.findIndex(d => d.flags?.[MODULE_ID]?.stash_key === o.ref);
            if (i < 0) continue;
            const quantity = (Number(stash[i].system?.quantity) || 1) - 1;
            if (quantity > 0) stash[i].system.quantity = quantity;
            else stash.splice(i, 1);
        }
        await actor.update({ [`flags.${MODULE_ID}.stash`]: stash });
    }
    if (of('gold').length) await pay(actor, goldChunk() * of('gold').length);
    await updateActorSynergies(actor);
}

// ==========================================
// ЛОТЫ
// ==========================================

/** Навыки, которые можно скопировать Чужой памятью: обычные (не уникальные), не всадники */
const commonSkill = item => isMemorySkill(item) && COMMON.includes(flagsOf(item).rarity) && !flagsOf(item).horseman && !flagsOf(item).scar;
// Сплав: пара сгорает вместе — неудаляемый навык в неё не входит
const fusable = item => commonSkill(item) && flagsOf(item).is_active && !flagsOf(item).fused && !flagsOf(item).undeletable;

/** Варианты Чужой памяти: кому → чей навык (не лежащий на весах и которого у получателя нет) */
export function copyOptions(offers = []) {
    const offered = new Set(offers.filter(o => o.kind === 'skill').map(o => o.ref));
    const party = dealParty();
    const options = [];
    for (const target of party) {
        const owned = new Set(target.items.filter(isMemorySkill).map(i => currentSkillName(flagsOf(i), i.name).toLowerCase()));
        for (const source of party.filter(a => a.id !== target.id)) {
            for (const item of source.items.filter(commonSkill)) {
                const name = currentSkillName(flagsOf(item), item.name);
                if (offered.has(item.id) || owned.has(name.toLowerCase())) continue;
                options.push({ targetId: target.id, sourceId: source.id, itemId: item.id, name,
                    label: `${target.name} ← «${name}» (${source.name})` });
            }
        }
    }
    return options;
}

/** Варианты Сплава: персонаж и его экипированные обычные навыки вне пар, не лежащие на весах */
export function fuseOptions(offers = []) {
    const offered = new Set(offers.filter(o => o.kind === 'skill').map(o => o.ref));
    return dealParty().map(actor => ({
        actor,
        skills: actor.items.filter(i => fusable(i) && !offered.has(i.id))
    })).filter(o => o.skills.length >= 2);
}

/** Мастер выбирает, кому достаётся лот (Чужая память и Сплав) */
async function chooseGrant(lot, offers) {
    const { DialogV2 } = foundry.applications.api;
    if (lot === 'copy') {
        const options = copyOptions(offers);
        if (!options.length) return ui.notifications.warn(t('Чужая память: копировать нечего — у товарищей нет обычных навыков, которых нет у получателя.')), null;
        const choice = await DialogV2.prompt({
            window: { title: t('Чужая память') },
            content: `<p>${t('Кто получит копию и чей навык:')}</p><select name="pick" style="width:100%">${options.map((o, i) => `<option value="${i}">${esc(o.label)}</option>`).join('')}</select>`,
            ok: { label: t('Выбрать'), callback: (event, button) => Number(button.form.elements.pick.value) },
            rejectClose: false
        });
        return choice == null ? null : options[choice];
    }
    if (lot === 'fuse') {
        const groups = fuseOptions(offers);
        if (!groups.length) return ui.notifications.warn(t('Сплав: ни у кого нет двух экипированных обычных навыков вне пар.')), null;
        const pairs = groups.flatMap(({ actor, skills }) => skills.flatMap((a, i) => skills.slice(i + 1).map(b => ({
            actorId: actor.id, a: a.id, b: b.id, label: `${actor.name}: «${a.name}» + «${b.name}»`
        }))));
        const choice = await DialogV2.prompt({
            window: { title: t('Сплав') },
            content: `<p>${t('Какие два навыка сплавить:')}</p><select name="pick" style="width:100%">${pairs.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join('')}</select>`,
            ok: { label: t('Сплавить'), callback: (event, button) => Number(button.form.elements.pick.value) },
            rejectClose: false
        });
        return choice == null ? null : pairs[choice];
    }
    return {};
}

/** Выдать лот — только Мастер. @returns {string} строка для карточки */
async function grant(lot, params, deal) {
    if (lot === 'copy') {
        const target = game.actors.get(params.targetId);
        const result = await addSkillToMemory(target, params.name, { forced: true });
        return t('{v} получает копию «{v2}»{v3}.', { v: esc(target.name), v2: esc(params.name), v3: result.status === 'replaced' ? t(' (вытеснен «{v}»)', { v: esc(result.replacedName) }) : '' });
    }
    if (lot === 'fuse') {
        const actor = game.actors.get(params.actorId);
        const a = actor.items.get(params.a), b = actor.items.get(params.b);
        await a.setFlag(MODULE_ID, 'fused', { partner: b.id });
        await b.setFlag(MODULE_ID, 'fused', { partner: a.id, secondary: true });
        await updateActorSynergies(actor);
        return t('{v}: «{v2}» и «{v3}» сплавлены — один слот на двоих.', { v: esc(actor.name), v2: esc(a.name), v3: esc(b.name) });
    }
    // Отголосок Босса и Натравить Пожирателя — на следующий этаж: отметка у отряда, вызывает Мастер
    const boons = foundry.utils.deepClone(game.settings.get(MODULE_ID, 'moonBoons') ?? []);
    // Отголосок помнит Босса этого боя; при вызове Мастер может выбрать другого
    boons.push({ type: lot, floor: (deal.floor ?? getFloor()) + 1, used: false, ...(lot === 'echo' ? { boss: findBoss() } : {}) });
    await game.settings.set(MODULE_ID, 'moonBoons', boons);
    return lot === 'echo'
        ? t('Однажды на следующем этаже Босс встанет на сторону отряда — на один ход.')
        : t('Однажды на следующем этаже Пожиратель придёт за врагами отряда — и унесёт кристалл из добычи.');
}

// ==========================================
// ОПЕРАЦИИ (выполняет Мастер)
// ==========================================

async function performDealOp({ op, userId, ...data }) {
    const found = currentDealNode();
    const deal = found?.node.deal;
    if (!deal || deal.status !== 'open') return;
    const user = game.users.get(userId);
    const owns = actor => user?.isGM || actor?.testUserPermission(user, 'OWNER');

    if (op === 'lot') {
        if (!deal.lots.includes(data.lot)) return;
        deal.lot = data.lot;
        return saveDeal(found, deal);
    }
    if (op === 'offer') {
        const actor = game.actors.get(data.actorId);
        if (!actor || !owns(actor)) return;
        const option = sacrifices(actor, deal.offers).find(s => s.kind === data.kind && s.ref === data.ref);
        if (!option) return notifyUser(userId, t('Этого луне уже не отдать.'));
        deal.offers.push({ id: foundry.utils.randomID(), actorId: actor.id, kind: option.kind, ref: option.ref, w: option.w,
            label: option.label, color: option.color ?? null, icon: option.icon ?? null });
        return saveDeal(found, deal);
    }
    if (op === 'retract') {
        const offer = deal.offers.find(o => o.id === data.offerId);
        if (!offer || !owns(game.actors.get(offer.actorId))) return;
        deal.offers = deal.offers.filter(o => o.id !== offer.id);
        return saveDeal(found, deal);
    }
    if (!user?.isGM) return;
    if (op === 'refuse') {
        deal.status = 'refused';
        await saveDeal(found, deal);
        emit('closeDeal');
        DealWindow.close();
        return ChatMessage.create({ speaker: { alias: t('Луна') }, content: `<div class="gd-moon-card"><i class="fas fa-moon"></i> ${t('Отряд отверг сделку. Луна отворачивается — пока.')}</div>` });
    }
    if (op === 'seal') {
        const lot = LOTS[deal.lot];
        if (weightOf(deal) < lot.price) return notifyUser(userId, t('На весах {v} из {price} — луна не согласна.', { v: weightOf(deal), price: lot.price }));
        const params = data.params ?? {};
        // Жертвы — по персонажам; лот выдаётся после: навыки на весах в Сплав и копию не попадают
        const byActor = new Map();
        for (const o of deal.offers) byActor.set(o.actorId, [...(byActor.get(o.actorId) ?? []), o]);
        const taken = [];
        for (const [actorId, offers] of byActor) {
            const actor = game.actors.get(actorId);
            if (!actor) continue;
            taken.push(`<li><strong>${esc(actor.name)}</strong>: ${offers.map(o => esc(o.label)).join(', ')}</li>`);
            await takeFrom(actor, offers);
        }
        const result = await grant(deal.lot, params, deal);
        deal.status = 'sealed';
        deal.result = { lot: deal.lot, text: result };
        await saveDeal(found, deal);
        emit('dealSealed');
        DealWindow.sealed();
        return ChatMessage.create({
            speaker: { alias: t('Луна') },
            content: `<div class="gd-moon-card"><div class="gd-moon-title"><i class="fas fa-moon"></i> ${t('Сделка луны — {v}', { v: esc(lot.name) })}</div>
                <p>${t('Луна забрала:')}</p><ul>${taken.join('')}</ul><p>${result}</p></div>`
        });
    }
}

const request = payload => requestGM('dealOp', payload);
let queue = Promise.resolve();
onSocket('dealOp', message => {
    if (!isActiveGM()) return;
    queue = queue.then(() => performDealOp(message.payload)).catch(error => console.error(`${MODULE_ID} | Сделка луны`, error));
    return queue;
});
onSocket('openDeal', () => DealWindow.show());
onSocket('closeDeal', () => DealWindow.close());
onSocket('dealSealed', () => DealWindow.sealed());

export function registerDealSettings() {
    // Отметки Эха Босса и Натравить Пожирателя: { type, floor, used }
    game.settings.register(MODULE_ID, 'moonBoons', { scope: 'world', config: false, type: Array, default: [] });
    // Лоты, подсмотренные событием: { floor, lots } — Сделка этого этажа предложит их
    game.settings.register(MODULE_ID, 'dealPreset', { scope: 'world', config: false, type: Object, default: {} });
}

// ==========================================
// СПЛАВ: пара навыков живёт и сгорает вместе
// ==========================================

// Один из пары сгорел — сгорает и второй
Hooks.on('deleteItem', (item, options, userId) => {
    if (userId !== game.user.id) return;
    const partner = item.actor?.items.get(flagsOf(item).fused?.partner);
    // Пара сгорает с тем же поводом (жертва луне, Очистка) — Летопись этажа отличает их от сгоревших
    if (partner) partner.delete({ gachadndMoon: !!options.gachadndMoon, gachadndCleanse: !!options.gachadndCleanse });
});

// Экипировка пары — вместе
Hooks.on('updateItem', (item, changes, options, userId) => {
    if (userId !== game.user.id || !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.is_active`)) return;
    const partner = item.actor?.items.get(flagsOf(item).fused?.partner);
    const active = !!flagsOf(item).is_active;
    if (partner && !!flagsOf(partner).is_active !== active) setSkillEquipped(partner, active);
});

// ==========================================
// ОКНО
// ==========================================
//
// Сцена, а не форма: луна-кукловод над весами, на её нитях висят три лота. Выбранный лот она опускает
// к себе под ноги — он ось коромысла. Фаза луны — набранная доля цены: серп растёт до полнолуния, и
// тогда у луны проступает лицо. Слева портреты отряда — от каждого луна откалывает по куску за жертву.
// Внизу рука игрока: навыки веером, как карты, и жетоны тела. Печать скрепляет только Мастер.
// Каркас рисуется один раз (анимации не перезапускаются); состояние раскладывается по нему в #sync.

const ID = 'gachadnd-moon-deal';
const SLOTS = { center: [485, 280], left: [70, 80], right: [900, 80] };

export class DealWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: ID,
        classes: ['gachadnd-moon-deal'],
        tag: 'div',
        window: { title: t('Сделка луны'), icon: 'fas fa-moon', resizable: false },
        position: { width: 1120, height: 760 },
        actions: {
            lot: DealWindow.#onLot,
            offer: DealWindow.#onOffer,
            retract: DealWindow.#onRetract,
            hand: DealWindow.#onHand,
            seal: DealWindow.#onSeal,
            refuse: DealWindow.#onRefuse
        }
    };

    static PARTS = { stage: { template: `modules/${MODULE_ID}/templates/moon-deal/stage.hbs` } };

    /** Мастер открывает сделку на узле Босса — у всех */
    static async open() {
        if (!game.user.isGM) return DealWindow.show();
        const found = currentDealNode();
        if (!found) return ui.notifications.warn(t('Сделка луны — только на узле Босса, после боя.'));
        if (found.node.deal && found.node.deal.status !== 'open') return ui.notifications.warn(t('На этом этаже луна уже предлагала сделку.'));
        if (!found.node.deal) await saveDeal(found, newDeal());
        emit('openDeal');
        return DealWindow.show();
    }

    static show() {
        const existing = foundry.applications.instances?.get(ID);
        if (existing) return existing.render({ force: true }).then(() => existing.bringToFront?.());
        return new DealWindow().render({ force: true });
    }

    static close() {
        foundry.applications.instances?.get(ID)?.close();
    }

    /** Печать: луна насыщается, окно гаснет */
    static sealed() {
        const app = foundry.applications.instances?.get(ID);
        if (!app?.rendered) return;
        app.element.querySelector('.gd-deal-stage')?.classList.add('sealed');
        setTimeout(() => app.close(), 3200);
    }

    handId = null;

    async _prepareContext() {
        return { isGM: game.user.isGM, lots: Object.entries(LOTS).map(([id, l]) => ({ id, ...l })) };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this.#sync();
        clearInterval(this.#timer);
        // Нити тянутся за качающимися картами
        this.#timer = setInterval(() => this.#threads(), 120);
    }

    _onClose(options) {
        clearInterval(this.#timer);
        super._onClose(options);
    }

    #timer = null;

    /** Чья рука внизу: свой персонаж игрока; Мастер выбирает портретом */
    #hand(party) {
        const own = party.filter(a => game.user.isGM || a.isOwner);
        return own.find(a => a.id === this.handId) ?? own.find(a => a.id === game.user.character?.id) ?? own[0] ?? null;
    }

    sync() { if (this.rendered) this.#sync(); }

    #sync() {
        const root = this.element?.querySelector('.gd-deal-stage');
        const deal = currentDealNode()?.node.deal;
        if (!root || !deal) return;
        const party = dealParty();
        const hand = this.#hand(party);
        this.handId = hand?.id ?? null;
        const lot = LOTS[deal.lot];
        const weight = weightOf(deal);
        const ratio = Math.min(1, weight / lot.price);

        // Лоты: выбранный — в центре, остальные по краям
        const others = deal.lots.filter(id => id !== deal.lot);
        root.querySelectorAll('.gd-lot').forEach(el => {
            const id = el.dataset.lot;
            el.hidden = !deal.lots.includes(id);
            const slot = id === deal.lot ? 'center' : id === others[0] ? 'left' : 'right';
            el.style.left = `${SLOTS[slot][0]}px`;
            el.style.top = `${SLOTS[slot][1]}px`;
            el.classList.toggle('on', id === deal.lot);
        });

        // Луна: тень уезжает по мере набора веса
        root.querySelector('.gd-md-shadow').style.left = `${-4 + ratio * 104}%`;
        root.querySelector('.gd-md-moon').classList.toggle('full', ratio >= 1);
        root.querySelector('.gd-weight').innerHTML = ratio >= 1
            ? t('полнолуние<small>луна согласна</small>')
            : `${t('{v} из {price}', { v: fmt(weight), price: lot.price })}<small>${t('до полнолуния')}</small>`;

        // Весы
        const tilt = Math.max(-12, Math.min(12, (weight - lot.price) * 2));
        root.querySelector('.gd-beam').style.transform = `rotate(${-tilt}deg)`;
        root.querySelector('.gd-pan.left').style.transform = `translateY(${tilt * 4.6}px)`;
        root.querySelector('.gd-pan.right').style.transform = `translateY(${-tilt * 4.6}px)`;
        const mayRetract = o => game.user.isGM || game.actors.get(o.actorId)?.isOwner;
        // Гирьки: новые падают на чашу, уже лежащие не трогаются (иначе анимация повторяется при каждом обновлении)
        const load = root.querySelector('.gd-load.left');
        const kept = new Map([...load.children].map(el => [el.dataset.id, el]));
        load.replaceChildren(...deal.offers.map(o => {
            const own = mayRetract(o);
            const el = kept.get(o.id) ?? Object.assign(document.createElement('div'), { className: 'gd-offer new' });
            el.dataset.id = o.id;
            el.classList.toggle('own', own);
            el.style.setProperty('--c', o.color ?? '#d9dbe8');
            if (own) Object.assign(el.dataset, { action: 'retract', offer: o.id });
            el.dataset.tooltip = `${game.actors.get(o.actorId)?.name ?? ''}: ${o.label}${own ? t(' — щёлкните, чтобы забрать') : ''}`;
            el.textContent = fmt(o.w);
            return el;
        }));
        root.querySelector('.gd-load.right').innerHTML = Array.from({ length: lot.price }, () => '<div class="gd-stone"></div>').join('');

        // Отряд: сколы на портретах — по жертвам
        root.querySelector('.gd-party').innerHTML = party.map(actor => {
            const offers = deal.offers.filter(o => o.actorId === actor.id);
            const shards = [1, 2, 3].map(n => `<i class="gd-shard s${n}${offers.length >= n ? ' on' : ''}"></i>`).join('');
            const pickable = game.user.isGM || actor.isOwner;
            return `<div class="gd-member${actor.id === hand?.id ? ' active' : ''}" ${pickable ? `data-action="hand" data-actor="${actor.id}"` : ''}>
                <div class="gd-portrait" style="background-image:url('${esc(actor.img)}')">${shards}</div>
                <div><div class="gd-name">${esc(actor.name)}</div><div class="gd-paid" data-tooltip="${esc(offers.map(o => o.label).join(', '))}">${offers.length ? offers.map(o => esc(o.label)).join(', ') : t('пока ничего')}</div></div></div>`;
        }).join('');

        // Рука: навыки веером и жетоны тела
        const options = hand ? sacrifices(hand, deal.offers) : [];
        const skills = options.filter(o => o.kind === 'skill');
        root.querySelector('.gd-fan').innerHTML = skills.map((o, i) => {
            const angle = (i - (skills.length - 1) / 2) * Math.min(12, 90 / Math.max(1, skills.length));
            return `<div class="gd-card" style="--c:${o.color}; --a:${angle}deg" data-action="offer" data-kind="skill" data-ref="${o.ref}" data-tooltip="${esc(o.label)}">
                <div class="r">${RARITY_LABEL[o.rarity]}</div><div class="nm">${esc(o.short)}</div><div class="w">${fmt(o.w)}</div></div>`;
        }).join('');
        const tokens = [...options.filter(o => o.kind === 'stash'), ...['hd', 'hp', 'slot', 'gold'].map(k => options.find(o => o.kind === k) ?? { kind: k, ...BODY[k], gone: true })];
        root.querySelector('.gd-tokens').innerHTML = tokens.map(o => o.kind === 'stash'
            ? `<div class="gd-token crystal" style="--c:${o.color}" data-action="offer" data-kind="stash" data-ref="${o.ref}" data-tooltip="${esc(o.label)}"><i class="fas fa-gem"></i><b>${fmt(o.w)}</b><small>${esc(o.short)}${o.left > 1 ? ` ×${o.left}` : ''}</small></div>`
            : `<div class="gd-token${o.gone ? ' gone' : ''}" ${o.gone ? '' : `data-action="offer" data-kind="${o.kind}" data-ref="${o.ref}"`} data-tooltip="${esc(o.gone ? t('{label}: луне больше не отдать', { label: BODY[o.kind].label }) : o.label)}"><i class="fas ${BODY[o.kind].icon}"></i><b>${fmt(BODY[o.kind].w)}</b><small>${esc(o.kind === 'gold' ? t('{v} зм', { v: goldChunk() }) : BODY[o.kind].short)}</small></div>`).join('');
        root.querySelector('.gd-hint').textContent = hand ? t('{name}: отдайте луне часть себя — щёлкните', { name: hand.name }) : t('у вас нет персонажа в отряде');

        root.querySelector('.gd-seal')?.classList.toggle('ready', ratio >= 1);
        this.#threads();
    }

    // Нити от края луны к картам и к оси весов
    #threads() {
        const root = this.element?.querySelector('.gd-deal-stage');
        const svg = root?.querySelector('.gd-threads');
        if (!svg) return;
        const stage = root.getBoundingClientRect();
        const moon = root.querySelector('.gd-md-moon').getBoundingClientRect();
        const cx = moon.left + moon.width / 2 - stage.left, cy = moon.top + moon.height / 2 - stage.top, R = moon.width / 2;
        const curve = (x2, y2, taut) => {
            const a = Math.atan2(y2 - cy, x2 - cx), x1 = cx + Math.cos(a) * R * 0.96, y1 = cy + Math.sin(a) * R * 0.96;
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 + (taut ? 4 : 26);
            return `<path class="${taut ? 'taut' : ''}" d="M${x1},${y1} Q${mx},${my} ${x2},${y2}"/>`;
        };
        const paths = [...root.querySelectorAll('.gd-lot:not([hidden])')].map(l => {
            const r = l.getBoundingClientRect();
            return curve(r.left + r.width / 2 - stage.left, r.top - stage.top + 6, l.classList.contains('on'));
        });
        const beam = root.querySelector('.gd-beam').getBoundingClientRect();
        paths.push(curve(beam.left + beam.width / 2 - stage.left, beam.top - stage.top, true));
        svg.innerHTML = paths.join('');
    }

    static #onLot(event, target) {
        request({ op: 'lot', lot: target.dataset.lot });
    }

    static #onOffer(event, target) {
        if (this.handId) request({ op: 'offer', actorId: this.handId, kind: target.dataset.kind, ref: target.dataset.ref });
    }

    static #onRetract(event, target) {
        request({ op: 'retract', offerId: target.dataset.offer });
    }

    static #onHand(event, target) {
        this.handId = target.dataset.actor;
        this.#sync();
    }

    static async #onSeal() {
        const deal = currentDealNode()?.node.deal;
        if (!deal) return;
        const lot = LOTS[deal.lot];
        if (weightOf(deal) < lot.price) return ui.notifications.warn(t('На весах {v} из {price} — луна не согласна.', { v: fmt(weightOf(deal)), price: lot.price }));
        const params = await chooseGrant(deal.lot, deal.offers);
        if (!params) return;
        request({ op: 'seal', params });
    }

    static async #onRefuse() {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t('Отвергнуть сделку') }, content: t('<p>Луна отвернётся до следующего этажа. Жертвы останутся при отряде.</p>'), rejectClose: false
        });
        if (ok) request({ op: 'refuse' });
    }
}

const fmt = w => (Number.isInteger(w) ? String(w) : w.toFixed(1).replace('.', ','));

// Состояние меняется — окно раскладывает его заново, не перерисовывая каркас
const resync = () => foundry.applications.instances?.get(ID)?.sync?.();
Hooks.on('updateScene', (scene, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) resync();
});
for (const hook of ['updateActor', 'createItem', 'deleteItem', 'updateItem']) Hooks.on(hook, resync);
