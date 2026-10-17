/**
 * Gacha Roguelike dnd5e — Горячая картошка (зелёный навык взрыва)
 *
 * Использование в бою: бомба прилипает к цели в 5 футах (цель — выбранный токен). Таймер 1d4 + 1
 * раунд видит только владелец навыка (и Мастер); он тикает в начале каждого раунда. На носителе —
 * эффект с бомбой. Кнопка «Передать» на карточке: носитель (его владелец или Мастер) передаёт бомбу
 * своей цели вплотную — но не тому, от кого получил её в этом раунде. Таймер дошёл до нуля — взрыв
 * у носителя: полный урон ему, половина — каждому вплотную.
 *
 * Флаг боя potatoes [{ id, ownerId, holder, timer, formula, from, passRound }].
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { isBlast, ref, actorFrom, tokenOf, esc, quiet, damageOf, feetBetween, around, blast, boomAt } from "./common.js";

const FLAG = 'potatoes';
const BOMB = 'icons/weapons/thrown/bomb-fuse-black-grey.webp';

const listOf = combat => [...(combat?.getFlag(MODULE_ID, FLAG) ?? [])];
const adjacent = (a, b) => a && b && a.id !== b.id && feetBetween(a, b) === 0;
const userTarget = () => { const t = [...(game.user.targets ?? [])]; return t.length === 1 ? t[0].document : null; };

const chosen = new Map();
Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isBlast(item, 'potato') || !actor) return;
    quiet(usage, message);
    const combat = game.combat;
    const caster = tokenOf(actor)?.document;
    const target = userTarget();
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id) || !caster) {
        ui.notifications.warn('Горячая картошка — только в бою, в котором участвует персонаж.');
        return false;
    }
    if (!adjacent(caster, target)) {
        ui.notifications.warn('Горячая картошка: выберите целью одно существо вплотную к вам.');
        return false;
    }
    chosen.set(item.id, target.id);
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    const targetId = chosen.get(item?.id);
    if (!targetId) return;
    chosen.delete(item.id);
    requestGM('blastPotato', { ...ref(item.actor), targetId, formula: damageOf(item, { formula: '3d6' }).formula });
});

onSocket('blastPotato', ({ payload }) => { if (isActiveGM()) stick(payload).catch(error => console.error(`${MODULE_ID} | Картошка`, error)); });
onSocket('blastPotatoPass', ({ payload }) => { if (isActiveGM()) pass(payload).catch(error => console.error(`${MODULE_ID} | Картошка`, error)); });

async function mark(token, id, on) {
    const actor = token?.actor;
    if (!actor) return;
    if (on) {
        await actor.createEmbeddedDocuments('ActiveEffect', [{ name: 'Горячая картошка', img: BOMB, showIcon: 2, description: 'К вам прилипла бомба. Бонусным действием её можно передать существу вплотную.', flags: { [MODULE_ID]: { potato: id } } }]);
    } else {
        const ids = actor.effects.filter(e => e.flags?.[MODULE_ID]?.potato === id).map(e => e.id);
        if (ids.length) await actor.deleteEmbeddedDocuments('ActiveEffect', ids);
    }
}

/** Мастер: бомба прилипла */
export async function stick({ actorId, tokenId, sceneId, targetId, formula }) {
    const combat = game.combat;
    const owner = actorFrom({ actorId, tokenId, sceneId });
    const target = game.scenes.get(sceneId)?.tokens.get(targetId);
    if (!combat || !owner || !target) return;
    const roll = await new Roll('1d4 + 1').evaluate();
    // Таймер — видимый бросок, но шёпотом: только владельцу и Мастеру
    const whisper = game.users.filter(u => u.isGM || owner.testUserPermission(u, 'OWNER')).map(u => u.id);
    // Режим броска «открытый» по умолчанию стёр бы шёпот: сообщение собирается и шепчется явно
    const data = await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: owner }), flavor: `Таймер бомбы: взрыв в начале раунда ${combat.round + roll.total}. Никому не говорите.` }, { create: false });
    await ChatMessage.create({ ...data, whisper });
    const id = foundry.utils.randomID();
    await combat.setFlag(MODULE_ID, FLAG, [...listOf(combat), { id, ownerId: owner.id, holder: target.id, timer: roll.total, formula, from: tokenId, passRound: combat.round }]);
    await mark(target, id, true);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: owner }),
        content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-bomb"></i> Горячая картошка</div><p>Бомба прилипла к ${esc(target.name)}. Тикает…</p><div class="gd-blast-buttons"><button type="button" data-potato-pass="${id}"><i class="fas fa-hand-holding"></i> Передать своей цели</button></div></div>`,
        flags: { [MODULE_ID]: { potato: id } }
    });
}

/** Мастер: передать бомбу */
export async function pass({ id, toId, userId }) {
    const combat = game.combat;
    const list = listOf(combat);
    const bomb = list.find(b => b.id === id);
    const scene = combat?.scene ?? canvas.scene;
    const holder = scene?.tokens.get(bomb?.holder), to = scene?.tokens.get(toId);
    const user = game.users.get(userId);
    const warn = text => user?.isSelf ? ui.notifications.warn(text) : ui.notifications.warn(`${user?.name ?? ''}: ${text}`);
    if (!bomb || !holder || !to) return warn('Бомбы уже нет.');
    if (!(user?.isGM || holder.actor?.testUserPermission(user, 'OWNER'))) return warn('Передать бомбу может только тот, у кого она в руках.');
    if (!adjacent(holder, to)) return warn('Передать можно только существу вплотную.');
    if (to.id === bomb.from && bomb.passRound === combat.round) return warn('Нельзя вернуть бомбу тому, кто дал её в этом раунде.');
    await combat.setFlag(MODULE_ID, FLAG, list.map(b => b.id === id ? { ...b, holder: to.id, from: holder.id, passRound: combat.round } : b));
    await mark(holder, id, false);
    await mark(to, id, true);
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ token: holder }), content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-hand-holding"></i> Горячая картошка</div><p>${esc(holder.name)} суёт бомбу ${esc(to.name)}!</p></div>` });
}

onRenderChatMessage((message, html) => {
    const button = html?.querySelector?.('[data-potato-pass]');
    if (!button) return;
    if (!listOf(game.combat).some(b => b.id === button.dataset.potatoPass)) { button.disabled = true; return; }
    button.addEventListener('click', () => {
        const to = userTarget();
        if (!to) return ui.notifications.warn('Выберите целью (T) существо, которому передаёте бомбу.');
        requestGM('blastPotatoPass', { id: button.dataset.potatoPass, toId: to.id });
    });
});

// Новый раунд: таймеры тикают, кончился — взрыв у носителя
Hooks.on('updateCombat', async (combat, changed) => {
    if (!('round' in changed) || !isActiveGM() || !combat.started) return;
    const list = listOf(combat);
    if (!list.length) return;
    const scene = combat.scene ?? canvas.scene;
    const left = [];
    for (const bomb of list) {
        const timer = bomb.timer - 1;
        if (timer > 0) { left.push({ ...bomb, timer }); continue; }
        const holder = scene.tokens.get(bomb.holder);
        if (!holder) continue;
        await mark(holder, bomb.id, false);
        const owner = game.actors.get(bomb.ownerId);
        await blast({ actor: owner ?? holder.actor, title: `Горячая картошка взрывается у ${holder.name}`, icon: 'fa-bomb', victims: [holder], splash: around(holder, 5), formula: bomb.formula, type: 'fire', at: boomAt(holder, 10) });
    }
    await combat.setFlag(MODULE_ID, FLAG, left);
});

Hooks.on('deleteCombat', async (combat) => {
    if (!isActiveGM()) return;
    const scene = combat.scene ?? canvas.scene;
    for (const bomb of listOf(combat)) await mark(scene?.tokens.get(bomb.holder), bomb.id, false);
});
