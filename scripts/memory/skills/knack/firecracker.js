/**
 * Gacha Roguelike dnd5e — Хлопушка (серый навык огня и взрыва)
 *
 * Бонусным действием — хлопок у ног: каждое существо в радиусе навыка (10 футов, ранги — 15 и 20),
 * кроме самого персонажа, до начала своего следующего хода не может совершать реакции. В бою — эффект
 * на ход (снимается в начале хода существа), вне боя — на 6 секунд. Реакции dnd5e не запрещает:
 * эффект на токене — напоминание столу.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { addTurnEffect } from "../turn-effects.js";
import { isKnack, ref, actorFrom, tokenOf, esc, quiet, areaOf, around, boom, boomAt, card } from "./common.js";

const ICON = 'icons/svg/sound.svg';

Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'firecracker') || !actor) return;
    quiet(usage, message);
    if (!tokenOf(actor)) {
        ui.notifications.warn('Хлопушка: токена персонажа нет на сцене.');
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isKnack(item, 'firecracker') || !item.actor) return;
    requestGM('knackFirecracker', { ...ref(item.actor), radius: areaOf(item, 10) });
});

onSocket('knackFirecracker', ({ payload }) => {
    if (isActiveGM()) bang(payload).catch(error => console.error(`${MODULE_ID} | Хлопушка`, error));
});

export async function bang({ actorId, tokenId, sceneId, radius }) {
    const scene = game.scenes.get(sceneId);
    const token = scene?.tokens.get(tokenId);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!token || !actor) return;
    const combat = game.combat?.started ? game.combat : null;
    const deaf = around(token, radius);
    const effect = {
        name: 'Хлопушка: без реакций', img: ICON,
        description: '<p>Уши заложило: до начала своего следующего хода существо не может совершать реакции.</p>',
        flags: { [MODULE_ID]: { firecracker: true } }
    };
    for (const t of deaf) {
        const inFight = combat?.combatants.some(c => c.tokenId === t.id);
        if (inFight) await addTurnEffect(t.actor, combat, effect, { until: 'nextStart', tokenId: t.id });
        else await t.actor.createEmbeddedDocuments('ActiveEffect', [{ ...effect, showIcon: 2, duration: { seconds: 6 } }]);
    }
    boom({ ...boomAt(token, radius), color: 0xffe066 });
    return card(actor, 'Хлопушка', deaf.length
        ? `<p>Хлопок! До начала своего хода без реакций: ${esc(deaf.map(t => t.name).join(', '))}.</p>`
        : '<p>Хлопок вхолостую — рядом никого.</p>', { icon: 'fa-burst' });
}
