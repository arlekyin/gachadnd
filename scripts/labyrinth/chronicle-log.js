/**
 * Gacha Roguelike dnd5e — Записи Летописи этажа
 *
 * Что случилось на узлах карты: сгоревшие навыки, прорывы Пожирателя, дары луны. Записи лежат в карте
 * этажа (floorMap.chronicle: [{ kind, text, nodeId }]) и уходят вместе с ней; Летопись читает их, когда
 * Мастер чертит следующий этаж. Павшие, Сделка луны и жильцы берутся из своих данных.
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM } from "../core/socket.js";
import { mapScene } from "./scene-travel.js";
import { isMemorySkill } from "../memory/synergy/synergy.js";

let queue = Promise.resolve();

/** Записать событие на текущий узел карты (только активный Мастер) */
export function logChronicle(kind, text, nodeId = null) {
    if (!isActiveGM()) return queue;
    queue = queue.then(async () => {
        const scene = mapScene();
        const map = scene?.getFlag(MODULE_ID, 'floorMap');
        const at = nodeId ?? map?.currentNodeId;
        if (!map || !at) return;
        await scene.setFlag(MODULE_ID, 'floorMap.chronicle', [...(map.chronicle ?? []), { kind, text, nodeId: at }]);
    }).catch(error => console.error(`${MODULE_ID} | Летопись`, error));
    return queue;
}

// Навык сгорел: перегрев, Голод, вытеснение, пара Сплава. Очистка и жертва луне — не «сгорел»
Hooks.on('deleteItem', (item, options) => {
    if (!isActiveGM() || options.gachadndCleanse || options.gachadndMoon || !isMemorySkill(item) || item.flags?.[MODULE_ID]?.scar) return;
    const actor = item.parent;
    if (actor?.type !== 'character' || !actor.hasPlayerOwner) return;
    logChronicle('burn', `${actor.name}: «${item.name}»`);
});
