/**
 * Gacha Roguelike dnd5e — Магазин (узел карты «Магазин»)
 *
 * Ассортимент создаётся при первом входе отряда и хранится в узле карты (флаг сцены floorMap):
 * 3 кристалла, 2 расходника, 1 магический предмет и услуги — Очистка навыка и Обновление ассортимента.
 * Покупают игроки сами: запрос уходит Мастеру через сокет модуля, Мастер списывает золото и выдаёт товар.
 */

import { MODULE_ID } from "./constants.js";
import { randomCrystal, crystalForSkill } from "./crystals.js";
import { isMemorySkill } from "./synergy.js";
import {
    getFloor, crystalPrice, cleansePrice, rerollPrice, itemPrice, allowedItemRarities,
    shopDiscount, applyDiscount, wealth, pay
} from "./economy.js";

import { isActiveGM, onSocket, emit, notifyUser, requestGM } from "./socket.js";

const { ApplicationV2 } = foundry.applications.api;

const RARITY_COLORS = { gray: '#9d9d9d', green: '#1eff00', blue: '#0070dd', purple: '#a335ee', red: '#ff003c' };
const ITEM_RARITY_LABELS = { common: 'обычный', uncommon: 'необычный', rare: 'редкий', veryRare: 'очень редкий', legendary: 'легендарный' };
const SHOP_WEIGHTS = { gray: 600, green: 250, blue: 100, purple: 40 };

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pick = list => list[Math.floor(Math.random() * list.length)];

function rollShopRarity() {
    let roll = Math.random() * Object.values(SHOP_WEIGHTS).reduce((a, b) => a + b, 0);
    for (const [rarity, weight] of Object.entries(SHOP_WEIGHTS)) if ((roll -= weight) < 0) return rarity;
    return 'gray';
}

function currentShopNode(scene = canvas.scene) {
    const map = scene?.getFlag(MODULE_ID, 'floorMap');
    const node = map?.nodes?.find(n => n.id === map.currentNodeId);
    return node?.type === 'shop' ? { map, node } : null;
}

async function saveShop(map, nodeId, shop) {
    const copy = foundry.utils.deepClone(map);
    copy.nodes.find(n => n.id === nodeId).shop = shop;
    await canvas.scene.setFlag(MODULE_ID, 'floorMap', copy);
}

// ==========================================
// АССОРТИМЕНТ
// ==========================================

export async function randomFromPack(packId, filter, count) {
    const pack = game.packs.get(packId);
    if (!pack) {
        ui.notifications.warn(`Магазин: компендиум «${packId}» не найден. Укажите его в настройках модуля.`);
        return [];
    }
    const index = await pack.getIndex({ fields: ['type', 'img', 'system.rarity', 'system.price'] });
    const pool = [...index].filter(filter);
    const result = [];
    while (result.length < count && pool.length) result.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return result.map(e => ({ uuid: e.uuid, name: e.name, img: e.img, rarity: e.system?.rarity ?? '', price: itemPrice(e), type: e.type }));
}

async function generateStock(floor) {
    const goods = [];
    for (let i = 0; i < 3; i++) {
        const rarity = rollShopRarity();
        const crystal = await randomCrystal(rarity);
        if (!crystal) continue;
        const flags = crystal.flags[MODULE_ID];
        goods.push({ kind: 'crystal', skillId: flags.skill_id, name: crystal.name, img: crystal.img, rarity: flags.rarity, price: crystalPrice(flags.rarity, floor) });
    }
    const rarities = allowedItemRarities(floor);
    const consumables = await randomFromPack(game.settings.get(MODULE_ID, 'shopConsumables'),
        e => e.type === 'consumable' && itemPrice(e) > 0 && (!e.system?.rarity || rarities.includes(e.system.rarity)), 2);
    consumables.forEach(c => goods.push({ kind: 'consumable', ...c }));
    const magic = await randomFromPack(game.settings.get(MODULE_ID, 'shopMagicItems'),
        e => e.type !== 'consumable' && rarities.includes(e.system?.rarity) && itemPrice(e) > 0, 1);
    magic.forEach(m => goods.push({ kind: 'magic', ...m }));
    return goods.map((g, i) => ({ ...g, slot: `${Date.now().toString(36)}-${i}`, sold: null }));
}

// ==========================================
// ОПЕРАЦИИ (выполняет Мастер)
// ==========================================

// Награды событий: скидка 50% на следующую Очистку и бесплатное обновление ассортимента
const cleanseVouchers = actor => Number(actor?.getFlag(MODULE_ID, 'cleanse_vouchers')) || 0;
const rerollVouchers = actor => Number(actor?.getFlag(MODULE_ID, 'reroll_vouchers')) || 0;
function cleanseCostFor(actor, floor) {
    const price = applyDiscount(cleansePrice(actor, floor), shopDiscount(actor));
    return cleanseVouchers(actor) ? Math.round(price / 2) : price;
}
function rerollCostFor(actor, shop, floor) {
    return rerollVouchers(actor) ? 0 : applyDiscount(rerollPrice(shop.rerolls ?? 0, floor), shopDiscount(actor));
}

function priceFor(good, actor) {
    return good.kind === 'magic' ? good.price : applyDiscount(good.price, shopDiscount(actor));
}

async function chat(content) {
    await ChatMessage.create({ speaker: { alias: 'Торговец Тумана' }, content: `<div class="gachadnd-shop-chat">${content}</div>` });
}

async function performShopOp({ op, userId, actorId, slot, itemId }) {
    const found = currentShopNode();
    if (!found?.node.shop) return;
    const shop = foundry.utils.deepClone(found.node.shop);
    const actor = game.actors.get(actorId);
    const user = game.users.get(userId);
    if (!actor || !user || !actor.testUserPermission(user, 'OWNER')) return;
    const floor = shop.floor ?? getFloor();
    const deny = text => notifyUser(userId, text);

    if (op === 'buy') {
        const good = shop.goods.find(g => g.slot === slot);
        if (!good || good.sold) return deny('Товар уже продан.');
        const price = priceFor(good, actor);
        if (!(await pay(actor, price))) return deny(`${actor.name}: не хватает золота (${price} зм).`);
        let data = null;
        if (good.kind === 'crystal') data = await crystalForSkill({ skillId: good.skillId });
        else data = (await fromUuid(good.uuid))?.toObject();
        if (data) {
            delete data._id;
            await actor.createEmbeddedDocuments('Item', [data]);
        }
        good.sold = actor.id;
        await saveShop(found.map, found.node.id, shop);
        return chat(`<strong>${esc(actor.name)}</strong> покупает <strong>${esc(good.name)}</strong> за ${price} зм.`);
    }

    if (op === 'cleanse') {
        const item = actor.items.get(itemId);
        const flags = item?.flags?.[MODULE_ID];
        if (!item || !isMemorySkill(item) || flags.undeletable || (flags.horseman && !flags.cleansed)) return deny('Этот навык не очистить.');
        const voucher = cleanseVouchers(actor) > 0;
        const price = cleanseCostFor(actor, floor);
        if (!(await pay(actor, price))) return deny(`${actor.name}: не хватает золота (${price} зм).`);
        if (voucher) await actor.setFlag(MODULE_ID, 'cleanse_vouchers', cleanseVouchers(actor) - 1);
        await actor.setFlag(MODULE_ID, 'shop_cleanses', (actor.getFlag(MODULE_ID, 'shop_cleanses') ?? 0) + 1);
        await item.delete();
        return chat(`<strong>${esc(actor.name)}</strong> очищает Память от навыка «${esc(item.name)}» за ${price} зм.`);
    }

    if (op === 'reroll') {
        const voucher = rerollVouchers(actor) > 0;
        const price = rerollCostFor(actor, shop, floor);
        if (!(await pay(actor, price))) return deny(`${actor.name}: не хватает золота (${price} зм).`);
        if (voucher) await actor.setFlag(MODULE_ID, 'reroll_vouchers', rerollVouchers(actor) - 1);
        shop.goods = await generateStock(floor);
        shop.rerolls = (shop.rerolls ?? 0) + 1;
        await saveShop(found.map, found.node.id, shop);
        return chat(`<strong>${esc(actor.name)}</strong> оплачивает новый ассортимент за ${price} зм.`);
    }
}

const request = payload => requestGM('shopOp', payload);

// Сообщения Магазина: операции выполняет Мастер, открытие окна — у всех
// Операции выполняются по очереди: два покупателя не купят один товар
let queue = Promise.resolve();
onSocket('shopOp', message => {
    if (!isActiveGM()) return;
    queue = queue.then(() => performShopOp(message.payload)).catch(err => console.error('[GachaDND] Магазин:', err));
    return queue;
});
onSocket('openShop', () => ShopWindow.show());

// ==========================================
// ОКНО МАГАЗИНА
// ==========================================

export class ShopWindow extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: 'gachadnd-shop',
        classes: ['gachadnd-shop'],
        tag: 'div',
        window: { title: 'Торговец Тумана', icon: 'fas fa-coins', resizable: true },
        position: { width: 760, height: 680 },
        actions: {
            buy: ShopWindow.#onBuy,
            cleanse: ShopWindow.#onCleanse,
            reroll: ShopWindow.#onReroll
        }
    };

    // Мастер открывает магазин: при первом входе создаётся ассортимент, окно открывается у всех
    static async open() {
        if (!game.user.isGM) return ShopWindow.show();
        const found = currentShopNode();
        if (!found) return ui.notifications.warn('Отряд не стоит на узле Магазина.');
        if (!found.node.shop) {
            const floor = getFloor();
            await saveShop(found.map, found.node.id, { floor, rerolls: 0, goods: await generateStock(floor) });
        }
        emit('openShop');
        return ShopWindow.show();
    }

    static show() {
        const existing = foundry.applications.instances?.get('gachadnd-shop');
        if (existing) return existing.render({ force: true });
        return new ShopWindow().render({ force: true });
    }

    #buyers() {
        return game.actors.filter(a => a.type === 'character' && (game.user.isGM ? a.hasPlayerOwner : a.isOwner));
    }

    #buyer() {
        const buyers = this.#buyers();
        return buyers.find(a => a.id === this.buyerId) ?? buyers.find(a => a.id === game.user.character?.id) ?? buyers[0] ?? null;
    }

    async _renderHTML() {
        const found = currentShopNode();
        if (!found?.node.shop) return '<p class="gd-shop-empty">Отряд не стоит у торговца.</p>';
        const shop = found.node.shop;
        const floor = shop.floor ?? getFloor();
        const buyer = this.#buyer();
        this.buyerId = buyer?.id;
        const discount = shopDiscount(buyer);

        const goodHtml = good => {
            const price = buyer ? priceFor(good, buyer) : good.price;
            const color = good.kind === 'crystal' ? RARITY_COLORS[good.rarity] : '#d8c8a8';
            const sub = good.kind === 'crystal' ? 'кристалл' : `${good.kind === 'magic' ? 'магический предмет' : 'расходник'}${good.rarity ? ` · ${ITEM_RARITY_LABELS[good.rarity] ?? good.rarity}` : ''}`;
            return `
                <div class="gd-good ${good.sold ? 'sold' : ''}" style="--good: ${color}">
                    <img src="${good.img}" alt="">
                    <div class="gd-good-name">${esc(good.name)}</div>
                    <div class="gd-good-sub">${sub}</div>
                    ${good.sold
                        ? `<div class="gd-good-sold">Продано: ${esc(game.actors.get(good.sold)?.name ?? '')}</div>`
                        : `<button type="button" data-action="buy" data-slot="${good.slot}" ${buyer && wealth(buyer) >= price ? '' : 'disabled'}>${price} зм</button>`}
                </div>`;
        };
        const section = (kind, title) => {
            const goods = shop.goods.filter(g => g.kind === kind);
            return goods.length ? `<h3>${title}</h3><div class="gd-goods">${goods.map(goodHtml).join('')}</div>` : '';
        };

        const cleanseCost = buyer ? cleanseCostFor(buyer, floor) : 0;
        const rerollCost = buyer ? rerollCostFor(buyer, shop, floor) : 0;
        const cleansable = buyer?.items.filter(i => isMemorySkill(i) && !i.flags[MODULE_ID].undeletable && !(i.flags[MODULE_ID].horseman && !i.flags[MODULE_ID].cleansed)) ?? [];

        return `
            <div class="gd-shop-head">
                <span>Этаж ${floor}</span>
                <label>Покупатель
                    <select class="gd-shop-buyer">${this.#buyers().map(a => `<option value="${a.id}" ${a.id === buyer?.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
                </label>
                <span class="gd-shop-gold">${buyer ? `${Math.floor(wealth(buyer))} зм` : ''}${discount ? ` · скидка ${discount}%` : ''}</span>
            </div>
            ${section('crystal', 'Кристаллы')}
            ${section('consumable', 'Расходники')}
            ${section('magic', 'Магический предмет')}
            <h3>Услуги</h3>
            <div class="gd-services">
                <div class="gd-service">
                    <strong>Очистка</strong> — сжечь навык из Памяти
                    <select class="gd-shop-cleanse">${cleansable.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>
                    <button type="button" data-action="cleanse" ${cleansable.length && buyer && wealth(buyer) >= cleanseCost ? '' : 'disabled'}>${cleanseCost} зм${cleanseVouchers(buyer) ? ' · скидка 50%' : ''}</button>
                </div>
                <div class="gd-service">
                    <strong>Обновить ассортимент</strong>
                    <button type="button" data-action="reroll" ${buyer && wealth(buyer) >= rerollCost ? '' : 'disabled'}>${rerollVouchers(buyer) ? 'бесплатно' : `${rerollCost} зм`}</button>
                </div>
            </div>`;
    }

    _replaceHTML(result, content) {
        content.innerHTML = result;
    }

    _onRender() {
        this.element.querySelector('.gd-shop-buyer')?.addEventListener('change', event => {
            this.buyerId = event.target.value;
            this.render();
        });
    }

    static #onBuy(event, target) {
        if (this.buyerId) request({ op: 'buy', actorId: this.buyerId, slot: target.dataset.slot });
    }

    static #onCleanse() {
        const itemId = this.element.querySelector('.gd-shop-cleanse')?.value;
        if (this.buyerId && itemId) request({ op: 'cleanse', actorId: this.buyerId, itemId });
    }

    static #onReroll() {
        if (this.buyerId) request({ op: 'reroll', actorId: this.buyerId });
    }
}

// Магазин перерисовывается при изменении карты, золота или Памяти
const rerenderShop = () => foundry.applications.instances?.get('gachadnd-shop')?.render();
Hooks.on('updateScene', (scene, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) rerenderShop();
});
Hooks.on('updateActor', rerenderShop);
Hooks.on('deleteItem', rerenderShop);
Hooks.on('createItem', rerenderShop);
