/**
 * Gacha Roguelike dnd5e — Экономика забега
 *
 * Все цены и награды считаются от базового золота этажа:
 *   База(Э) = база × рост^(Э − 1), где Э — номер этажа забега (1–10).
 * Магические предметы продаются по цене из компендиума; их редкость открывается с этажом.
 */

import { MODULE_ID } from "./constants.js";
import { HOOKS } from "./memory-api.js";

// Награды золотом: доля базы этажа (минимум–максимум)
export const GOLD_SHARE = {
    normal: [0.05, 0.15],
    elite: [0.2, 0.5],
    boss: [0.7, 1.0],
    cursed: [0.2, 0.5]
};

// Цены по редкости из DMG 2024, если в предмете цена не указана; расходники — вдвое дешевле
const DMG_PRICE = { common: 100, uncommon: 400, rare: 4000, veryRare: 40000, legendary: 200000, artifact: 200000 };

// Редкости магических предметов в продаже по этажам
export function allowedItemRarities(floor) {
    if (floor >= 7) return ['common', 'uncommon', 'rare'];
    if (floor >= 4) return ['common', 'uncommon'];
    return ['common'];
}

export function registerEconomySettings() {
    const settings = {
        runFloor: { name: 'Этаж забега', type: Number, default: 1, config: false },
        goldBase: { name: 'Базовое золото 1-го этажа', hint: 'База(Э) = базовое золото × рост^(Э − 1).', type: Number, default: 100 },
        goldGrowth: { name: 'Рост золота за этаж', type: Number, default: 1.5 },
        crystalPrices: { name: 'Цены кристаллов (доля базы)', hint: 'Серый / зелёный / синий / фиолетовый. Красные не продаются.', type: String, default: '0.2/0.5/1.2/3' },
        cleansePrice: { name: 'Очистка навыка (доля базы)', hint: 'Цена = база × доля × (1 + очисток за забег).', type: Number, default: 0.5 },
        rerollPrice: { name: 'Обновление ассортимента (доля базы)', hint: 'Цена = база × доля × (1 + обновлений в этом магазине).', type: Number, default: 0.2 },
        doomHorseBlood: { name: 'Погибель: кровь на одного коня (× средний уровень)', hint: 'Конь № N открывает пасть при N × доля × средний уровень отряда крови.', type: Number, default: 12 },
        doomCurseBlood: { name: 'Погибель: кровь за проклятый кристалл (× средний уровень)', hint: 'Каждые доля × средний уровень отряда крови на постаменте — кристалл с тегом «проклятье» тому, чья жертва добрала до отметки.', type: Number, default: 3 },
        shopConsumables: { name: 'Компендиум расходников магазина', hint: 'Например dnd5e.items. Берутся предметы типа «расходник».', type: String, default: 'dnd5e.items' },
        shopMagicItems: { name: 'Компендиум магических предметов магазина', hint: 'Например dnd5e.items. Берутся предметы с редкостью, кроме расходников.', type: String, default: 'dnd5e.items' }
    };
    for (const [key, config] of Object.entries(settings)) {
        game.settings.register(MODULE_ID, key, { scope: 'world', config: true, ...config });
    }
    // Номер этажа задаётся на карте этажа; перерисовка открытых окон при его изменении
    game.settings.settings.get(`${MODULE_ID}.runFloor`).onChange = () => {
        const map = foundry.applications.instances?.get('gachadnd-map-terminal');
        if (map?.rendered) map.render({ parts: ['header'] });
        foundry.applications.instances?.get('gachadnd-shop')?.refresh?.();
    };
}

export const getFloor = () => Math.max(1, Number(game.settings.get(MODULE_ID, 'runFloor')) || 1);

export function floorBase(floor = getFloor()) {
    const base = Number(game.settings.get(MODULE_ID, 'goldBase')) || 100;
    const growth = Number(game.settings.get(MODULE_ID, 'goldGrowth')) || 1.5;
    return base * growth ** (floor - 1);
}

export function rollGold(room, floor = getFloor()) {
    const [min, max] = GOLD_SHARE[room] ?? GOLD_SHARE.normal;
    const base = floorBase(floor);
    return Math.round(base * (min + Math.random() * (max - min)));
}

export function crystalPrice(rarity, floor = getFloor()) {
    const shares = String(game.settings.get(MODULE_ID, 'crystalPrices')).split('/').map(Number);
    const index = ['gray', 'green', 'blue', 'purple'].indexOf(rarity);
    if (index < 0 || !shares[index]) return null;
    return Math.round(floorBase(floor) * shares[index]);
}

export function cleansePrice(actor, floor = getFloor()) {
    const done = actor?.getFlag(MODULE_ID, 'shop_cleanses') ?? 0;
    return Math.round(floorBase(floor) * game.settings.get(MODULE_ID, 'cleansePrice') * (1 + done));
}

export function rerollPrice(rerolls, floor = getFloor()) {
    return Math.round(floorBase(floor) * game.settings.get(MODULE_ID, 'rerollPrice') * (1 + rerolls));
}

// Цена предмета компендиума в золотых: из самого предмета или по редкости DMG 2024
const TO_GP = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 };
export function itemPrice(entry) {
    const price = entry.system?.price;
    const value = Number(price?.value) || 0;
    if (value > 0) return Math.round(value * (TO_GP[price.denomination] ?? 1));
    const base = DMG_PRICE[entry.system?.rarity] ?? 0;
    return entry.type === 'consumable' ? base / 2 : base;
}

// Скидка торговцев: навыки с shop_discount (Шепард) — процент за каждый навык в Памяти, с пределом
export function shopDiscount(actor) {
    if (!actor) return 0;
    const memory = actor.items.filter(i => i.type === 'feat' && i.flags?.[MODULE_ID]?.skill_name && !i.flags[MODULE_ID].is_crystal_item);
    let percent = 0;
    for (const item of memory) {
        const config = item.flags[MODULE_ID].shop_discount;
        if (!config || !item.flags[MODULE_ID].is_active) continue;
        percent = Math.max(percent, Math.min(config.max ?? 100, config.per_skill * memory.length));
    }
    return percent;
}

export const applyDiscount = (price, percent) => Math.round(price * (1 - percent / 100));

// ==========================================
// ЗОЛОТО ПЕРСОНАЖА
// ==========================================

// Всё золото персонажа в золотых (монеты всех номиналов)
export function wealth(actor) {
    const c = actor.system.currency ?? {};
    return Object.entries(TO_GP).reduce((sum, [coin, rate]) => sum + (Number(c[coin]) || 0) * rate, 0);
}

// Оплата: монеты всех номиналов пересчитываются, сдача выдаётся золотыми, серебряными и медными
export async function pay(actor, price) {
    const total = Math.round(wealth(actor) * 100);
    const cost = Math.round(price * 100);
    if (cost > total) return false;
    const rest = total - cost;
    await actor.update({
        'system.currency': { pp: 0, ep: 0, gp: Math.floor(rest / 100), sp: Math.floor((rest % 100) / 10), cp: rest % 10 }
    });
    return true;
}

export async function addGold(actor, gold) {
    await actor.update({ 'system.currency.gp': (Number(actor.system.currency?.gp) || 0) + gold });
}

// Подключение к добыче Памяти: золото комнаты растёт с этажом — База(Э) × доля комнаты
Hooks.on(HOOKS.lootGenerated, loot => {
    const gold = rollGold(loot.roomType);
    if (gold <= 0) return;
    if (loot.actor) loot.tasks.push(addGold(loot.actor, gold));
    loot.lines.push(`<div style="text-align: center; margin-top: 8px; color: #ffd27a; font-size: 1.15em;"><i class="fas fa-coins"></i> ${gold} зм · этаж ${getFloor()}</div>`);
});
