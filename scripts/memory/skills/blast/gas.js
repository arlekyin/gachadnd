/**
 * Gacha Roguelike dnd5e — Утечка газа (фиолетовый навык взрыва)
 *
 * Использование в бою — клетка в пределах дальности: там открывается вентиль. Облако газа
 * радиусом 10 футов в начале каждого раунда растёт на 5 футов, до 30. Его видят только владелец и
 * Мастер. Существо, начинающее ход в газе, совершает спасбросок Телосложения; провал — Отравлен до
 * конца хода.
 *
 * Поджигает газ урон огнём по существу в облаке, горящая клетка «Это нормально» в облаке или
 * кнопка Мастера «Поджечь». Взрыв: каждое существо в облаке совершает спасбросок Ловкости, урон —
 * 1d6 огнём за каждые 5 футов радиуса (успех — половина). Облако выгорает.
 *
 * Флаг боя gas { actorId, x, y, radius, dc }.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { addTurnEffect } from "../turn-effects.js";
import { pickCell } from "../pick.js";
import { isBlast, ref, actorFrom, tokenOf, esc, quiet, dcOf, centerOf, feetToPx, inCircle, blast } from "./common.js";
import { saveCard } from "./common.js";

const FLAG = 'gas';
const START = 10, GROW = 5, MAX = 30;

const stateOf = combat => combat?.getFlag(MODULE_ID, FLAG) ?? null;
const inside = (scene, state, token) => {
    const c = centerOf(token);
    return Math.hypot(c.x - state.x, c.y - state.y) <= feetToPx(state.radius, scene);
};

const chosen = new Map();
Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isBlast(item, 'gas') || !actor) return;
    quiet(usage, message);
    if (chosen.has(item.id)) return;
    const combat = game.combat;
    const caster = tokenOf(actor);
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id) || !caster) {
        ui.notifications.warn('Утечка газа — только в бою, в котором участвует персонаж.');
        return false;
    }
    if (stateOf(combat)) {
        ui.notifications.warn('Газ уже идёт.');
        return false;
    }
    pickCell({
        caster, range: Number(activity.range?.value) || 60,
        draw: (g, cell, ok, s) => g.lineStyle(2, ok ? 0x8bd450 : 0xff3030, 0.9).beginFill(0x8bd450, ok ? 0.25 : 0.05).drawCircle(cell[0] * s + s / 2, cell[1] * s + s / 2, feetToPx(START)).endFill(),
        hint: 'Утечка газа: выберите клетку вентиля. Правая кнопка или Esc — отмена.'
    }).then(cell => {
        if (!cell) return;
        chosen.set(item.id, cell);
        return Promise.resolve(activity.use()).finally(() => chosen.delete(item.id));
    }).catch(error => console.error(`${MODULE_ID} | Газ`, error));
    return false;
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    const cell = chosen.get(item?.id);
    if (!cell) return;
    chosen.delete(item.id);
    requestGM('blastGas', { ...ref(item.actor), cell, dc: dcOf(item) });
});

onSocket('blastGas', ({ payload }) => { if (isActiveGM()) open(payload).catch(error => console.error(`${MODULE_ID} | Газ`, error)); });
onSocket('blastGasIgnite', () => { if (isActiveGM()) ignite(game.combat, 'Мастер поджёг газ').catch(error => console.error(`${MODULE_ID} | Газ`, error)); });

export async function open({ actorId, tokenId, sceneId, cell, dc }) {
    const combat = game.combat;
    const scene = game.scenes.get(sceneId);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!combat || !scene || !actor) return;
    const size = scene.grid.size;
    await combat.setFlag(MODULE_ID, FLAG, { actorId: actor.id, x: cell[0] * size + size / 2, y: cell[1] * size + size / 2, radius: START, dc });
    const whisper = game.users.filter(u => u.isGM || actor.testUserPermission(u, 'OWNER')).map(u => u.id);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }), whisper,
        content: `<div class="gd-blast-card gas"><div class="gd-blast-title"><i class="fas fa-smog"></i> Утечка газа</div><p>Вентиль открыт. Облако растёт каждый раунд, до 30 футов. Любой огонь в нём — взрыв.</p><div class="gd-blast-buttons"><button type="button" data-gas-ignite><i class="fas fa-fire"></i> Поджечь (Мастер)</button></div></div>`,
        flags: { [MODULE_ID]: { gas: true } }
    });
}

/** Мастер: газ взрывается */
export async function ignite(combat, reason) {
    const state = stateOf(combat);
    if (!state) return;
    const scene = combat.scene ?? canvas.scene;
    await combat.unsetFlag(MODULE_ID, FLAG);
    const owner = game.actors.get(state.actorId);
    const dice = Math.floor(state.radius / 5);
    await blast({
        actor: owner, title: 'Газ взрывается', icon: 'fa-fire', victims: inCircle(scene, state, feetToPx(state.radius, scene)),
        formula: `${dice}d6`, type: 'fire', ability: 'dex', dc: state.dc, note: `${esc(reason)}. Радиус облака ${state.radius} футов — ${dice}d6.`,
        at: { sceneId: scene.id, x: state.x, y: state.y, radius: feetToPx(state.radius, scene) }
    });
}

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    let state = stateOf(combat);
    if (!state) return;
    const scene = combat.scene ?? canvas.scene;
    if ('round' in changed && state.radius < MAX) {
        state = { ...state, radius: Math.min(MAX, state.radius + GROW) };
        await combat.update({ [`flags.${MODULE_ID}.${FLAG}.radius`]: state.radius });
    }
    // Горящая клетка пожара в облаке
    const fire = combat.getFlag(MODULE_ID, 'fire');
    if (fire?.cells?.some(([x, y]) => Math.hypot(x * scene.grid.size + scene.grid.size / 2 - state.x, y * scene.grid.size + scene.grid.size / 2 - state.y) <= feetToPx(state.radius, scene))) {
        return ignite(combat, 'Газ дошёл до пожара');
    }
    // Начало хода в газе: Телосложение или отравление
    const token = combat.combatant?.token;
    const actor = token?.actor;
    if (!actor || !inside(scene, state, token) || (actor.system?.attributes?.hp?.value ?? 1) <= 0) return;
    await saveCard({
        actor: game.actors.get(state.actorId) ?? actor, title: `Утечка газа: ${token.name} в облаке`, icon: 'fa-smog', tokens: [token],
        ability: 'con', dc: state.dc, note: 'Провал — отравлен до конца хода (модуль наложит сам).',
        onFail: { effect: { name: 'Газ: отравлен', img: 'icons/svg/poison.svg', statuses: ['poisoned'], description: 'Наглотался газа: отравлен до конца хода.' }, until: 'thisTurn' }
    });
});

// Урон огнём по существу в облаке — поджигает газ (не предпросмотр: только применённый урон)
const fiery = new WeakMap();
Hooks.on('dnd5e.preCalculateDamage', (actor, damages, options) => {
    if (damages.some(d => d.type === 'fire' && Number(d.value) > 0)) fiery.set(options, true);
});
Hooks.on('dnd5e.applyDamage', (actor, amount, options) => {
    if (!fiery.get(options) || !isActiveGM()) return;
    fiery.delete(options);
    const combat = game.combat;
    const state = stateOf(combat);
    const token = actor.token ?? tokenOf(actor)?.document;
    if (state && token && inside(combat.scene ?? canvas.scene, state, token)) ignite(combat, `Огонь по ${actor.name}`).catch(error => console.error(`${MODULE_ID} | Газ`, error));
});

onRenderChatMessage((message, html) => {
    const button = html?.querySelector?.('[data-gas-ignite]');
    if (!button) return;
    if (!game.user.isGM || !stateOf(game.combat)) { button.disabled = true; return; }
    button.addEventListener('click', () => requestGM('blastGasIgnite', {}));
});

// Облако — только владельцу и Мастеру
let layer = null;
function render() {
    const state = canvas?.ready ? stateOf(game.combat) : null;
    const owner = state ? game.actors.get(state.actorId) : null;
    if (layer && !layer.destroyed) layer.destroy();
    layer = null;
    if (!state || game.combat.scene?.id !== canvas.scene?.id || !(game.user.isGM || owner?.isOwner)) return;
    layer = new PIXI.Graphics();
    layer.eventMode = 'none';
    const r = feetToPx(state.radius);
    layer.lineStyle(3, 0x8bd450, 0.7).beginFill(0x8bd450, 0.16).drawCircle(state.x, state.y, r).endFill();
    (canvas.interface ?? canvas.controls).addChildAt(layer, 0);
}
for (const hook of ['canvasReady', 'updateCombat', 'deleteCombat']) Hooks.on(hook, () => setTimeout(render, 0));
