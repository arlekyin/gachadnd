/**
 * Gacha Roguelike dnd5e — Взрыв трупа (синий навык взрыва)
 *
 * Использование: цель — труп (0 ПЗ, не персонаж игрока) в пределах дальности. Каждое существо в
 * радиусе навыка (10/15/20 футов по рангу) совершает спасбросок Ловкости, урон огнём — четверть
 * максимума ПЗ погибшего (успех — половина). Труп исчезает. Кого взрыв убил — на карточке кнопки
 * «Взорвать»: его труп взрывается сразу, без заряда.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { isBlast, ref, tokenOf, esc, quiet, dcOf, areaOf, feetBetween, around, isDead, blast, boomAt } from "./common.js";

const DEFAULT_RANGE = 60;

const userTarget = () => { const t = [...(game.user.targets ?? [])]; return t.length === 1 ? t[0].document : null; };
const isCorpse = token => !!token?.actor && isDead(token.actor) && token.actor.type !== 'character';

const chosen = new Map();
Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isBlast(item, 'corpse') || !actor) return;
    quiet(usage, message);
    const caster = tokenOf(actor)?.document;
    const corpse = userTarget();
    const range = Number(activity.range?.value) || DEFAULT_RANGE;
    if (!caster || !isCorpse(corpse)) {
        ui.notifications.warn('Взрыв трупа: выберите целью один труп (0 ПЗ).');
        return false;
    }
    if (feetBetween(caster, corpse) > range - 5) {
        ui.notifications.warn(`Взрыв трупа: труп дальше ${range} футов.`);
        return false;
    }
    chosen.set(item.id, corpse.id);
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    const corpseId = chosen.get(item?.id);
    if (!corpseId) return;
    chosen.delete(item.id);
    requestGM('blastCorpse', { ...ref(item.actor), corpseId, dc: dcOf(item), radius: areaOf(item, 10) });
});

onSocket('blastCorpse', ({ payload }) => { if (isActiveGM()) detonate(payload).catch(error => console.error(`${MODULE_ID} | Взрыв трупа`, error)); });

/** Мастер: труп взрывается; убитые — кнопки цепочки */
export async function detonate({ actorId, sceneId, corpseId, dc, radius }) {
    const scene = game.scenes.get(sceneId);
    const corpse = scene?.tokens.get(corpseId);
    const owner = game.actors.get(actorId);
    if (!corpse || !isCorpse(corpse) || !owner) return;
    const max = Number(corpse.actor.system.attributes.hp.max) || 4;
    const damage = Math.max(1, Math.floor(max / 4));
    const victims = around(corpse, radius).filter(t => !isDead(t.actor));
    const at = boomAt(corpse, radius);
    const name = corpse.name;
    await corpse.delete();
    await blast({
        actor: owner, title: `Взрыв трупа: ${name}`, icon: 'fa-skull', victims, formula: String(damage), type: 'fire', ability: 'dex', dc, at,
        note: `Четверть максимума ПЗ (${max}) — ${damage}. Кого взрыв убьёт — того можно взорвать сразу, без заряда: кнопка «Цепная реакция» ниже, после применения урона.`,
        flags: { corpse: { actorId: owner.id, dc, radius } }
    });
}

/** Мастер: кого из задетых взрывом уже нет в живых — кнопки цепочки */
export async function chain({ messageId }) {
    const message = game.messages.get(messageId);
    const card = message?.flags?.[MODULE_ID]?.blastCard;
    if (!card?.corpse) return;
    const scene = game.scenes.get(card.sceneId);
    const dead = (card.victims ?? []).map(id => scene?.tokens.get(id)).filter(t => isCorpse(t));
    const owner = game.actors.get(card.corpse.actorId);
    if (!dead.length) return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: owner }), whisper: ChatMessage.getWhisperRecipients('GM').map(u => u.id), content: '<div class="gd-blast-card"><p>Цепной реакции нет: никто из задетых не погиб — урон ещё не применён?</p></div>' });
    await message.update({ [`flags.${MODULE_ID}.blastCard.corpse.used`]: true });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: owner }),
        content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-skull"></i> Цепная реакция</div><p>Взрыв убил — эти трупы можно взорвать сразу, без заряда:</p><div class="gd-blast-buttons">${dead.map(t => `<button type="button" data-corpse-chain="${t.id}">${esc(t.name)}</button>`).join('')}</div></div>`,
        flags: { [MODULE_ID]: { corpseChain: { actorId: owner.id, sceneId: card.sceneId, dc: card.corpse.dc, radius: card.corpse.radius } } }
    });
}
onSocket('blastCorpseChain', ({ payload }) => { if (isActiveGM()) chain(payload).catch(error => console.error(`${MODULE_ID} | Взрыв трупа`, error)); });

// Карточка взрыва трупа: кнопка «Цепная реакция» — владельцу и Мастеру
onRenderChatMessage((message, html) => {
    const card = message.flags?.[MODULE_ID]?.blastCard;
    if (!card?.corpse || !html?.querySelector || html.querySelector('[data-corpse-chain-check]')) return;
    const owner = game.actors.get(card.corpse.actorId);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.corpseChainCheck = '';
    button.innerHTML = '<i class="fas fa-skull"></i> Цепная реакция';
    button.disabled = !!card.corpse.used || !(game.user.isGM || owner?.isOwner);
    button.addEventListener('click', () => { button.disabled = true; requestGM('blastCorpseChain', { messageId: message.id }); });
    const wrap = document.createElement('div');
    wrap.className = 'gd-blast-buttons';
    wrap.append(button);
    (html.querySelector('.gd-blast-card') ?? html).append(wrap);
});

onRenderChatMessage((message, html) => {
    const flag = message.flags?.[MODULE_ID]?.corpseChain;
    if (!flag) return;
    const owner = game.actors.get(flag.actorId);
    for (const button of html?.querySelectorAll?.('[data-corpse-chain]') ?? []) {
        const token = game.scenes.get(flag.sceneId)?.tokens.get(button.dataset.corpseChain);
        if (!token || !(game.user.isGM || owner?.isOwner)) { button.disabled = true; continue; }
        button.addEventListener('click', () => {
            button.disabled = true;
            requestGM('blastCorpse', { actorId: flag.actorId, sceneId: flag.sceneId, corpseId: token.id, dc: flag.dc, radius: flag.radius });
        });
    }
});
