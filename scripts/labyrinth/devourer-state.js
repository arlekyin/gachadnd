/**
 * Gacha Roguelike dnd5e — Глубина и Насыщение Пожирателя
 *
 * Глубина — номер этажа, Насыщение — сколько раз он возвращался и кормился. Модуль ведёт Насыщение сам
 * (настройка мира) и включает на листе актёра ровно по одному эффекту «Глубина N» и «Насыщение N».
 *
 * Насыщение +1 само: Пожиратель упал до 0 ПЗ, съел приманку Приманщика. Откуп и уход с Брюхом — Мастер
 * кнопками в подвале карты. Предел — номер этажа + 1 (не больше 5).
 *
 * При прорыве эффекты выставляются заново, а ПЗ, легендарные действия и сопротивления — на максимум.
 * Посреди боя смена Насыщения меняет только эффекты: текущие раны остаются.
 */

import { MODULE_ID } from "../core/constants.js";
import { getFloor } from "./economy.js";
import { t } from "../core/i18n.js";

const DEPTH = /^Глубина (\d+)$/;
const SATIETY = /^Насыщение (\d+)$/;
const MAX_SATIETY = 5;

export function registerDevourerSettings() {
    game.settings.register(MODULE_ID, 'devourerSatiety', {
        scope: 'world', config: false, type: Number, default: 0,
        onChange: () => {
            if (!game.users.activeGM?.isSelf) return;
            const actor = worldDevourer();
            if (actor) syncDevourer(actor).catch(error => console.error(`${MODULE_ID} | Насыщение Пожирателя`, error));
        }
    });
}

/** Предел Насыщения на этаже: номер этажа + 1, не больше 5 */
export const satietyCap = (floor = getFloor()) => Math.min(MAX_SATIETY, floor + 1);
export const getSatiety = () => Math.max(0, Number(game.settings.get(MODULE_ID, 'devourerSatiety')) || 0);

/** Актёр Пожирателя в мире (тот, что охотится за отрядом) */
export const worldDevourer = () => game.actors.find(a => a.getFlag(MODULE_ID, 'creature') === 'devourer') ?? null;

/** Насыщение ± delta в пределах 0…предел этажа. Только Мастер */
export async function addSatiety(delta = 1, reason = '') {
    if (!game.user.isGM) return getSatiety();
    const before = getSatiety();
    const value = Math.max(0, Math.min(satietyCap(), before + delta));
    if (value === before) return value;
    await game.settings.set(MODULE_ID, 'devourerSatiety', value);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: t('Пожиратель') }),
        whisper: ChatMessage.getWhisperRecipients('GM').map(u => u.id),
        content: `<div class="gd-scent-chat"><i class="fas fa-utensils"></i> ${t('Насыщение Пожирателя:')} <strong>${value}</strong>${t('{v}. Эффекты на листе модуль включил сам.', { v: reason ? ` — ${reason}` : '' })}</div>`
    });
    return value;
}

/**
 * Эффекты Глубины и Насыщения на листе: включён ровно один каждого вида.
 * @param {Actor} actor
 * @param {object} [o]  restore — поставить ПЗ и легендарные ресурсы на максимум (при прорыве)
 */
export async function syncDevourer(actor, { restore = false } = {}) {
    if (!actor || !game.user.isGM) return;
    const depth = Math.max(1, Math.min(10, getFloor()));
    const satiety = Math.min(getSatiety(), MAX_SATIETY);
    const updates = [];
    for (const effect of actor.effects) {
        const d = effect.name.match(DEPTH), s = effect.name.match(SATIETY);
        if (!d && !s) continue;
        const on = d ? Number(d[1]) === depth : Number(s[1]) === satiety;
        if (effect.disabled === on) updates.push({ _id: effect.id, disabled: !on });
    }
    if (updates.length) await actor.updateEmbeddedDocuments('ActiveEffect', updates);
    if (!restore) return;
    const { hp } = actor.system.attributes;
    const { legact, legres } = actor.system.resources ?? {};
    await actor.update({
        'system.attributes.hp.value': hp.max,
        ...(legact ? { 'system.resources.legact.value': legact.max } : {}),
        ...(legres ? { 'system.resources.legres.value': legres.max } : {})
    });
}

// Пожиратель упал до 0 ПЗ: он не умирает — выплёвывает Брюхо и уходит, Насыщение +1.
// Только тот, что охотится (актёр мира); натравленный луной — свой токен, его раны не в счёт
const isHunter = actor => !actor.isToken && actor.getFlag(MODULE_ID, 'creature') === 'devourer';
Hooks.on('preUpdateActor', (actor, changes, options) => {
    if (isHunter(actor)) options.gachadndHp = actor.system.attributes.hp.value;
});
Hooks.on('updateActor', (actor, changes, options) => {
    if (!game.users.activeGM?.isSelf || !isHunter(actor)) return;
    const value = foundry.utils.getProperty(changes, 'system.attributes.hp.value');
    if (value === undefined || value > 0 || !(options.gachadndHp > 0)) return;
    addSatiety(1, t('сведён к 0 ПЗ'));
    Hooks.callAll('gachadnd.devourerDefeated', actor);
});

// Новый этаж — Глубина на листе следует за номером этажа
Hooks.once('ready', () => {
    const setting = game.settings.settings.get(`${MODULE_ID}.runFloor`);
    const previous = setting.onChange;
    setting.onChange = value => {
        previous?.(value);
        if (!game.users.activeGM?.isSelf) return;
        const actor = worldDevourer();
        if (actor) syncDevourer(actor).catch(error => console.error(`${MODULE_ID} | Глубина Пожирателя`, error));
    };
});
