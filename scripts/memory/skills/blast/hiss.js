/**
 * Gacha Roguelike dnd5e — Ссссс… (фиолетовый навык взрыва)
 *
 * Использование в бою: персонаж шипит (эффект на нём, надпись над токеном у всех). В конце его
 * следующего хода, если вплотную есть враг, — взрыв: каждое существо в радиусе навыка (10 футов)
 * совершает спасбросок Ловкости, урон навыка звуком (успех — половина); сам персонаж — половину
 * без спасброска. Никого рядом — взрыва нет, заряд возвращается.
 *
 * Флаг боя hiss { actorId, tokenId, combatantId, round, formula, dc, radius }.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { isBlast, blastSkill, ref, actorFrom, tokenOf, esc, quiet, damageOf, dcOf, areaOf, feetBetween, around, blast, boomAt } from "./common.js";
import { t } from "../../../core/i18n.js";

const FLAG = 'hiss';
const ICON = 'icons/svg/explosion.svg';

Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isBlast(item, 'hiss') || !actor) return;
    quiet(usage, message);
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id) || !tokenOf(actor)) {
        ui.notifications.warn(t('Ссссс… — только в бою, в котором участвует персонаж.'));
        return false;
    }
    if (combat.getFlag(MODULE_ID, FLAG)?.actorId === actor.id) {
        ui.notifications.warn(t('Вы уже шипите.'));
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isBlast(item, 'hiss') || !item.actor) return;
    requestGM('blastHiss', { ...ref(item.actor), formula: damageOf(item, { formula: '6d6', type: 'thunder' }).formula, dc: dcOf(item), radius: areaOf(item, 10) });
});

onSocket('blastHiss', ({ payload }) => { if (isActiveGM()) start(payload).catch(error => console.error(`${MODULE_ID} | Ссссс`, error)); });
onSocket('blastHissText', data => hissText(data));

function hissText({ sceneId, tokenId }) {
    const token = canvas?.scene?.id === sceneId ? canvas.tokens.get(tokenId) : null;
    if (token) canvas.interface?.createScrollingText?.(token.center, t('ссссс…'), { anchor: CONST.TEXT_ANCHOR_POINTS?.TOP ?? 2, fontSize: 30, fill: '#7dff6a', stroke: '#000000', strokeThickness: 5, duration: 2400 });
}

export async function start({ actorId, tokenId, sceneId, formula, dc, radius }) {
    const combat = game.combat;
    const actor = actorFrom({ actorId, tokenId, sceneId });
    const combatant = combat?.combatants.find(c => c.tokenId === tokenId || c.actor?.id === actorId);
    if (!combat || !actor || !combatant) return;
    await combat.setFlag(MODULE_ID, FLAG, { actorId: actor.id, tokenId, combatantId: combatant.id, round: combat.round, formula, dc, radius });
    await actor.createEmbeddedDocuments('ActiveEffect', [{ name: t('Шипит'), img: ICON, showIcon: 2, description: t('В конце следующего хода — взрыв, если рядом враг.'), flags: { [MODULE_ID]: { hiss: true } } }]);
    emit('blastHissText', { sceneId, tokenId });
    hissText({ sceneId, tokenId });
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-explosion"></i> ${t('Ссссс…')}</div><p>${t('{v} шипит. Кто останется рядом к концу его следующего хода — пожалеет.', { v: esc(actor.name) })}</p></div>` });
}

async function stop(combat, actor) {
    await combat.unsetFlag(MODULE_ID, FLAG);
    const ids = (actor?.effects ?? []).filter(e => e.flags?.[MODULE_ID]?.hiss).map(e => e.id);
    if (ids.length) await actor.deleteEmbeddedDocuments('ActiveEffect', ids);
}

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const state = combat.getFlag(MODULE_ID, FLAG);
    if (!state || combat.previous?.combatantId !== state.combatantId || (combat.previous?.round ?? combat.round) <= state.round) return;
    const scene = combat.scene ?? canvas.scene;
    const token = scene.tokens.get(state.tokenId);
    const actor = token?.actor ?? game.actors.get(state.actorId);
    await stop(combat, actor);
    if (!token) return;
    const enemies = scene.tokens.filter(t => t.actor && t.id !== token.id && t.disposition && t.disposition === -token.disposition && feetBetween(token, t) === 0 && (t.actor.system?.attributes?.hp?.value ?? 1) > 0);
    if (!enemies.length) {
        const item = blastSkill(actor, 'hiss');
        if (item) await item.update({ 'system.uses.spent': Math.max(0, (Number(item.system.uses.spent) || 0) - 1) });
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-explosion"></i> ${t('Ссссс…')}</div><p>${t('Рядом никого — шипение стихло. Заряд вернулся.')}</p></div>` });
        return;
    }
    await blast({ actor, title: t('{name} взрывается', { name: actor.name }), icon: 'fa-explosion', victims: around(token, state.radius), formula: state.formula, type: 'thunder', ability: 'dex', dc: state.dc, self: actor, at: boomAt(token, state.radius) });
});

Hooks.on('deleteCombat', async (combat) => {
    const state = combat.getFlag(MODULE_ID, FLAG);
    if (state && isActiveGM()) {
        const actor = game.actors.get(state.actorId);
        const ids = (actor?.effects ?? []).filter(e => e.flags?.[MODULE_ID]?.hiss).map(e => e.id);
        if (ids.length) await actor.deleteEmbeddedDocuments('ActiveEffect', ids);
    }
});
