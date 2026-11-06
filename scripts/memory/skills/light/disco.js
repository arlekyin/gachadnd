/**
 * Gacha Roguelike dnd5e — Диско-шар (фиолетовый навык света)
 *
 * Использование в бою подвешивает шар над персонажем: сразу и в начале каждого раунда на 6 случайных
 * клетках в пределах 30 футов от места шара вспыхивают цветные пятна — цветные источники света сцены.
 * Существо, которое начинает ход на пятне или впервые за свой ход заходит на него, тянет карту
 * Чумовой пятницы (freaky-cards.js): баф или дебаф до конца своего следующего хода.
 *
 * Шар горит 10 раундов или до конца боя. Флаг боя disco { actorId, x, y, until, spots, lights, drawn }:
 * spots — клетки пятен ({ i, j }), lights — id источников света, drawn — кто уже тянул в этот ход.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { dealCards, applyCards, broadcastCards, CARDS } from "../freaky-cards.js";
import { isLight, ref, actorFrom, tokenOf, centerOf, lightCard, esc } from "./common.js";
import { t } from "../../../core/i18n.js";

const ROUNDS = 10, SPOTS = 6, RADIUS_FT = 30;
const COLORS = ['#ff2d95', '#00e5ff', '#ffe600', '#7cff00', '#b04dff', '#ff7a00'];
const FLAG = 'disco';

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLight(item, 'disco') || !actor) return;
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id)) {
        ui.notifications.warn(t('Диско-шар — только в бою, в котором участвует персонаж.'));
        return false;
    }
    if (!tokenOf(actor)) {
        ui.notifications.warn(t('Диско-шар: токена персонажа нет на сцене.'));
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isLight(item, 'disco') || !item.actor) return;
    requestGM('lightDisco', ref(item.actor));
});

onSocket('lightDisco', ({ payload }) => {
    if (!isActiveGM()) return;
    start(payload).catch(error => console.error(`gachadnd | Диско-шар`, error));
});

/** Мастер: шар над персонажем и первые пятна */
export async function start({ actorId, tokenId, sceneId }) {
    const combat = game.combat;
    const scene = game.scenes.get(sceneId);
    const token = scene?.tokens.get(tokenId);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!combat || !token || !actor) return;
    const old = combat.getFlag(MODULE_ID, FLAG);
    if (old) await clearLights(scene, old);
    const { x, y } = centerOf(token);
    await combat.setFlag(MODULE_ID, FLAG, { actorId: actor.id, x, y, until: combat.round + ROUNDS, spots: [], lights: [], drawn: {} });
    await lightCard(actor, t('Диско-шар'), `<p>${t('Над полем боя закружился диско-шар — до конца раунда {v}. Кто встанет на пятно, тянет карту.', { v: combat.round + ROUNDS - 1 })}</p>`, { icon: 'fa-compact-disc', cls: 'disco' });
    await respot(combat, scene);
    await checkTurn(combat, scene);
}

/** Клетки в пределах радиуса от точки, внутри сцены */
export function cellsAround(scene, x, y, radiusFt = RADIUS_FT) {
    const size = scene.grid.size, reach = Math.floor(radiusFt / (scene.grid.distance || 5));
    const ci = Math.floor(x / size), cj = Math.floor(y / size);
    const cells = [];
    const rect = scene.dimensions?.sceneRect ?? { x: 0, y: 0, width: scene.width, height: scene.height };
    for (let i = ci - reach; i <= ci + reach; i++) {
        for (let j = cj - reach; j <= cj + reach; j++) {
            const px = i * size, py = j * size;
            if (px < rect.x || py < rect.y || px + size > rect.x + rect.width || py + size > rect.y + rect.height) continue;
            cells.push({ i, j });
        }
    }
    return cells;
}

async function clearLights(scene, state) {
    const ids = (state.lights ?? []).filter(id => scene.lights.has(id));
    if (ids.length) await scene.deleteEmbeddedDocuments('AmbientLight', ids);
}

/** Новые пятна раунда */
async function respot(combat, scene, random = Math.random) {
    const state = combat.getFlag(MODULE_ID, FLAG);
    await clearLights(scene, state);
    const cells = cellsAround(scene, state.x, state.y);
    const spots = [];
    while (spots.length < SPOTS && cells.length) spots.push(...cells.splice(Math.floor(random() * cells.length), 1));
    const size = scene.grid.size;
    const lights = await scene.createEmbeddedDocuments('AmbientLight', spots.map((s, n) => ({
        x: s.i * size + size / 2, y: s.j * size + size / 2,
        config: { bright: (scene.grid.distance || 5) / 2, dim: scene.grid.distance || 5, color: COLORS[n % COLORS.length], alpha: 0.85, luminosity: 0.6, animation: { type: 'pulse', speed: 6, intensity: 6 } },
        flags: { [MODULE_ID]: { discoSpot: true } }
    })));
    await combat.update({ [`flags.${MODULE_ID}.${FLAG}`]: { ...state, spots, lights: lights.map(l => l.id), drawn: {} } });
}

/** Клетки токена (at — другое место токена, например конец движения) */
function tokenCells(token, at = token) {
    const size = token.parent.grid.size;
    const i0 = Math.round(at.x / size), j0 = Math.round(at.y / size);
    const cells = [];
    for (let i = 0; i < (token.width || 1); i++) for (let j = 0; j < (token.height || 1); j++) cells.push({ i: i0 + i, j: j0 + j });
    return cells;
}
const onSpot = (state, token, at) => tokenCells(token, at).some(c => state.spots.some(s => s.i === c.i && s.j === c.j));

/** Существо на пятне тянет карту — один раз за свой ход */
async function draw(combat, scene, token, at = token) {
    const state = combat.getFlag(MODULE_ID, FLAG);
    const key = `${combat.round}:${combat.turn}`;
    if (!state || state.drawn?.[token.id] === key || !onSpot(state, token, at)) return;
    await combat.update({ [`flags.${MODULE_ID}.${FLAG}.drawn.${token.id}`]: key });
    const dealt = dealCards([token], null);
    await applyCards(scene, combat, dealt);
    broadcastCards({ sceneId: scene.id, dealt });
    const card = CARDS[dealt[0].card];
    const owner = actorFrom({ actorId: state.actorId, tokenId: null, sceneId: scene.id });
    await lightCard(owner ?? token.actor, t('Диско-шар'), `<p>${t('{v} на пятне — карта «{v2}» ({v3}): {v4}', { v: esc(token.name), v2: esc(card.name), v3: card.buff ? t('баф') : t('дебаф'), v4: esc(card.rules) })}</p>`, { icon: 'fa-compact-disc', cls: 'disco' });
}

async function checkTurn(combat, scene) {
    const token = combat.combatant?.token;
    if (token && (token.actor?.system?.attributes?.hp?.value ?? 1) > 0) await draw(combat, scene, token);
}

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const state = combat.getFlag(MODULE_ID, FLAG);
    if (!state) return;
    const scene = combat.scene ?? canvas.scene;
    if ('round' in changed) {
        if (combat.round >= state.until) {
            await clearLights(scene, state);
            await combat.unsetFlag(MODULE_ID, FLAG);
            return;
        }
        await respot(combat, scene);
    }
    await checkTurn(combat, scene);
});

// Зашёл на пятно в свой ход. v13: перемещение — Movement API, конец пути — в moveToken (документ в этот
// момент ещё в начале пути); v12: updateToken
function entered(token, at) {
    const combat = game.combat;
    if (!isActiveGM() || !combat?.started || combat.combatant?.tokenId !== token.id || !combat.getFlag(MODULE_ID, FLAG)) return;
    draw(combat, token.parent, token, at).catch(error => console.error(`gachadnd | Диско-шар`, error));
}
Hooks.on('moveToken', (token, movement) => {
    if (movement?.pending?.waypoints?.length) return;
    const end = movement?.destination ?? movement?.passed?.waypoints?.at(-1);
    if (end) entered(token, end);
});
Hooks.on('updateToken', (token, changes) => {
    if (typeof token.move === 'function' || !('x' in changes || 'y' in changes)) return;
    entered(token, token);
});

Hooks.on('deleteCombat', async (combat) => {
    const state = combat.getFlag(MODULE_ID, FLAG);
    if (!state || !isActiveGM()) return;
    const scene = combat.scene ?? canvas.scene;
    if (scene) await clearLights(scene, state);
});
