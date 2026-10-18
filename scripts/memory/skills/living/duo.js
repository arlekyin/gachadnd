/**
 * Gacha Roguelike dnd5e — Двойные навыки (флаг duo: [тег, тег])
 *
 * Выпадают, только если у кого-то в отряде в Памяти есть навыки обоих тегов (memory/crystals.js).
 *
 * Чумной костёр (огонь + яд, pyre) — облако 10 футов в пределах 60 до конца следующего хода владельца:
 *   начавший ход в нём — 2к6 огнём и 2к6 ядом, спасбросок Телосложения — половина и без отравления.
 *   Пока облако висит, урон огнём владельца по отравленной цели — ещё 1к6 ядом. Флаг боя pyre.
 * Реактивная тяга (движение + взрыв, jet) — за ход отошёл на 15 футов и больше: клетка, откуда ушёл,
 *   взрывается — 2к6 огнём всем рядом с ней, спасбросок Ловкости — половина. Раз за ход, только в бою.
 * Кровавый бастион (кровь + щит, bastion) — реакцией, когда получил урон: союзники в 10 футах получают
 *   временные ПЗ, равные половине урона. Кнопка — владельцу в шёпоте; заряды — бонус мастерства.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { UNIVERSAL_DC_FORMULA } from "../../synergy/synergy-data.js";
import { pickCell } from "../pick.js";
import { isLiving, livingSkill, ref, tokenOf, quiet, dcOf, inCircle, blast, feetToPx, centerOf, around, esc } from "./common.js";

// ==========================================
// ЧУМНОЙ КОСТЁР
// ==========================================

const PYRE = 'pyre';
const PYRE_RADIUS = 10;
const pyreOf = combat => combat?.getFlag(MODULE_ID, PYRE) ?? null;
const inPyre = (scene, state, token) => {
    const c = centerOf(token);
    return Math.hypot(c.x - state.x, c.y - state.y) <= feetToPx(state.radius, scene) + scene.grid.size / 2;
};

const chosen = new Map();
Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLiving(item, 'pyre') || !actor) return;
    quiet(usage);
    if (chosen.has(item.id)) return;
    const combat = game.combat;
    const caster = tokenOf(actor);
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id) || !caster) {
        ui.notifications.warn('Чумной костёр — только в бою, в котором участвует персонаж.');
        return false;
    }
    pickCell({
        caster, range: Number(activity.range?.value) || 60,
        draw: (g, cell, ok, s) => g.lineStyle(2, ok ? 0x9acd32 : 0xff3030, 0.9).beginFill(0x6b8e23, ok ? 0.25 : 0.05).drawCircle(cell[0] * s + s / 2, cell[1] * s + s / 2, feetToPx(PYRE_RADIUS) + s / 2).endFill(),
        hint: 'Чумной костёр: точка облака. Правая кнопка или Esc — отмена.'
    }).then(cell => {
        if (!cell) return;
        chosen.set(item.id, cell);
        return Promise.resolve(activity.use()).finally(() => chosen.delete(item.id));
    }).catch(error => console.error(`${MODULE_ID} | Чумной костёр`, error));
    return false;
});

Hooks.on('dnd5e.postUseActivity', activity => {
    const item = activity?.item;
    const cell = chosen.get(item?.id);
    if (!cell) return;
    chosen.delete(item.id);
    requestGM('livingPyre', { ...ref(item.actor), cell, dc: dcOf(item) });
});

onSocket('livingPyre', ({ payload }) => {
    if (isActiveGM()) kindle(payload).catch(error => console.error(`${MODULE_ID} | Чумной костёр`, error));
});

export async function kindle({ actorId, sceneId, cell, dc }) {
    const combat = game.combat;
    const scene = game.scenes.get(sceneId);
    const actor = game.actors.get(actorId);
    if (!combat || !scene || !actor) return;
    const size = scene.grid.size;
    await combat.setFlag(MODULE_ID, PYRE, { actorId, x: cell[0] * size + size / 2, y: cell[1] * size + size / 2, radius: PYRE_RADIUS, dc, ends: 0 });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-blast-card gd-living-card"><div class="gd-blast-title"><i class="fas fa-biohazard"></i> Чумной костёр</div><p>Облако горящего яда — до конца следующего хода ${esc(actor.name)}. Кто начинает в нём ход, горит и травится.</p></div>`
    });
}

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    let state = pyreOf(combat);
    if (!state) return;
    // Ход владельца закончился: второй конец — облако рассеивается
    const previous = combat.combatants.get(combat.previous?.combatantId);
    if (previous?.actor?.id === state.actorId) {
        state = { ...state, ends: state.ends + 1 };
        if (state.ends >= 2) return combat.unsetFlag(MODULE_ID, PYRE);
        await combat.setFlag(MODULE_ID, PYRE, state);
    }
    const scene = combat.scene ?? canvas.scene;
    const token = combat.combatant?.token;
    if (!token?.actor || !inPyre(scene, state, token) || (token.actor.system?.attributes?.hp?.value ?? 1) <= 0) return;
    await blast({
        actor: game.actors.get(state.actorId) ?? token.actor, title: `Чумной костёр: ${token.name} в облаке`, icon: 'fa-biohazard', victims: [token],
        formula: '2d6', type: 'fire', ability: 'con', dc: state.dc, note: 'И ещё [[/damage 2d6 poison]]. Провал — отравлен до конца хода (модуль наложит сам).',
        onFail: { effect: { name: 'Чумной костёр: отравлен', img: 'icons/svg/poison.svg', statuses: ['poisoned'], description: 'Горящий яд в горле: отравлен до конца хода.' }, until: 'thisTurn' }
    });
});

// Пока облако висит: урон огнём владельца по отравленной цели — ещё 1к6 ядом
Hooks.on('dnd5e.preRollDamageV2', config => {
    const actor = config?.subject?.actor;
    const state = pyreOf(game.combat);
    if (!actor?.isOwner || !state || state.actorId !== actor.id) return;
    const fire = (config.rolls ?? []).some(r => (r.options?.types ?? [r.options?.type]).includes('fire'));
    const target = [...game.user.targets][0]?.actor;
    if (!fire || !target?.statuses?.has('poisoned')) return;
    config.rolls.push({ parts: ['1d6'], data: actor.getRollData(), options: { type: 'poison', types: ['poison'] } });
    ui.notifications.info('Чумной костёр: +1к6 ядом по отравленной цели.');
});

// Облако видят все
let layer = null;
function render() {
    const state = canvas?.ready ? pyreOf(game.combat) : null;
    if (layer && !layer.destroyed) layer.destroy();
    layer = null;
    if (!state || game.combat.scene?.id !== canvas.scene?.id) return;
    layer = new PIXI.Graphics();
    layer.eventMode = 'none';
    const r = feetToPx(state.radius) + canvas.grid.size / 2;
    layer.lineStyle(3, 0x9acd32, 0.8).beginFill(0x6b8e23, 0.2).drawCircle(state.x, state.y, r).endFill();
    layer.lineStyle(2, 0xff7a1a, 0.6).drawCircle(state.x, state.y, r * 0.6);
    (canvas.interface ?? canvas.controls).addChildAt(layer, 0);
}
for (const hook of ['canvasReady', 'updateCombat', 'deleteCombat']) Hooks.on(hook, () => setTimeout(render, 0));

// ==========================================
// РЕАКТИВНАЯ ТЯГА
// ==========================================

const JET_FEET = 15;
const moved = new Map();
const turnKey = combat => `${combat.id}:${combat.round}:${combat.turn}`;

Hooks.on('preUpdateToken', (token, changes, options) => {
    if ('x' in changes || 'y' in changes) options.gachadndFrom = { x: token.x, y: token.y };
});

Hooks.on('updateToken', async (token, changes, options) => {
    if (!isActiveGM() || !options.gachadndFrom || !('x' in changes || 'y' in changes)) return;
    const combat = game.combat;
    const actor = token.actor;
    const skill = actor && livingSkill(actor, 'jet');
    if (!skill || !combat?.started || combat.combatant?.tokenId !== token.id) return;
    const key = turnKey(combat);
    let track = moved.get(token.id);
    if (track?.key !== key) track = { key, from: options.gachadndFrom, feet: 0, fired: false };
    const scene = token.parent;
    const size = scene.grid.size;
    const cells = Math.max(Math.abs(token.x - options.gachadndFrom.x), Math.abs(token.y - options.gachadndFrom.y)) / size;
    track.feet += cells * (scene.grid.distance || 5);
    moved.set(token.id, track);
    if (track.fired || track.feet < JET_FEET) return;
    track.fired = true;
    const w = (token.width || 1) * size, h = (token.height || 1) * size;
    const point = { x: track.from.x + w / 2, y: track.from.y + h / 2 };
    const reach = Math.max(w, h) / 2 + size * 1.1;
    const victims = inCircle(scene, point, reach).filter(t => t.id !== token.id);
    const dc = (await new Roll(UNIVERSAL_DC_FORMULA, actor.getRollData()).evaluate()).total;
    await blast({
        actor, title: 'Реактивная тяга', icon: 'fa-rocket', victims, formula: '2d6', type: 'fire', ability: 'dex', dc,
        note: `${esc(token.name)} срывается с места — клетка позади взрывается.`, at: { sceneId: scene.id, ...point, radius: reach, color: 0xff9a3c }
    });
});

// ==========================================
// КРОВАВЫЙ БАСТИОН
// ==========================================

const usesLeft = item => {
    const max = Number(item?.system?.uses?.max) || 0;
    return max ? max - (Number(item.system.uses.spent) || 0) : 0;
};

Hooks.on('dnd5e.applyDamage', async (actor, amount) => {
    if (!isActiveGM() || !(amount > 0) || !actor?.hasPlayerOwner) return;
    const skill = livingSkill(actor, 'bastion');
    if (!skill || usesLeft(skill) <= 0 || (Number(actor.system?.attributes?.hp?.value) || 0) <= 0) return;
    const temp = Math.floor(amount / 2);
    if (!temp) return;
    const whisper = game.users.filter(u => u.isGM || actor.testUserPermission(u, 'OWNER')).map(u => u.id);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }), whisper,
        content: `<div class="gd-blast-card gd-living-card"><div class="gd-blast-title"><i class="fas fa-shield-heart"></i> Кровавый бастион</div><p>${esc(actor.name)} получает ${amount} урона. Реакцией — союзникам в 10 футах по <strong>${temp}</strong> временных ПЗ (зарядов: ${usesLeft(skill)}).</p><div class="gd-blast-buttons"><button type="button" data-gd-bastion><i class="fas fa-shield-heart"></i> Кровавый бастион</button></div></div>`,
        flags: { [MODULE_ID]: { bastion: { actorId: actor.id, temp } } }
    });
});

onRenderChatMessage((message, html) => {
    const button = html?.querySelector?.('[data-gd-bastion]');
    const data = message.flags?.[MODULE_ID]?.bastion;
    if (!button || !data) return;
    const actor = game.actors.get(data.actorId);
    if (data.used || !actor?.isOwner) { button.disabled = true; return; }
    button.addEventListener('click', () => {
        button.disabled = true;
        requestGM('livingBastion', { messageId: message.id });
    });
});

onSocket('livingBastion', ({ payload }) => {
    if (isActiveGM()) raise(payload).catch(error => console.error(`${MODULE_ID} | Кровавый бастион`, error));
});

export async function raise({ messageId }) {
    const message = game.messages.get(messageId);
    const data = message?.flags?.[MODULE_ID]?.bastion;
    const actor = game.actors.get(data?.actorId);
    const skill = actor && livingSkill(actor, 'bastion');
    if (!data || data.used || !skill || usesLeft(skill) <= 0) return;
    await message.setFlag(MODULE_ID, 'bastion', { ...data, used: true });
    await skill.update({ 'system.uses.spent': (Number(skill.system.uses.spent) || 0) + 1 });
    const token = tokenOf(actor)?.document;
    const allies = token ? around(token, 10).filter(t => t.disposition === token.disposition && t.actor) : [];
    for (const ally of allies) {
        const hp = ally.actor.system.attributes.hp;
        if ((Number(hp.temp) || 0) < data.temp) await ally.actor.update({ 'system.attributes.hp.temp': data.temp });
    }
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-blast-card gd-living-card"><div class="gd-blast-title"><i class="fas fa-shield-heart"></i> Кровавый бастион</div><p>${allies.length ? `Временные ПЗ ${data.temp}: ${esc(allies.map(t => t.name).join(', '))}.` : 'Рядом никого из союзников — кровь пролита зря.'}</p></div>`
    });
}
