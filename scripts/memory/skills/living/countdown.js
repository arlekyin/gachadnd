/**
 * Gacha Roguelike dnd5e — Обратный отсчёт (синий навык взрыва)
 *
 * Бонусным действием — на существо в пределах 30 футов (цель — выделенная, T) вешается отсчёт 3. В начале
 * каждого хода владельца −1. На нуле — взрыв радиусом 10 футов вокруг носителя: урон навыка звуком (ранги —
 * больше костей) и ещё 1к6 за каждое попадание владельца по носителю, пока шёл отсчёт; спасбросок
 * Ловкости — половина. Погиб носитель раньше — взрыв сразу. Только в бою.
 *
 * Флаг боя countdowns: [{ id, ownerId, tokenId, sceneId, value, hits, dice, dc }]. Число видят все
 * (badges.js): отсчёт — угроза, которую видно заранее.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { isLiving, ref, tokenOf, quiet, dcOf, damageOf, around, blast, boomAt, feetBetween, sourceOf, esc } from "./common.js";

const KIND = 'countdown';
const FLAG = 'countdowns';
const START = 3, RANGE = 30, RADIUS = 10;

export const countdownsOf = combat => combat?.getFlag(MODULE_ID, FLAG) ?? [];
const save = (combat, list) => combat.setFlag(MODULE_ID, FLAG, list);

// Выделенная цель в пределах 30 футов; иначе навык не используется
const aimed = new Map();
Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLiving(item, KIND) || !actor) return;
    quiet(usage);
    const caster = tokenOf(actor);
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id) || !caster) {
        ui.notifications.warn('Обратный отсчёт — только в бою, в котором участвует персонаж.');
        return false;
    }
    const target = [...game.user.targets][0]?.document;
    const reach = RANGE - (caster.document.parent.grid.distance || 5);
    if (!target?.actor || target.id === caster.document.id || feetBetween(caster.document, target) > reach) {
        ui.notifications.warn(`Обратный отсчёт: выделите (T) существо в пределах ${RANGE} футов.`);
        return false;
    }
    aimed.set(item.id, target.id);
});

Hooks.on('dnd5e.postUseActivity', activity => {
    const item = activity?.item;
    const tokenId = aimed.get(item?.id);
    if (!tokenId) return;
    aimed.delete(item.id);
    const dice = Number(/^(\d+)d6/.exec(damageOf(item, { formula: '3d6' }).formula)?.[1]) || 3;
    requestGM('livingCountdown', { ...ref(item.actor), target: tokenId, dice, dc: dcOf(item) });
});

onSocket('livingCountdown', ({ payload }) => {
    if (isActiveGM()) hang(payload).catch(error => console.error(`${MODULE_ID} | Обратный отсчёт`, error));
});

export async function hang({ actorId, sceneId, target, dice, dc }) {
    const combat = game.combat;
    const token = game.scenes.get(sceneId)?.tokens.get(target);
    if (!combat || !token) return;
    const list = countdownsOf(combat).filter(c => c.tokenId !== target);
    list.push({ id: foundry.utils.randomID(), ownerId: actorId, tokenId: target, sceneId, value: START, hits: 0, dice, dc });
    await save(combat, list);
    const owner = game.actors.get(actorId);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: owner }),
        content: `<div class="gd-blast-card gd-living-card"><div class="gd-blast-title"><i class="fas fa-stopwatch"></i> Обратный отсчёт: ${esc(token.name)}</div><p>Отсчёт <strong>${START}</strong> — минус один в начале каждого хода ${esc(owner?.name)}. На нуле — взрыв 10 футов: ${dice}к6 звуком и ещё 1к6 за каждое попадание по носителю.</p></div>`
    });
}

async function explode(combat, entry, reason) {
    await save(combat, countdownsOf(combat).filter(c => c.id !== entry.id));
    const scene = game.scenes.get(entry.sceneId);
    const token = scene?.tokens.get(entry.tokenId);
    if (!token) return;
    const owner = game.actors.get(entry.ownerId);
    const victims = [token, ...around(token, RADIUS)];
    await blast({
        actor: owner, title: `Обратный отсчёт: взрыв (${token.name})`, icon: 'fa-stopwatch', victims,
        formula: `${entry.dice + entry.hits}d6`, type: 'thunder', ability: 'dex', dc: entry.dc,
        note: `${esc(reason)}. ${entry.dice}к6 и ещё ${entry.hits}к6 за попадания по носителю.`,
        at: boomAt(token, RADIUS)
    });
}

// Начало хода владельца: −1, на нуле — взрыв
Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const actorId = combat.combatant?.actor?.id;
    const list = countdownsOf(combat);
    if (!actorId || !list.some(c => c.ownerId === actorId)) return;
    const next = list.map(c => (c.ownerId === actorId ? { ...c, value: c.value - 1 } : c));
    await save(combat, next);
    for (const entry of next.filter(c => c.ownerId === actorId && c.value <= 0)) await explode(combat, entry, 'Отсчёт дошёл до нуля');
});

// Попадание владельца по носителю — +1к6; носитель пал — взрыв сразу
Hooks.on('dnd5e.applyDamage', async (actor, amount, options) => {
    if (!isActiveGM() || !(amount > 0)) return;
    const combat = game.combat;
    const list = countdownsOf(combat);
    if (!list.length) return;
    const tokenId = actor.token?.id ?? tokenOf(actor)?.document?.id;
    const entry = list.find(c => c.tokenId === tokenId);
    if (!entry) return;
    const hp = Number(actor.system?.attributes?.hp?.value) || 0;
    if (hp <= 0) return explode(combat, entry, `${actor.name} падает — отсчёт обрывается взрывом`);
    if (sourceOf(options)?.id !== entry.ownerId) return;
    await save(combat, list.map(c => (c.id === entry.id ? { ...c, hits: c.hits + 1 } : c)));
});
