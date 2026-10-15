/**
 * Gacha Roguelike dnd5e — Ультрафиолет (серый навык света)
 *
 * Использование высвечивает всё в пределах дальности навыка (по рангу — 30 или 60 футов): тайные
 * двери стен сцены в этой области становятся обычными — их видят и открывают игроки. Двери меняет
 * Мастер.
 */

import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { isLight, ref, actorFrom, tokenOf, feetToPx, centerOf, distToSegment, lightCard } from "./common.js";

const DEFAULT_RANGE = 30;

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isLight(item, 'ultraviolet') || !item.actor) return;
    if (!tokenOf(item.actor)) {
        ui.notifications.warn('Ультрафиолет: токена персонажа нет на сцене.');
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isLight(item, 'ultraviolet') || !item.actor) return;
    const range = Number(activity.range?.value) || DEFAULT_RANGE;
    requestGM('lightUltraviolet', { ...ref(item.actor), range });
});

onSocket('lightUltraviolet', ({ payload }) => {
    if (!isActiveGM()) return;
    reveal(payload).catch(error => console.error('gachadnd | Ультрафиолет', error));
});

/** Мастер: тайные двери в радиусе становятся обычными. @returns {Promise<number>} сколько проступило */
export async function reveal({ actorId, tokenId, sceneId, range }) {
    const actor = actorFrom({ actorId, tokenId, sceneId });
    const scene = game.scenes.get(sceneId);
    const token = scene?.tokens.get(tokenId);
    if (!actor || !token) return 0;
    const center = centerOf(token);
    const reach = feetToPx(range, scene);
    const { SECRET, DOOR } = CONST.WALL_DOOR_TYPES;
    const found = scene.walls.filter(w => w.door === SECRET
        && distToSegment(center, { x: w.c[0], y: w.c[1] }, { x: w.c[2], y: w.c[3] }) <= reach);
    if (found.length) await scene.updateEmbeddedDocuments('Wall', found.map(w => ({ _id: w.id, door: DOOR })));
    await lightCard(actor, 'Ультрафиолет', found.length
        ? `<p>В ${range} футах проступили тайные двери: ${found.length}.</p>`
        : `<p>В ${range} футах тайных дверей нет.</p>`, { icon: 'fa-eye' });
    return found.length;
}
