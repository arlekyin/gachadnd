/**
 * Gacha Roguelike dnd5e — Распределение добычи по очереди
 *
 * Кристаллы комнаты ложатся в общий пул, а персонажи отряда забирают их по одному по очереди, пока пул
 * не опустеет. Первым выбирает следующий по кругу: каждая новая добыча сдвигает очередь на одного.
 * Так кристаллы делятся поровну, а лучший достаётся каждому по очереди.
 *
 * Состояние — в настройке мира draftState; пишет её Мастер, игроки просят выбор через сокет.
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM, onSocket, notifyUser, requestGM } from "../core/socket.js";
import { isMemorySkill } from "./synergy/synergy.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const DRAFT_ID = 'gachadnd-draft';
const RARITY_COLORS = { gray: '#9d9d9d', green: '#1eff00', blue: '#0070dd', purple: '#a335ee', red: '#ff003c', orange: '#ff8000' };

export function registerDraftSettings() {
    game.settings.register(MODULE_ID, 'draftState', {
        scope: 'world', config: false, type: Object, default: {},
        onChange: value => value?.active ? DraftWindow.show() : DraftWindow.close()
    });
    game.settings.register(MODULE_ID, 'draftOffset', { scope: 'world', config: false, type: Number, default: 0 });
}

const getDraft = () => game.settings.get(MODULE_ID, 'draftState') ?? {};
const draftParty = () => game.actors.filter(a => a.type === 'character' && a.hasPlayerOwner)
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Начать распределение (Мастер). Кристаллы — данные предметов из генератора добычи.
 * @returns {string[]|null} имена в порядке выбора, или null, если отряда нет
 */
export async function startDraft(roomName, crystals) {
    const party = draftParty();
    if (!party.length || !crystals.length) return null;
    if (getDraft().active) await finishDraft('Предыдущее распределение закрыто: началось новое.');
    const offset = game.settings.get(MODULE_ID, 'draftOffset') % party.length;
    await game.settings.set(MODULE_ID, 'draftOffset', offset + 1);
    const order = [...party.slice(offset), ...party.slice(0, offset)].map(a => a.id);
    // Отстающий выбирает первым: у кого в Памяти меньше всех фиолетовых и красных навыков (если кто-то впереди)
    const rare = id => game.actors.get(id).items.filter(i => isMemorySkill(i) && ['purple', 'red'].includes(i.flags[MODULE_ID]?.rarity)).length;
    const counts = order.map(rare);
    const least = Math.min(...counts);
    let lagging = null;
    if (least < Math.max(...counts)) {
        lagging = order[counts.indexOf(least)];
        order.splice(order.indexOf(lagging), 1);
        order.unshift(lagging);
    }
    await game.settings.set(MODULE_ID, 'draftState', {
        active: true, room: roomName, order, turn: 0, picks: [], lagging,
        pool: crystals.map(data => ({ key: foundry.utils.randomID(), data }))
    });
    return order.map(id => `${game.actors.get(id)?.name}${id === lagging ? ' (вне очереди)' : ''}`);
}

async function finishDraft(note) {
    const draft = getDraft();
    await game.settings.set(MODULE_ID, 'draftState', {});
    const byActor = {};
    for (const p of draft.picks ?? []) (byActor[p.actorId] ??= []).push(p);
    const picks = Object.entries(byActor)
        .map(([id, list]) => `<div><strong>${game.actors.get(id)?.name ?? '—'}:</strong> ${list.map(p => `<span style="color: ${RARITY_COLORS[p.rarity] ?? '#aaa'}">${p.name}</span>`).join(', ')}</div>`)
        .join('');
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Туманный Разлом' }),
        content: `<div class="gd-draft-chat"><strong>Распределение: ${draft.room ?? 'добыча'}</strong>${picks}${note ? `<div><em>${note}</em></div>` : ''}</div>`
    });
}

// ==========================================
// ОПЕРАЦИИ (выполняет Мастер)
// ==========================================

async function performDraftOp({ op, key, userId }) {
    const draft = foundry.utils.deepClone(getDraft());
    if (!draft.active) return;
    const user = game.users.get(userId);
    const actor = game.actors.get(draft.order[draft.turn % draft.order.length]);

    if (op === 'pick') {
        if (!actor) return;
        if (!user?.isGM && !actor.testUserPermission(user, 'OWNER')) return notifyUser(userId, `Сейчас выбирает ${actor.name}.`);
        const index = draft.pool.findIndex(p => p.key === key);
        if (index < 0) return;
        const [{ data }] = draft.pool.splice(index, 1);
        await actor.createEmbeddedDocuments('Item', [data]);
        draft.picks.push({ actorId: actor.id, name: data.name.replace(/^Кристалл:\s*/, ''), rarity: data.flags?.[MODULE_ID]?.rarity ?? 'gray' });
        draft.turn += 1;
    } else if (op === 'skip' && user?.isGM) {
        draft.turn += 1;
    } else if (op === 'stop' && user?.isGM) {
        return finishDraft(draft.pool.length ? `Мастер закрыл распределение; не разобрано кристаллов: ${draft.pool.length}.` : '');
    } else return;

    if (!draft.pool.length) {
        await game.settings.set(MODULE_ID, 'draftState', draft);
        return finishDraft('');
    }
    await game.settings.set(MODULE_ID, 'draftState', draft);
}

let queue = Promise.resolve();
onSocket('draftOp', message => {
    if (!isActiveGM()) return;
    queue = queue.then(() => performDraftOp(message.payload)).catch(err => console.error('[GachaDND] Распределение:', err));
    return queue;
});

const request = payload => requestGM('draftOp', payload);

// ==========================================
// ОКНО РАСПРЕДЕЛЕНИЯ
// ==========================================

export class DraftWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: DRAFT_ID,
        classes: ['gachadnd-draft'],
        tag: 'div',
        window: { title: 'Распределение добычи', icon: 'fas fa-gem', resizable: true },
        position: { width: 640, height: 560 },
        actions: {
            pick: (event, target) => request({ op: 'pick', key: target.dataset.key }),
            skip: () => request({ op: 'skip' }),
            stop: () => request({ op: 'stop' })
        }
    };

    static PARTS = { body: { template: 'modules/gachadnd/templates/draft/body.hbs', scrollable: ['.gd-draft-pool'] } };

    static show() {
        const existing = foundry.applications.instances?.get(DRAFT_ID);
        if (existing) return existing.render({ force: true });
        return new DraftWindow().render({ force: true });
    }

    static close() {
        foundry.applications.instances?.get(DRAFT_ID)?.close();
    }

    async _prepareContext() {
        const draft = getDraft();
        if (!draft.active) return { active: false };
        const current = draft.turn % draft.order.length;
        const picker = game.actors.get(draft.order[current]);
        const mine = game.user.isGM || !!picker?.isOwner;
        const counts = {};
        for (const p of draft.picks) counts[p.actorId] = (counts[p.actorId] ?? 0) + 1;
        return {
            active: true, room: draft.room, mine, isGM: game.user.isGM, picker: picker?.name ?? '—',
            order: draft.order.map((id, n) => {
                const actor = game.actors.get(id);
                return { name: actor?.name ?? '—', img: actor?.img, current: n === current, count: counts[id] ?? 0, lagging: id === draft.lagging };
            }),
            pool: draft.pool.map(({ key, data }) => {
                const flags = data.flags?.[MODULE_ID] ?? {};
                return {
                    key, img: data.img, name: data.name.replace(/^Кристалл:\s*/, ''),
                    color: RARITY_COLORS[flags.rarity] ?? '#aaa', category: flags.category ?? '', tags: (flags.tags ?? []).join(', ')
                };
            })
        };
    }
}

// Распределение уже идёт, когда игрок подключается, — окно открывается и у него
Hooks.once('ready', () => {
    if (getDraft().active) DraftWindow.show();
});
