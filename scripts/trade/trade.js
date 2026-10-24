/**
 * Gacha Roguelike dnd5e — Обмен между игроками
 *
 * Игрок щёлкает правой кнопкой по токену товарища (персонаж другого игрока, тот в игре) — окно обмена
 * открывается у обоих. Каждый собирает своё предложение: монеты и предметы (кристаллы — тоже), и видит
 * предложение другого. Любая правка снимает оба «Согласен»; оба согласны — сделка проходит, в чат — запись,
 * кто что отдал. Сделка между парой одна: второй щелчок (любого из двоих) открывает то же окно.
 *
 * Состояние — в памяти клиентов, по сокету; Мастер не нужен. Каждый пишет только свою сторону. Проводит сделку
 * активный Мастер; без него — каждый участник свою половину: сначала оба подтверждают, что отдаваемое на месте,
 * потом каждый отдаёт своё и создаёт себе полученное. Мастер видит все сделки (шёпот «Наблюдать» — подсказка,
 * отключается), правит обе стороны, отменяет или проводит сразу.
 */

import { MODULE_ID } from "../core/constants.js";
import { emit, onSocket, isActiveGM } from "../core/socket.js";
import { onRenderChatMessage } from "../core/chat-hooks.js";
import { hint } from "../core/prefs.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const COINS = ['pp', 'gp', 'ep', 'sp', 'cp'];
const COIN_NAMES = { pp: 'пм', gp: 'зм', ep: 'эм', sp: 'см', cp: 'мм' };
/** Что можно отдать: вещи из инвентаря; контейнеры — нет (их содержимое осталось бы у владельца) */
const GOODS = ['weapon', 'equipment', 'consumable', 'tool', 'loot'];

/** Сделки: id → { id, created, state: open | done | cancelled, sides: { a, b }, valid: { a, b }, halves: { a, b } } */
const TRADES = new Map();
const emptyGold = () => Object.fromEntries(COINS.map(c => [c, 0]));
const sideOf = (actor, user) => ({ userId: user.id, actorId: actor.id, name: actor.name, img: actor.img, gold: emptyGold(), items: [], ready: false });
const otherKey = key => key === 'a' ? 'b' : 'a';
const myKey = trade => ['a', 'b'].find(k => trade.sides[k].userId === game.user.id) ?? null;
/** Отпечаток предложения: монеты и что за предметы сколько */
const sig = side => JSON.stringify([COINS.map(c => side.gold[c] || 0), side.items.map(e => [e.id, e.qty])]);
const agreed = trade => trade.sides.a.sees === sig(trade.sides.b) && trade.sides.b.sees === sig(trade.sides.a);
const pairOf = trade => [trade.sides.a.actorId, trade.sides.b.actorId].sort().join(':');

/** Вещь, которую можно отдать */
export const tradable = item => GOODS.includes(item.type) && !item.system?.container;

/** Снимок предмета для передачи: без id и места в контейнере, снят с пояса, нужное количество */
function snapshot(item, qty) {
    const data = item.toObject();
    delete data._id;
    delete data._stats;
    data.system ??= {};
    data.system.quantity = qty;
    if ('equipped' in data.system) data.system.equipped = false;
    if ('container' in data.system) data.system.container = null;
    return data;
}

// ==========================================
// СОСТОЯНИЕ: каждое действие — у себя и всем по сокету
// ==========================================

const OPS = {
    // Сделка открыта: если между этой парой уже есть открытая — остаётся та, что раньше
    open({ trade }) {
        const same = [...TRADES.values()].find(t => t.state === 'open' && t.id !== trade.id && pairOf(t) === pairOf(trade));
        if (same && same.created <= trade.created) return same;
        if (same) TRADES.delete(same.id);
        if (!TRADES.has(trade.id)) TRADES.set(trade.id, trade);
        return TRADES.get(trade.id);
    },
    // Сторона поменяла предложение — оба «Согласен» снимаются
    side({ id, key, gold, items }) {
        const trade = TRADES.get(id);
        if (!trade || trade.state !== 'open') return;
        Object.assign(trade.sides[key], { gold, items });
        trade.sides.a.ready = trade.sides.b.ready = false;
        trade.valid = {};
        return trade;
    },
    // «Согласен» несёт всё своё предложение и отпечаток увиденного у партнёра: потерянная по дороге правка не
    // проведёт не то, что видели оба. Сделку, о которой клиент не слышал, он заводит по заголовку
    ready({ id, key, ready, side, sees, header }) {
        let trade = TRADES.get(id);
        if (!trade && header) TRADES.set(id, trade = header);
        if (!trade || trade.state !== 'open') return;
        if (ready && side) Object.assign(trade.sides[key], { gold: side.gold, items: side.items });
        Object.assign(trade.sides[key], { ready, sees: ready ? sees : null });
        if (!ready) trade.valid = {};
        // Оба согласны, но видели разное — оба «Согласен» снимаются (у всех одинаково)
        if (trade.sides.a.ready && trade.sides.b.ready && !agreed(trade)) {
            for (const k of ['a', 'b']) Object.assign(trade.sides[k], { ready: false, sees: null });
            if (myKey(trade)) ui.notifications.warn('Предложения разошлись, пока вы соглашались, — посмотрите ещё раз и нажмите «Согласен».');
        }
        return trade;
    },
    // Без Мастера: участник проверил, что отдаваемое на месте, и прислал свежие снимки предметов
    valid({ id, key, ok, items }) {
        const trade = TRADES.get(id);
        if (!trade || trade.state !== 'open') return;
        if (!ok) { trade.sides.a.ready = trade.sides.b.ready = false; trade.valid = {}; return trade; }
        trade.sides[key].items = items;
        (trade.valid ??= {})[key] = true;
        return trade;
    },
    half({ id, key }) {
        const trade = TRADES.get(id);
        if (!trade) return;
        (trade.halves ??= {})[key] = true;
        return trade;
    },
    state({ id, state }) {
        const trade = TRADES.get(id);
        if (!trade) return;
        trade.state = state;
        return trade;
    }
};

function apply(op, data) {
    const trade = OPS[op](data);
    if (trade) afterChange(trade, op);
    return trade;
}
/** Действие — у себя и у всех: каждый клиент держит свою копию сделок */
function send(op, data) {
    emit('trade', { op, data });
    return apply(op, data);
}
onSocket('trade', ({ op, data }) => { if (OPS[op]) apply(op, foundry.utils.deepClone(data)); });
// Вошёл в игру — попросить открытые сделки у остальных
onSocket('tradeSync', () => { for (const trade of TRADES.values()) if (trade.state === 'open') emit('trade', { op: 'open', data: { trade } }); });
Hooks.once('ready', () => emit('tradeSync', {}));

const running = new Set();
function afterChange(trade, op) {
    TradeWindow.refresh(trade);
    const mine = myKey(trade);
    // Окно — у второго участника сразу, как сделка открыта
    if (op === 'open' && mine && trade.state === 'open') TradeWindow.show(trade.id);
    // Закрытая сделка уходит из памяти чуть позже окна
    if (trade.state !== 'open') return setTimeout(() => TRADES.delete(trade.id), 4000);
    const both = trade.sides.a.ready && trade.sides.b.ready && agreed(trade);
    if (!both || running.has(`${trade.id}:${op}`)) return;
    if (game.users.activeGM) {
        if (isActiveGM() && op === 'ready') { running.add(`${trade.id}:${op}`); settle(trade).finally(() => running.delete(`${trade.id}:${op}`)); }
        return;
    }
    // Без Мастера: проверить своё → когда обе стороны проверены, отдать своё и принять чужое
    if (!mine) return;
    if (op === 'ready') validateMine(trade, mine);
    if (op === 'valid' && trade.valid?.a && trade.valid?.b && !trade.halves?.[mine]) { running.add(`${trade.id}:${op}`); swapHalf(trade, mine).finally(() => running.delete(`${trade.id}:${op}`)); }
    if (op === 'half' && trade.halves?.a && trade.halves?.b && mine === 'a') finish(trade);
}

// ==========================================
// ПРОВЕДЕНИЕ
// ==========================================

/** Чего не хватает у отдающего: монет или предметов (их количества) */
function shortage(actor, side) {
    const out = [];
    for (const c of COINS) if ((side.gold[c] || 0) > (Number(actor.system.currency?.[c]) || 0)) out.push(`${side.gold[c]} ${COIN_NAMES[c]}`);
    for (const entry of side.items) {
        const item = actor.items.get(entry.id);
        if (!item || (item.system.quantity ?? 1) < entry.qty) out.push(entry.name);
    }
    return out;
}

/** Отдать своё: монеты и предметы уходят с персонажа */
async function giveAway(actor, side) {
    const currency = Object.fromEntries(COINS.map(c => [c, (Number(actor.system.currency?.[c]) || 0) - (side.gold[c] || 0)]));
    await actor.update({ 'system.currency': currency });
    const gone = [], less = [];
    for (const entry of side.items) {
        const item = actor.items.get(entry.id);
        if (!item) continue;
        const left = (item.system.quantity ?? 1) - entry.qty;
        if (left > 0) less.push({ _id: item.id, 'system.quantity': left }); else gone.push(item.id);
    }
    if (less.length) await actor.updateEmbeddedDocuments('Item', less);
    if (gone.length) await actor.deleteEmbeddedDocuments('Item', gone);
}
/** Принять чужое: монеты прибавляются, предметы создаются из снимков */
async function receive(actor, side) {
    const currency = Object.fromEntries(COINS.map(c => [c, (Number(actor.system.currency?.[c]) || 0) + (side.gold[c] || 0)]));
    await actor.update({ 'system.currency': currency });
    const data = side.items.map(entry => foundry.utils.mergeObject(foundry.utils.deepClone(entry.data), { 'system.quantity': entry.qty }));
    if (data.length) await actor.createEmbeddedDocuments('Item', data);
}

/** Мастер проводит сделку целиком: проверка обеих сторон, потом обмен — по живым предметам */
async function settle(trade) {
    const { a, b } = trade.sides;
    const A = game.actors.get(a.actorId), B = game.actors.get(b.actorId);
    if (!A || !B) return;
    const lackA = shortage(A, a), lackB = shortage(B, b);
    if (lackA.length || lackB.length) {
        send('ready', { id: trade.id, key: 'a', ready: false });
        send('ready', { id: trade.id, key: 'b', ready: false });
        return notifyBoth(trade, `Обмен не прошёл — не хватает: ${[...lackA.map(x => `${a.name}: ${x}`), ...lackB.map(x => `${b.name}: ${x}`)].join(', ')}.`);
    }
    const fresh = (actor, side) => ({ ...side, items: side.items.map(entry => ({ ...entry, data: snapshot(actor.items.get(entry.id), entry.qty) })) });
    const [sa, sb] = [fresh(A, a), fresh(B, b)];
    await giveAway(A, sa); await giveAway(B, sb);
    await receive(B, sa); await receive(A, sb);
    await finish(trade);
}

/** Без Мастера: участник проверяет свою сторону и шлёт свежие снимки */
function validateMine(trade, key) {
    const side = trade.sides[key], actor = game.actors.get(side.actorId);
    const lack = actor ? shortage(actor, side) : ['персонажа нет'];
    if (lack.length) ui.notifications.warn(`Обмен не прошёл — у вас не хватает: ${lack.join(', ')}.`);
    const items = lack.length ? side.items : side.items.map(entry => ({ ...entry, data: snapshot(actor.items.get(entry.id), entry.qty) }));
    send('valid', { id: trade.id, key, ok: !lack.length, items });
}
async function swapHalf(trade, key) {
    const actor = game.actors.get(trade.sides[key].actorId);
    await giveAway(actor, trade.sides[key]);
    await receive(actor, trade.sides[otherKey(key)]);
    send('half', { id: trade.id, key });
}

/** Сделка прошла: запись в чат для всех — кто что отдал */
async function finish(trade) {
    send('state', { id: trade.id, state: 'done' });
    const list = side => {
        const coins = COINS.filter(c => side.gold[c] > 0).map(c => `${side.gold[c]} ${COIN_NAMES[c]}`);
        const items = side.items.map(e => `${e.name}${e.qty > 1 ? ` ×${e.qty}` : ''}`);
        return [...coins, ...items].join(', ') || 'ничего';
    };
    const { a, b } = trade.sides;
    await ChatMessage.create({
        speaker: { alias: 'Обмен' },
        content: `<div class="gd-trade-card"><div class="gd-trade-card-title"><i class="fas fa-handshake"></i> ${esc(a.name)} ⇄ ${esc(b.name)}</div>
            <p><b>${esc(a.name)}</b> отдаёт: ${esc(list(a))}</p><p><b>${esc(b.name)}</b> отдаёт: ${esc(list(b))}</p></div>`
    });
}

function notifyBoth(trade, text) {
    for (const key of ['a', 'b']) {
        const userId = trade.sides[key].userId;
        if (userId === game.user.id) ui.notifications.warn(text); else emit('notify', { userId, text });
    }
    if (game.user.isGM) ui.notifications.warn(text);
}
const esc = text => foundry.utils.escapeHTML?.(String(text)) ?? String(text);

// ==========================================
// НАЧАТЬ: правый щелчок по токену товарища
// ==========================================

/** Свой персонаж игрока: назначенный, иначе выбранный свой токен */
function myActor() {
    return game.user.character ?? canvas.tokens?.controlled.find(t => t.actor?.isOwner && t.actor.type === 'character')?.actor ?? null;
}
/** Игрок, который ведёт персонажа: тот, кому он назначен, иначе владелец-игрок; только в игре */
function playerOf(actor) {
    const users = game.users.filter(u => !u.isGM && u.active);
    return users.find(u => u.character?.id === actor.id) ?? users.find(u => actor.testUserPermission(u, 'OWNER')) ?? null;
}

/** Предложить обмен персонажу (game.gachadnd.trade.offer(actor)) */
export function offerTrade(partner) {
    const mine = myActor();
    if (!mine) return ui.notifications.warn('Назначьте себе персонажа или выберите свой токен — обмен идёт от него.');
    if (!partner || partner.id === mine.id) return;
    const user = playerOf(partner);
    if (!user) return ui.notifications.warn(`${partner.name}: игрока нет в игре — обмен только вживую.`);
    const trade = send('open', { trade: {
        id: foundry.utils.randomID(), created: Date.now(), state: 'open',
        sides: { a: sideOf(mine, game.user), b: sideOf(partner, user) }, valid: {}, halves: {}
    } });
    if (hint('hintTrade') && trade.sides.a.userId === game.user.id) whisperGM(trade);
}

// Шёпот Мастеру: кто с кем меняется. Кнопку «Наблюдать» дорисовывает клиент Мастера по флагу — из сообщения
// игрока Foundry кнопки вырезает
function whisperGM(trade) {
    const gms = game.users.filter(u => u.isGM).map(u => u.id);
    if (!gms.length) return;
    ChatMessage.create({
        speaker: { alias: 'Обмен' }, whisper: gms,
        content: `<div class="gd-trade-card"><div class="gd-trade-card-title"><i class="fas fa-handshake"></i> ${esc(trade.sides.a.name)} ⇄ ${esc(trade.sides.b.name)}</div><p>Идёт обмен.</p></div>`,
        flags: { [MODULE_ID]: { tradeWatch: trade.id } }
    });
}
onRenderChatMessage((message, html) => {
    const id = message.getFlag?.(MODULE_ID, 'tradeWatch');
    const card = id && game.user.isGM && html.querySelector?.('.gd-trade-card');
    if (!card || card.querySelector('.gd-trade-watch')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gd-trade-watch';
    button.innerHTML = '<i class="fas fa-eye"></i> Наблюдать';
    button.addEventListener('click', event => {
        event.preventDefault();
        const trade = TRADES.get(id);
        if (!trade || trade.state !== 'open') return ui.notifications.info('Этой сделки уже нет.');
        TradeWindow.show(trade.id);
    });
    card.append(button);
});

// Правый щелчок по токену персонажа другого игрока (своих токенов и Мастера это не касается: у них — панель токена).
// Foundry снимает обработчики токена, когда подключает свои щелчки, — поэтому вешаем при каждом обновлении, если нет
function onRightClick(event) {
    const actor = this.actor;
    if (game.user.isGM || !actor || actor.type !== 'character' || actor.isOwner || !actor.hasPlayerOwner) return;
    event.stopPropagation?.();
    offerTrade(actor);
}
Hooks.on('refreshToken', token => {
    if (!game.user.isGM && !token.listeners('rightclick').includes(onRightClick)) token.on('rightclick', onRightClick, token);
});

// ==========================================
// ОКНО
// ==========================================

export class TradeWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(tradeId, options = {}) {
        super({ ...options, id: `gachadnd-trade-${tradeId}` });
        this.tradeId = tradeId;
    }

    static DEFAULT_OPTIONS = {
        classes: ['gachadnd-trade'],
        tag: 'div',
        window: { title: 'Обмен', icon: 'fas fa-handshake', resizable: true },
        position: { width: 760, height: 560 },
        actions: {
            add: TradeWindow.#onAdd,
            drop: TradeWindow.#onRemove,
            ready: TradeWindow.#onReady,
            cancel: TradeWindow.#onCancel,
            force: TradeWindow.#onForce
        }
    };

    static PARTS = { body: { template: 'modules/gachadnd/templates/trade/body.hbs', scrollable: ['.gd-trade-bag'] } };

    static show(tradeId) {
        const existing = foundry.applications.instances?.get(`gachadnd-trade-${tradeId}`) ?? TradeWindow.#made.get(tradeId);
        if (existing) return existing.render({ force: true });
        // Окно регистрируется после первой отрисовки — до неё второе такое же не создаём
        const app = new TradeWindow(tradeId);
        TradeWindow.#made.set(tradeId, app);
        return app.render({ force: true }).finally(() => TradeWindow.#made.delete(tradeId));
    }
    static #made = new Map();
    static refresh(trade) {
        const app = foundry.applications.instances?.get(`gachadnd-trade-${trade.id}`);
        if (!app?.rendered) return;
        app.render();
        // Сделка закрыта — окно уходит само через пару секунд, сама сделка — из памяти
        if (trade.state !== 'open') setTimeout(() => app.close(), 2500);
    }

    get trade() { return TRADES.get(this.tradeId); }

    get title() {
        const t = this.trade;
        return t ? `Обмен · ${t.sides.a.name} ⇄ ${t.sides.b.name}` : 'Обмен';
    }

    /** Чью сторону этот клиент может править: свою; Мастер — обе */
    canEdit(key) {
        return this.trade?.state === 'open' && (game.user.isGM || myKey(this.trade) === key);
    }

    async _prepareContext() {
        const trade = this.trade;
        if (!trade) return { gone: true };
        const mine = myKey(trade);
        // Слева — своя сторона (у Мастера — сторона a), справа — чужая
        const left = mine ?? 'a', right = otherKey(left);
        const column = key => {
            const side = trade.sides[key], edit = this.canEdit(key), actor = game.actors.get(side.actorId);
            const offered = new Map(side.items.map(e => [e.id, e.qty]));
            const bag = edit && actor ? actor.items.filter(tradable).map(item => {
                const have = item.system.quantity ?? 1;
                return { id: item.id, name: item.name, img: item.img, have, left: have - (offered.get(item.id) ?? 0), find: item.name.toLowerCase() };
            }).filter(i => i.left > 0).sort((x, y) => x.name.localeCompare(y.name)) : [];
            const purse = actor ? Object.fromEntries(COINS.map(c => [c, Number(actor.system.currency?.[c]) || 0])) : {};
            return {
                key, edit, name: side.name, img: side.img, ready: side.ready, search: this.#search[key] ?? '',
                coins: COINS.map(c => ({ c, label: COIN_NAMES[c], value: side.gold[c] || 0, purse: edit ? purse[c] : null })),
                items: side.items.map(e => ({ ...e, max: e.have })), bag, empty: !side.items.length && !COINS.some(c => side.gold[c] > 0)
            };
        };
        const l = column(left), r = column(right);
        l.title = mine ? 'Вы отдаёте' : 'отдаёт'; r.title = mine ? 'Вы получаете' : 'отдаёт';
        return {
            gm: game.user.isGM && !mine, mine: !!mine, state: trade.state, columns: [l, r],
            myReady: mine ? trade.sides[mine].ready : false,
            waiting: trade.state === 'open' && trade.sides.a.ready && trade.sides.b.ready
        };
    }

    // Поиск в сумке — по своей стороне; переживает перерисовку (товарищ правит своё, пока вы печатаете)
    #search = {};
    #typing = null;
    #filter(col) {
        const input = col.querySelector('.gd-trade-search');
        if (!input) return;
        const q = input.value.trim().toLowerCase();
        const buttons = [...col.querySelectorAll('.gd-trade-bag button[data-find]')];
        for (const b of buttons) b.hidden = !!q && !b.dataset.find.includes(q);
        const nothing = col.querySelector('.gd-trade-nothing');
        if (nothing) nothing.hidden = !q || buttons.some(b => !b.hidden) || !buttons.length;
    }

    _onRender(context, options) {
        super._onRender?.(context, options);
        const html = this.element;
        html.querySelectorAll('.gd-trade-search').forEach(input => {
            const col = input.closest('[data-side]'), key = col.dataset.side;
            input.addEventListener('input', () => { this.#search[key] = input.value; this.#filter(col); });
            input.addEventListener('focus', () => { this.#typing = key; });
            // Перерисовка снимает фокус без нового адресата — тогда поиск остаётся «в работе»
            input.addEventListener('blur', event => { if (event.relatedTarget && this.#typing === key) this.#typing = null; });
            this.#filter(col);
            if (this.#typing === key) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
        });
        // Монеты и количество: правка — своя сторона целиком
        html.querySelectorAll('input[data-coin], input[data-qty]').forEach(input => input.addEventListener('change', () => this.#pushSide(input.closest('[data-side]').dataset.side)));
        // Перетащить предмет со своего листа персонажа в окно
        html.querySelectorAll('[data-side]').forEach(col => {
            col.addEventListener('dragover', event => event.preventDefault());
            col.addEventListener('drop', event => this.#onDropItem(event, col.dataset.side));
        });
    }

    /** Отправить сторону: монеты и количества из полей окна */
    #pushSide(key, change = null) {
        const trade = this.trade;
        if (!trade || !this.canEdit(key)) return;
        const col = this.element.querySelector(`[data-side="${key}"]`);
        const actor = game.actors.get(trade.sides[key].actorId);
        const gold = emptyGold();
        col?.querySelectorAll('input[data-coin]').forEach(input => {
            const purse = Number(actor?.system.currency?.[input.dataset.coin]) || 0;
            gold[input.dataset.coin] = Math.max(0, Math.min(purse, Math.floor(Number(input.value) || 0)));
        });
        let items = trade.sides[key].items.map(entry => {
            const input = col?.querySelector(`input[data-qty="${entry.id}"]`);
            const have = actor?.items.get(entry.id)?.system.quantity ?? entry.have;
            return { ...entry, have, qty: Math.max(1, Math.min(have, Math.floor(Number(input?.value) || entry.qty))) };
        });
        if (change) items = change(items, actor);
        send('side', { id: trade.id, key, gold, items });
    }

    static #onAdd(event, target) {
        const key = target.closest('[data-side]').dataset.side;
        this.#pushSide(key, (items, actor) => addItem(items, actor?.items.get(target.dataset.itemId)));
    }
    static #onRemove(event, target) {
        const key = target.closest('[data-side]').dataset.side;
        this.#pushSide(key, items => items.filter(e => e.id !== target.dataset.itemId));
    }
    async #onDropItem(event, key) {
        event.preventDefault();
        const data = foundry.applications.ux?.TextEditor?.implementation?.getDragEventData?.(event) ?? JSON.parse(event.dataTransfer.getData('text/plain') || '{}');
        if (data?.type !== 'Item' || !data.uuid) return;
        const item = await fromUuid(data.uuid);
        const actor = game.actors.get(this.trade?.sides[key]?.actorId);
        if (!item || item.parent?.id !== actor?.id) return ui.notifications.warn('Перетащите предмет со своего листа персонажа.');
        if (!tradable(item)) return ui.notifications.warn('Это не отдать: только вещи из инвентаря, не из контейнера.');
        this.#pushSide(key, items => addItem(items, item));
    }
    static #onReady() {
        const trade = this.trade, key = trade && myKey(trade);
        if (!key) return;
        const side = trade.sides[key], header = foundry.utils.deepClone(trade);
        send('ready', { id: trade.id, key, ready: !side.ready, side: { gold: side.gold, items: side.items }, sees: sig(trade.sides[otherKey(key)]), header });
    }
    static #onCancel() {
        const trade = this.trade;
        if (trade) send('state', { id: trade.id, state: 'cancelled' });
        notifyBoth(trade, `Обмен ${trade.sides.a.name} ⇄ ${trade.sides.b.name} отменён.`);
        this.close();
    }
    // Мастер проводит сделку сам, не дожидаясь согласий
    static async #onForce() {
        const trade = this.trade;
        if (trade && game.user.isGM) await settle(trade);
    }
}

/** Добавить предмет в предложение: уже есть — +1, нет — 1 штука */
function addItem(items, item) {
    if (!item || !tradable(item)) return items;
    const have = item.system.quantity ?? 1, at = items.find(e => e.id === item.id);
    if (at) { at.qty = Math.min(have, at.qty + 1); return items; }
    return [...items, { id: item.id, name: item.name, img: item.img, qty: 1, have, data: snapshot(item, 1) }];
}

export const trades = () => [...TRADES.values()];
