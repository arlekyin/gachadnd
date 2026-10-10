/**
 * Gacha Roguelike dnd5e — Награды событий (часть Лабиринта)
 *
 * Мастер пишет события сам и ссылается в них на уровень награды: «Тайник — 3 заметные награды».
 * Модуль тянет варианты из общего пула и отправляет каждому персонажу карточку с кнопками;
 * игрок выбирает одну, Мастер (через сокет) выдаёт её.
 *
 * Пул:
 *   Малая     — золото, расходник, 1 Кость Хитов, лечение;
 *   Заметная  — кристалл выбранного тега, скидка 50% на Очистку, бесплатное обновление ассортимента,
 *               прогресс сращивания всадника;
 *   Редкая    — фиолетовый кристалл, временный слот Памяти до конца этажа, снятие штрафа навыка.
 * Варианты учитывают состояние персонажа: при низких ПЗ чаще лечение, при полной Памяти — Очистка;
 * недоступное (нечего лечить, нет всадника, нет штрафа) не выпадает. «По этажу» — уровень с шансами,
 * растущими с этажом. Награда видна до выбора: золото и предметы бросаются заранее.
 */

import { MODULE_ID } from "../core/constants.js";
import { onRenderChatMessage } from "../core/chat-hooks.js";
import { randomCrystal, randomCrystalWithTag, tagsWithRarity } from "../memory/crystals.js";
import { isMemorySkill } from "../memory/synergy/synergy.js";
import { getMemoryCapacity, restoreHitDice } from "../memory/inventory.js";
import { getSynergyDictionary } from "../memory/synergy/synergy-data.js";
import { getFloor, floorBase, addGold, allowedItemRarities, itemPrice } from "./economy.js";
import { randomFromPack } from "./shop.js";
import { getHorseman, isCleansed, addCleanseProgress, partyActors } from "./horsemen.js";
import { onSocket, requestGM, isActiveGM } from "../core/socket.js";
import { addTokenTools } from "../core/controls.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export const TIERS = { small: 'Малая', notable: 'Заметная', rare: 'Редкая' };
// «По этажу»: шансы уровней растут с этажом
const FLOOR_TIER_WEIGHTS = [
    { upTo: 1, weights: { small: 70, notable: 30, rare: 0 } },
    { upTo: 3, weights: { small: 30, notable: 55, rare: 15 } },
    { upTo: Infinity, weights: { small: 10, notable: 55, rare: 35 } }
];
const RARITY_LABELS = { gray: 'серый', green: 'зелёный', blue: 'синий', purple: 'фиолетовый' };

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hp = actor => actor.system.attributes?.hp ?? {};
const spentHitDice = actor => Math.max(0, (actor.system.attributes?.hd?.max ?? 0) - (actor.system.attributes?.hd?.value ?? 0));
const drawbackSkills = actor => actor.items.filter(i => isMemorySkill(i) && i.flags[MODULE_ID].drawback && !i.flags[MODULE_ID].drawback_lifted && !i.flags[MODULE_ID].horseman);
const cursedHorseman = actor => { const h = getHorseman(actor); return h && !isCleansed(h) && h.flags[MODULE_ID].cleanse_goal ? h : null; };
// Кристалл выбранного тега: редкость растёт с этажом
const tagCrystalRarity = floor => floor >= 4 ? 'purple' : floor >= 2 ? 'blue' : 'green';

// ==========================================
// ПУЛ
// ==========================================

/**
 * Награда пула. weight(actor) — 0, если недоступна; roll — заранее брошенные параметры;
 * choice — что игрок выбирает при получении ('tag', 'drawback'); apply — выдача у Мастера.
 */
const POOL = {
    gold: {
        tier: 'small', icon: 'fa-coins',
        weight: () => 10,
        roll: (actor, floor) => {
            const gold = Math.max(1, Math.round(floorBase(floor) * (0.1 + Math.random() * 0.15)));
            return { label: `${gold} зм`, gold };
        },
        apply: (actor, o) => addGold(actor, o.gold)
    },
    consumable: {
        tier: 'small', icon: 'fa-flask',
        weight: () => 10,
        roll: async (actor, floor) => {
            const rarities = allowedItemRarities(floor);
            const [item] = await randomFromPack(game.settings.get(MODULE_ID, 'shopConsumables'),
                e => e.type === 'consumable' && itemPrice(e) > 0 && (!e.system?.rarity || rarities.includes(e.system.rarity)), 1);
            return item ? { label: item.name, uuid: item.uuid, img: item.img } : null;
        },
        apply: async (actor, o) => {
            const data = (await fromUuid(o.uuid))?.toObject();
            if (!data) return;
            delete data._id;
            await actor.createEmbeddedDocuments('Item', [data]);
        }
    },
    hitDie: {
        tier: 'small', icon: 'fa-heart',
        weight: actor => spentHitDice(actor) > 0 ? (spentHitDice(actor) * 2 >= (actor.system.attributes?.hd?.max ?? 1) ? 20 : 10) : 0,
        roll: () => ({ label: '1 Кость Хитов' }),
        apply: actor => restoreHitDice(actor, 1)
    },
    heal: {
        tier: 'small', icon: 'fa-hand-holding-medical',
        // Меньше половины ПЗ — лечение выпадает втрое чаще; при полных ПЗ не выпадает
        weight: actor => hp(actor).value >= hp(actor).max ? 0 : hp(actor).value < hp(actor).max / 2 ? 30 : 10,
        roll: actor => {
            const amount = Math.max(1, Math.floor(hp(actor).max / 4));
            return { label: `Лечение: ${amount} ПЗ`, amount };
        },
        apply: (actor, o) => actor.applyDamage([{ value: o.amount, type: 'healing' }])
    },
    tagCrystal: {
        tier: 'notable', icon: 'fa-gem',
        weight: () => 10,
        roll: (actor, floor) => {
            const rarity = tagCrystalRarity(floor);
            return { label: `Кристалл выбранного тега (${RARITY_LABELS[rarity]})`, rarity };
        },
        choice: 'tag',
        apply: async (actor, o, choice) => {
            // Нужная редкость с этим тегом. Игрок выбирает только из тегов этой редкости, поэтому запасной
            // путь нужен лишь на случай изменившегося компендиума — и он идёт только вниз: награда не выше обещанной
            const order = ['gray', 'green', 'blue', 'purple'];
            const at = order.indexOf(o.rarity);
            const tries = [o.rarity, ...order.slice(0, at).reverse()];
            let crystal = null;
            for (const rarity of tries) if ((crystal = await randomCrystalWithTag(rarity, choice))) break;
            if (crystal) await actor.createEmbeddedDocuments('Item', [crystal]);
            return crystal?.name;
        }
    },
    cleanseVoucher: {
        tier: 'notable', icon: 'fa-broom',
        // Память почти заполнена — чаще
        weight: actor => actor.items.filter(isMemorySkill).length >= getMemoryCapacity(actor) - 1 ? 20 : 10,
        roll: () => ({ label: 'Скидка 50% на следующую Очистку' }),
        apply: actor => actor.setFlag(MODULE_ID, 'cleanse_vouchers', (Number(actor.getFlag(MODULE_ID, 'cleanse_vouchers')) || 0) + 1)
    },
    rerollVoucher: {
        tier: 'notable', icon: 'fa-rotate',
        weight: () => 10,
        roll: () => ({ label: 'Бесплатное обновление ассортимента' }),
        apply: actor => actor.setFlag(MODULE_ID, 'reroll_vouchers', (Number(actor.getFlag(MODULE_ID, 'reroll_vouchers')) || 0) + 1)
    },
    horsemanProgress: {
        tier: 'notable', icon: 'fa-horse-head',
        weight: actor => cursedHorseman(actor) ? 15 : 0,
        roll: actor => ({ label: `Прогресс сращивания: ${cursedHorseman(actor).name}` }),
        apply: async actor => { const h = cursedHorseman(actor); if (h) await addCleanseProgress(h, 1); }
    },
    purpleCrystal: {
        tier: 'rare', icon: 'fa-gem',
        weight: () => 10,
        roll: async () => {
            const crystal = await randomCrystal('purple');
            return crystal ? { label: `${crystal.name} (фиолетовый)`, skillId: crystal.flags[MODULE_ID].skill_id, crystal } : null;
        },
        apply: async (actor, o) => {
            const crystal = o.crystal ?? await randomCrystal('purple');
            if (crystal) await actor.createEmbeddedDocuments('Item', [crystal]);
        }
    },
    tempSlot: {
        tier: 'rare', icon: 'fa-brain',
        weight: () => 10,
        roll: () => ({ label: '+1 слот Памяти до конца этажа' }),
        apply: async (actor) => {
            await actor.update({
                [`flags.${MODULE_ID}.extra_slots`]: (Number(actor.getFlag(MODULE_ID, 'extra_slots')) || 0) + 1,
                [`flags.${MODULE_ID}.extra_slots_floor`]: getFloor()
            });
            Hooks.callAll('gachadnd.synergyUpdated', actor);
        }
    },
    liftDrawback: {
        tier: 'rare', icon: 'fa-unlock',
        weight: actor => drawbackSkills(actor).length ? 10 : 0,
        roll: () => ({ label: 'Снять штраф с навыка' }),
        choice: 'drawback',
        apply: async (actor, o, choice) => {
            const item = actor.items.get(choice);
            if (!item) return;
            await item.setFlag(MODULE_ID, 'drawback_lifted', true);
            Hooks.callAll('gachadnd.synergyUpdated', actor);
            return item.name;
        }
    }
};

function pickWeighted(entries) {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    if (total <= 0) return null;
    let roll = Math.random() * total;
    for (const [key, w] of entries) if ((roll -= w) < 0) return key;
    return entries[entries.length - 1][0];
}

function tierForFloor(floor) {
    const { weights } = FLOOR_TIER_WEIGHTS.find(t => floor <= t.upTo);
    return pickWeighted(Object.entries(weights));
}

/**
 * Разные варианты награды для персонажа. Если в уровне не хватает доступных наград,
 * добираются из уровня ниже.
 * @param {Actor} actor
 * @param {'small'|'notable'|'rare'|'floor'} tier
 * @param {number} count
 */
export async function rollRewardOptions(actor, tier, count = 3, floor = getFloor()) {
    const order = ['rare', 'notable', 'small'];
    const options = [];
    const used = new Set();
    for (let n = 0; n < count; n++) {
        const wanted = tier === 'floor' ? tierForFloor(floor) : tier;
        for (const level of order.slice(order.indexOf(wanted))) {
            const entries = Object.entries(POOL)
                .filter(([key, r]) => r.tier === level && !used.has(key))
                .map(([key, r]) => [key, r.weight(actor)])
                .filter(([, w]) => w > 0);
            const key = pickWeighted(entries);
            if (!key) continue;
            const rolled = await POOL[key].roll(actor, floor);
            used.add(key);
            if (!rolled) { n--; break; }
            options.push({ key, tier: level, icon: POOL[key].icon, choice: POOL[key].choice ?? null, ...rolled });
            break;
        }
    }
    return options;
}

// ==========================================
// КАРТОЧКА И ВЫБОР
// ==========================================

function ownerIds(actor) {
    return game.users.filter(u => u.isGM || actor.testUserPermission(u, 'OWNER')).map(u => u.id);
}

function cardContent(actor, title, options, claimed = null) {
    const rows = options.map((o, i) => {
        const chosen = claimed?.index === i;
        const tierLabel = TIERS[o.tier];
        return `<button type="button" class="gd-reward ${chosen ? 'chosen' : ''}" data-gd-reward="${i}" ${claimed ? 'disabled' : ''}>
            <i class="fas ${o.icon}"></i><span>${esc(o.label)}${chosen && claimed.detail ? ` — ${esc(claimed.detail)}` : ''}</span><small>${tierLabel}</small></button>`;
    }).join('');
    return `<div class="gachadnd-event-reward">
        <div class="gd-reward-title">${esc(title)} · <strong>${esc(actor.name)}</strong></div>
        <div class="gd-reward-list">${rows}</div>
        <div class="gd-reward-foot">${claimed ? `Выбрано: ${esc(options[claimed.index].label)}` : 'Выберите одну награду.'}</div>
    </div>`;
}

/**
 * Предложить награды персонажам: каждому своя карточка (видят владельцы и Мастер).
 * @param {{ actors?: Actor[], tier?: string, count?: number, title?: string }} config
 */
export async function offerEventRewards({ actors, tier = 'floor', count = 3, title = 'Награда события' } = {}) {
    if (!game.user.isGM) return ui.notifications.warn('Награды событий выдаёт Мастер.');
    actors = actors?.length ? actors : partyActors();
    for (const actor of actors) {
        const options = await rollRewardOptions(actor, tier, count);
        if (!options.length) continue;
        // Брошенный заранее кристалл хранится как данные: его и выдаст Мастер
        await ChatMessage.create({
            speaker: { alias: 'Лабиринт' },
            whisper: ownerIds(actor),
            content: cardContent(actor, title, options),
            flags: { [MODULE_ID]: { eventReward: { actorId: actor.id, title, options, claimed: null } } }
        });
    }
}

// Выбор игрока: тег или навык спрашиваются у него, выдаёт Мастер
async function chooseReward(message, index) {
    const data = message.getFlag(MODULE_ID, 'eventReward');
    const option = data?.options?.[index];
    const actor = game.actors.get(data?.actorId);
    if (!option || !actor || data.claimed) return;
    if (!actor.isOwner) return ui.notifications.warn('Награду выбирает владелец персонажа.');
    let choice = null;
    if (option.choice === 'tag') {
        // Только теги, у которых есть навыки обещанной редкости
        const available = new Set(await tagsWithRarity(option.rarity));
        const tags = Object.keys(getSynergyDictionary()).filter(t => available.has(t));
        if (!tags.length) return ui.notifications.warn('Нет навыков этой редкости ни с одним тегом.');
        choice = await foundry.applications.api.DialogV2.prompt({
            window: { title: 'Тег кристалла' },
            content: `<p>Кристалл какого тега?</p><select name="tag">${tags.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>`,
            ok: { label: 'Выбрать', callback: (event, button) => button.form.elements.tag.value },
            rejectClose: false
        });
        if (!choice) return;
    }
    if (option.choice === 'drawback') {
        const skills = drawbackSkills(actor);
        choice = await foundry.applications.api.DialogV2.prompt({
            window: { title: 'Снять штраф' },
            content: `<p>С какого навыка снять штраф?</p><select name="skill">${skills.map(s => `<option value="${s.id}">${esc(s.name)} — ${esc(s.flags[MODULE_ID].drawback)}</option>`).join('')}</select>`,
            ok: { label: 'Снять', callback: (event, button) => button.form.elements.skill.value },
            rejectClose: false
        });
        if (!choice) return;
    }
    requestGM('claimEventReward', { messageId: message.id, index, choice });
}

onSocket('claimEventReward', async ({ payload }) => {
    if (!isActiveGM()) return;
    const { messageId, index, choice, userId } = payload;
    const message = game.messages.get(messageId);
    const data = message?.getFlag(MODULE_ID, 'eventReward');
    const actor = game.actors.get(data?.actorId);
    const user = game.users.get(userId);
    if (!data || data.claimed || !actor || !user || !actor.testUserPermission(user, 'OWNER')) return;
    const option = data.options[index];
    if (!option) return;
    // Заметку о выборе ставим до выдачи: повторное нажатие ничего не выдаст
    const claimed = { index, by: userId, detail: null };
    await message.update({ [`flags.${MODULE_ID}.eventReward.claimed`]: claimed });
    claimed.detail = await POOL[option.key].apply(actor, option, choice) ?? null;
    await message.update({ content: cardContent(actor, data.title, data.options, claimed), [`flags.${MODULE_ID}.eventReward.claimed`]: claimed });
});

function bindRewardCard(message, html) {
    const root = html;
    if (!message.getFlag?.(MODULE_ID, 'eventReward')) return;
    root?.querySelectorAll?.('[data-gd-reward]:not([data-bound])').forEach(button => {
        button.dataset.bound = '1';
        button.addEventListener('click', () => chooseReward(message, Number(button.dataset.gdReward)));
    });
}
onRenderChatMessage(bindRewardCard);

// Временный слот Памяти живёт до конца этажа
export async function expireFloorSlots(floor = getFloor()) {
    if (!isActiveGM()) return;
    for (const actor of partyActors()) {
        const slots = Number(actor.getFlag(MODULE_ID, 'extra_slots')) || 0;
        if (!slots || actor.getFlag(MODULE_ID, 'extra_slots_floor') === floor) continue;
        await actor.update({ [`flags.${MODULE_ID}.extra_slots`]: 0, [`flags.${MODULE_ID}.extra_slots_floor`]: null });
        Hooks.callAll('gachadnd.synergyUpdated', actor);
        ui.notifications.info(`${actor.name}: временный слот Памяти закрылся вместе с этажом.`);
    }
}

// ==========================================
// ОКНО МАСТЕРА
// ==========================================

export class EventRewardsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: 'gachadnd-event-rewards',
        classes: ['gachadnd-event-rewards-window'],
        tag: 'div',
        window: { title: 'Награды события', icon: 'fas fa-gift' },
        position: { width: 380, height: 'auto' },
        actions: { send: EventRewardsWindow.#onSend }
    };

    static PARTS = { body: { template: 'modules/gachadnd/templates/rewards/window.hbs' } };

    async _prepareContext() {
        const selected = new Set(canvas.tokens?.controlled.map(t => t.actor?.id).filter(Boolean));
        return {
            floor: getFloor(),
            tiers: Object.entries(TIERS).map(([key, label]) => ({ key, label })),
            party: partyActors().map(a => ({ id: a.id, name: a.name, checked: selected.size ? selected.has(a.id) : true }))
        };
    }

    static async #onSend() {
        const root = this.element;
        const actors = [...root.querySelectorAll('input[name="actor"]:checked')].map(i => game.actors.get(i.value)).filter(Boolean);
        if (!actors.length) return ui.notifications.warn('Выберите хотя бы одного персонажа.');
        await offerEventRewards({
            actors,
            tier: root.querySelector('[name="tier"]').value,
            count: Math.min(4, Math.max(1, Number(root.querySelector('[name="count"]').value) || 3)),
            title: root.querySelector('[name="title"]').value || 'Награда события'
        });
        this.close();
    }
}

Hooks.on('getSceneControlButtons', (controls) => {
    if (!game.user?.isGM) return;
    addTokenTools(controls, [{
        name: 'gachadnd-event-rewards',
        title: 'Награды события (Мастер)',
        icon: 'fas fa-gift',
        visible: true,
        button: true,
        onClick: () => new EventRewardsWindow().render({ force: true })
    }]);
});
