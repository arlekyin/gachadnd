/**
 * Gacha Roguelike dnd5e — Портал в Предел
 *
 * На узле Привал ткань узла тонкая: отряд может сжечь кристаллы и открыть портал в Якорь и обратно.
 * Плата — вероятность: суммарный вес сожжённых кристаллов не меньше 2 + номер этажа (вес тот же, что у
 * Запаха). Каждый игрок кладёт в разрыв кристаллы своего персонажа; Мастер открывает портал, когда плата
 * набрана. Портал открывает Якорь, а первый шаг по карте возвращает отряд на этот же Привал.
 *
 * Состояние — на узле карты (node.portal.pledges: { actorId: { itemId: количество } }); пишет его Мастер.
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM, onSocket, emit, notifyUser, requestGM } from "../core/socket.js";
import { partyActors } from "./horsemen.js";
import { getFloor } from "./economy.js";
import { isCrystalItem } from "../memory/inventory.js";
import { crystalWeight, setAnchor, isAnchorOpen } from "./anchor.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const PORTAL_ID = 'gachadnd-portal';
const RARITY_COLORS = { gray: '#9d9d9d', green: '#1eff00', blue: '#0070dd', purple: '#a335ee', red: '#ff003c' };
const RARITY_ORDER = ['gray', 'green', 'blue', 'purple', 'red'];

/** Плата за портал на этаже */
export const portalToll = (floor = getFloor()) => 2 + floor;

// Кристаллы, которыми можно платить: оранжевые всадники платой быть не могут
const payable = item => isCrystalItem(item) && (item.flags?.[MODULE_ID]?.rarity ?? 'gray') !== 'orange';
const quantity = item => Math.max(0, Number(item.system?.quantity ?? 1));

function currentRestNode(scene = canvas.scene) {
    const map = scene?.getFlag(MODULE_ID, 'floorMap');
    const node = map?.nodes?.find(n => n.id === map.currentNodeId);
    return node?.type === 'rest' ? { map, node } : null;
}

async function savePortal(found, portal) {
    const copy = foundry.utils.deepClone(found.map);
    copy.nodes.find(n => n.id === found.node.id).portal = portal;
    await canvas.scene.setFlag(MODULE_ID, 'floorMap', copy);
}

// Вклад в плату с поправкой на то, что кристаллы могли потратить после того, как их положили
function pledgedTotal(pledges = {}) {
    let total = 0;
    for (const [actorId, items] of Object.entries(pledges)) {
        const actor = game.actors.get(actorId);
        for (const [itemId, count] of Object.entries(items ?? {})) {
            const item = actor?.items.get(itemId);
            if (item && payable(item)) total += crystalWeight(item) * Math.min(count, quantity(item));
        }
    }
    return total;
}

// ==========================================
// ОПЕРАЦИИ (выполняет Мастер)
// ==========================================

async function performPortalOp({ op, actorId, itemId, delta, userId }) {
    const found = currentRestNode();
    if (!found) return notifyUser(userId, 'Портал открывается только на Привале.');
    const user = game.users.get(userId);
    const portal = foundry.utils.deepClone(found.node.portal ?? { pledges: {} });
    portal.pledges ??= {};

    if (op === 'pledge') {
        const actor = game.actors.get(actorId);
        const item = actor?.items.get(itemId);
        if (!actor || !item || !payable(item)) return;
        if (!user?.isGM && !actor.testUserPermission(user, 'OWNER')) return notifyUser(userId, 'Класть в разрыв можно только кристаллы своего персонажа.');
        const mine = portal.pledges[actorId] ??= {};
        const next = Math.max(0, Math.min(quantity(item), (mine[itemId] ?? 0) + Math.sign(delta)));
        if (next) mine[itemId] = next;
        else delete mine[itemId];
        if (!Object.keys(mine).length) delete portal.pledges[actorId];
        return savePortal(found, portal);
    }

    if (op === 'open' && user?.isGM) {
        const toll = portalToll();
        const total = pledgedTotal(portal.pledges);
        if (total < toll) return notifyUser(userId, `Плата не набрана: ${total} из ${toll}.`);
        const burned = [];
        for (const [id, items] of Object.entries(portal.pledges)) {
            const actor = game.actors.get(id);
            if (!actor) continue;
            const updates = [], deletions = [];
            for (const [crystalId, count] of Object.entries(items)) {
                const item = actor.items.get(crystalId);
                if (!item || !payable(item)) continue;
                const spent = Math.min(count, quantity(item));
                if (!spent) continue;
                burned.push(`${actor.name}: <span style="color: ${RARITY_COLORS[item.flags[MODULE_ID]?.rarity] ?? '#aaa'}">${item.name.replace(/^Кристалл:\s*/, '')}</span>${spent > 1 ? ` ×${spent}` : ''}`);
                if (spent >= quantity(item)) deletions.push(item.id);
                else updates.push({ _id: item.id, 'system.quantity': quantity(item) - spent });
            }
            if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
            if (deletions.length) await actor.deleteEmbeddedDocuments('Item', deletions);
        }
        await savePortal(found, { pledges: {} });
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: 'Разрыв' }),
            content: `<div class="gd-scent-chat"><i class="fas fa-hurricane"></i> Кристаллы гаснут один за другим — вероятность рвёт ткань узла. Портал в Предел открыт.<br><small>${burned.join(' · ')}</small></div>`
        });
        emit('closePortal');
        PortalWindow.close();
        if (!isAnchorOpen()) await setAnchor(true);
    }
}

let queue = Promise.resolve();
onSocket('portalOp', message => {
    if (!isActiveGM()) return;
    queue = queue.then(() => performPortalOp(message.payload)).catch(err => console.error('[GachaDND] Портал:', err));
    return queue;
});
onSocket('openPortal', () => PortalWindow.show());
onSocket('closePortal', () => PortalWindow.close());

const request = payload => requestGM('portalOp', payload);

// ==========================================
// ОКНО ПОРТАЛА
// ==========================================

export class PortalWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: PORTAL_ID,
        classes: ['gachadnd-portal'],
        tag: 'div',
        window: { title: 'Портал в Предел', icon: 'fas fa-hurricane', resizable: true },
        position: { width: 560, height: 640 },
        actions: {
            pledge: PortalWindow.#onPledge,
            open: () => request({ op: 'open' })
        }
    };

    static PARTS = { body: { template: 'modules/gachadnd/templates/portal/body.hbs', scrollable: ['.gd-portal-party'] } };

    // Мастер открывает окно платы у всех
    static open() {
        if (!currentRestNode()) return ui.notifications.warn('Портал открывается только на Привале.');
        if (isAnchorOpen()) return ui.notifications.warn('Отряд уже в Якоре.');
        if (game.user.isGM) emit('openPortal');
        return PortalWindow.show();
    }

    static show() {
        const existing = foundry.applications.instances?.get(PORTAL_ID);
        if (existing) return existing.render({ force: true });
        return new PortalWindow().render({ force: true });
    }

    static close() {
        foundry.applications.instances?.get(PORTAL_ID)?.close();
    }

    async _prepareContext() {
        const found = currentRestNode();
        const pledges = found?.node.portal?.pledges ?? {};
        const toll = portalToll();
        const total = pledgedTotal(pledges);
        const party = partyActors().map(actor => {
            const mine = pledges[actor.id] ?? {};
            const crystals = actor.items.filter(payable)
                .map(item => {
                    const rarity = item.flags[MODULE_ID]?.rarity ?? 'gray';
                    const pledged = Math.min(mine[item.id] ?? 0, quantity(item));
                    return {
                        id: item.id, rarity, color: RARITY_COLORS[rarity] ?? '#aaa',
                        name: item.name.replace(/^Кристалл:\s*/, ''), weight: crystalWeight(item),
                        quantity: quantity(item), pledged, img: item.img
                    };
                })
                .sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || a.name.localeCompare(b.name));
            const given = crystals.reduce((sum, c) => sum + c.weight * c.pledged, 0);
            return { id: actor.id, name: actor.name, img: actor.img, crystals, given, editable: game.user.isGM || actor.isOwner };
        });
        return {
            atRest: !!found, toll, total, ready: total >= toll, missing: Math.max(0, toll - total), isGM: game.user.isGM,
            progress: Math.min(100, Math.round((total / toll) * 100)), party
        };
    }

    // Левый щелчок кладёт кристалл в разрыв, правый — забирает
    _onRender(context, options) {
        super._onRender(context, options);
        this.element.querySelectorAll('[data-action="pledge"]').forEach(el => el.addEventListener('contextmenu', event => {
            event.preventDefault();
            PortalWindow.#pledge(el, -1);
        }));
    }

    static #onPledge(event, target) {
        PortalWindow.#pledge(target, 1);
    }

    static #pledge(target, delta) {
        const { actorId, itemId } = target.dataset;
        request({ op: 'pledge', actorId, itemId, delta });
    }
}

// Плата изменилась — окно перерисовывается у всех; кристаллы персонажей — тоже
Hooks.on('updateScene', (scene, changes) => {
    if (scene.id !== canvas.scene?.id || !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) return;
    const app = foundry.applications.instances?.get(PORTAL_ID);
    if (app?.rendered) app.render();
});
const refresh = item => {
    if (!item?.parent?.hasPlayerOwner) return;
    const app = foundry.applications.instances?.get(PORTAL_ID);
    if (app?.rendered) app.render();
};
for (const hook of ['createItem', 'updateItem', 'deleteItem']) Hooks.on(hook, refresh);
