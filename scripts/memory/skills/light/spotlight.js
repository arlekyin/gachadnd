/**
 * Gacha Roguelike dnd5e — Спотлайт (красный навык света)
 *
 * Использование в бою: сцена плавно темнеет (настоящая темнота Foundry), на звезду бьёт прожектор —
 * свет её токена. Звезда — цель персонажа в пределах дальности (60 футов) или он сам; пока у него
 * экипировано 4 навыка с тегом «свет» и больше, звёзд (лучей) две. Повторное использование, пока
 * Спотлайт горит, переводит луч на текущие цели — без заряда.
 *
 * Звезда: враги персонажа атакуют только её или существо вплотную к себе — иначе бросок атаки
 * отменяется. Массовка — сторона персонажа без звёзд: её атаки с преимуществом. Кнопка
 * «Подыграть» на карточке: существо массовки в свой ход отдаёт действие — звезда сразу совершает
 * одно действие сверх своих (Мастер разыгрывает его).
 *
 * Горит до конца следующего раунда. Флаг боя spotlight { actorId, tokenId, stars, until, scene,
 * lights, assisted }: scene — темнота и глобальный свет до Спотлайта, lights — [{ id, light }] свет
 * токенов звёзд до Спотлайта, assisted — кто уже подыграл в этот ход.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { isMemorySkill } from "../../synergy/synergy.js";
import { feetBetween } from "./flash.js";
import { isLight, ref, actorFrom, tokenOf, esc } from "./common.js";
import { t } from "../../../core/i18n.js";

const FLAG = 'spotlight';
const DEFAULT_RANGE = 60;
const TWO_BEAMS = 4;
const STAR_LIGHT = { bright: 7.5, dim: 15, color: '#fff3c4', alpha: 0.55, luminosity: 0.7, angle: 360, animation: { type: 'sunburst', speed: 2, intensity: 2 } };
const DARK = 1;

const stateOf = combat => combat?.started ? combat.getFlag(MODULE_ID, FLAG) ?? null : null;

/** Сколько лучей: 2 при 4+ экипированных навыках с тегом «свет» */
export function beamsOf(actor) {
    const light = (actor?.items ?? []).filter(i => isMemorySkill(i) && i.flags[MODULE_ID].is_active && (i.flags[MODULE_ID].tags ?? []).includes('свет')).length;
    return light >= TWO_BEAMS ? 2 : 1;
}

/** Звёзды: цели пользователя в пределах дальности (не больше лучей), иначе сам персонаж */
function pickStars(actor, range) {
    const caster = tokenOf(actor);
    const targets = [...(game.user.targets ?? [])].map(t => t.document).filter(t => t.parent?.id === caster.document.parent.id);
    const far = targets.filter(t => t.id !== caster.document.id && feetBetween(caster.document, t) > range);
    if (far.length) {
        ui.notifications.warn(t('Спотлайт: {v} дальше {range} футов.', { v: far.map(t => t.name).join(', '), range }));
        return null;
    }
    const stars = targets.slice(0, beamsOf(actor)).map(t => t.id);
    return stars.length ? stars : [caster.document.id];
}

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLight(item, 'spotlight') || !actor) return;
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id)) {
        ui.notifications.warn(t('Спотлайт — только в бою, в котором участвует персонаж.'));
        return false;
    }
    if (!tokenOf(actor)) {
        ui.notifications.warn(t('Спотлайт: токена персонажа нет на сцене.'));
        return false;
    }
    const state = stateOf(combat);
    if (state?.actorId === actor.id) {
        // Спотлайт горит — луч на новые цели, без заряда
        const stars = pickStars(actor, Number(activity.range?.value) || DEFAULT_RANGE);
        if (stars) requestGM('lightSpotlightMove', { ...ref(actor), stars });
        return false;
    }
    if (state) {
        ui.notifications.warn(t('Спотлайт уже горит.'));
        return false;
    }
    activity._gdSpotlightStars = pickStars(actor, Number(activity.range?.value) || DEFAULT_RANGE);
    if (!activity._gdSpotlightStars) return false;
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isLight(item, 'spotlight') || !item.actor || !activity._gdSpotlightStars) return;
    requestGM('lightSpotlight', { ...ref(item.actor), stars: activity._gdSpotlightStars });
    delete activity._gdSpotlightStars;
});

onSocket('lightSpotlight', ({ payload }) => { if (isActiveGM()) start(payload).catch(error => console.error(`gachadnd | Спотлайт`, error)); });
onSocket('lightSpotlightMove', ({ payload }) => { if (isActiveGM()) move(payload).catch(error => console.error(`gachadnd | Спотлайт`, error)); });
onSocket('lightSpotlightAssist', ({ payload }) => { if (isActiveGM()) assist(payload).catch(error => console.error(`gachadnd | Спотлайт`, error)); });

/** Свет звёзд: свет токенов до Спотлайта запоминается. @returns {{id, light}[]} */
async function light(scene, state, stars) {
    let lights = [...(state.lights ?? [])];
    const updates = [];
    for (const saved of lights.filter(l => !stars.includes(l.id))) updates.push({ _id: saved.id, light: saved.light });
    lights = lights.filter(l => stars.includes(l.id));
    for (const id of stars) {
        const token = scene.tokens.get(id);
        if (!token || lights.some(l => l.id === id)) continue;
        lights.push({ id, light: token.light.toObject() });
        updates.push({ _id: id, light: STAR_LIGHT });
    }
    if (updates.length) await scene.updateEmbeddedDocuments('Token', updates);
    return lights;
}

const names = (scene, ids) => ids.map(id => esc(scene.tokens.get(id)?.name ?? '?')).join(t(' и '));

/** Мастер: темнота, прожектор, карточка с кнопкой «Подыграть» */
export async function start({ actorId, tokenId, sceneId, stars }) {
    const combat = game.combat;
    const scene = game.scenes.get(sceneId);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!combat || !scene || !actor) return;
    const env = scene.environment;
    const saved = { darknessLevel: env.darknessLevel, globalMax: env.globalLight.darkness.max };
    const state = { actorId: actor.id, tokenId, sceneId, stars: [], until: combat.round + 1, scene: saved, lights: [], assisted: {} };
    state.lights = await light(scene, state, stars);
    state.stars = stars;
    await combat.setFlag(MODULE_ID, FLAG, state);
    // Глобальный свет гаснет при темноте выше его порога — ночь как в настоящей сцене
    await scene.update({ 'environment.darknessLevel': DARK, 'environment.globalLight.darkness.max': Math.min(saved.globalMax, 0.5) }, { animateDarkness: 1500 });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-light-card spotlight"><div class="gd-light-title"><i class="fas fa-star"></i> ${t('Спотлайт — Бенефис')}</div>
            <p>${t('Свет погас. Звезда:')} <strong>${names(scene, stars)}</strong>${t('. Враги видят только звезду: атакуют её или того, кто вплотную. Атаки массовки из темноты — с преимуществом. Горит до конца раунда {v}.', { v: combat.round + 1 })}</p>
            <div class="gd-light-buttons"><button type="button" data-spotlight-assist><i class="fas fa-hands-clapping"></i> ${t('Подыграть')}</button></div></div>`,
        flags: { [MODULE_ID]: { spotlight: { combatId: combat.id } } }
    });
}

/** Мастер: луч на новые цели */
export async function move({ actorId, tokenId, sceneId, stars }) {
    const combat = game.combat;
    const state = stateOf(combat);
    const scene = game.scenes.get(sceneId);
    if (!state || state.actorId !== actorId || !scene) return;
    const lights = await light(scene, state, stars);
    await combat.update({ [`flags.${MODULE_ID}.${FLAG}.stars`]: stars, [`flags.${MODULE_ID}.${FLAG}.lights`]: lights });
    const actor = actorFrom({ actorId, tokenId, sceneId });
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="gd-light-card spotlight"><div class="gd-light-title"><i class="fas fa-star"></i> ${t('Спотлайт')}</div><p>${t('Луч скользит — теперь звезда:')} <strong>${names(scene, stars)}</strong>.</p></div>` });
}

/** Мастер: погасить — темнота и свет токенов как были */
export async function stop(combat) {
    const state = combat.getFlag(MODULE_ID, FLAG);
    if (!state) return;
    const scene = game.scenes.get(state.sceneId);
    if (scene) {
        const updates = (state.lights ?? []).filter(l => scene.tokens.has(l.id)).map(l => ({ _id: l.id, light: l.light }));
        if (updates.length) await scene.updateEmbeddedDocuments('Token', updates);
        await scene.update({ 'environment.darknessLevel': state.scene.darknessLevel, 'environment.globalLight.darkness.max': state.scene.globalMax }, { animateDarkness: 1500 });
    }
    if (game.combats.has(combat.id)) await combat.unsetFlag(MODULE_ID, FLAG);
}

/** Мастер: существо массовки подыгрывает в свой ход */
export async function assist({ combatantId }) {
    const combat = game.combat;
    const state = stateOf(combat);
    const scene = game.scenes.get(state?.sceneId);
    const combatant = combat?.combatants.get(combatantId);
    if (!state || !scene || !combatant || combat.combatant?.id !== combatantId) return;
    if (!sameSide(scene, state, combatant.token) || state.stars.includes(combatant.tokenId)) return ui.notifications.warn(t('Подыграть может только массовка — сторона Спотлайта вне луча.'));
    const key = `${combat.round}:${combat.turn}`;
    if (state.assisted?.[combatantId] === key) return ui.notifications.warn(t('{name} уже подыграл в этот ход.', { name: combatant.name }));
    await combat.update({ [`flags.${MODULE_ID}.${FLAG}.assisted.${combatantId}`]: key });
    for (const id of state.stars) {
        const star = canvas.tokens?.get(id);
        if (star) canvas.interface?.createScrollingText?.(star.center, t('★ +1 действие'), { anchor: CONST.TEXT_ANCHOR_POINTS?.TOP ?? 2, fontSize: 30, fill: '#ffe27a', stroke: '#000000', strokeThickness: 5, duration: 2400 });
    }
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token: combatant.token }),
        content: `<div class="gd-light-card spotlight"><div class="gd-light-title"><i class="fas fa-hands-clapping"></i> ${t('Подыграл')}</div><p>${t('{v} отдаёт своё действие —', { v: esc(combatant.name) })} <strong>${names(scene, state.stars)}</strong> ${t('сразу совершает одно действие сверх своих.')}</p></div>`
    });
}

/** Сторона Спотлайта: то же отношение, что у токена персонажа */
function sameSide(scene, state, token) {
    const caster = scene.tokens.get(state.tokenId);
    return !!caster && !!token && token.disposition === caster.disposition;
}
const hostileTo = (scene, state, token) => {
    const caster = scene.tokens.get(state.tokenId);
    return !!caster && !!token && !!token.disposition && token.disposition === -caster.disposition;
};

// Атаки в темноте
Hooks.on('dnd5e.preRollAttackV2', (config) => {
    const state = stateOf(game.combat);
    if (!state) return;
    const scene = game.scenes.get(state.sceneId);
    const actor = config?.subject?.actor ?? config?.subject?.item?.actor;
    const attacker = actor ? (actor.token ?? tokenOf(actor)?.document) : null;
    if (!scene || !attacker || attacker.parent?.id !== scene.id) return;
    // Враг: только звезда или существо вплотную
    if (hostileTo(scene, state, attacker)) {
        const blocked = [...(game.user.targets ?? [])].map(t => t.document)
            .filter(t => !state.stars.includes(t.id) && feetBetween(attacker, t) > 0);
        if (blocked.length) {
            ui.notifications.warn(t('Спотлайт: {name} в темноте видит только звезду — {v} не видно.', { name: attacker.name, v: blocked.map(t => t.name).join(', ') }));
            return false;
        }
        return;
    }
    // Массовка: атаки из темноты с преимуществом
    if (sameSide(scene, state, attacker) && !state.stars.includes(attacker.id)) {
        for (const roll of config.rolls ?? []) (roll.options ??= {}).advantage = true;
        config.advantage = true;
    }
});

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('round' in changed) || !isActiveGM()) return;
    const state = combat.getFlag(MODULE_ID, FLAG);
    if (state && combat.round > state.until) await stop(combat);
});
Hooks.on('deleteCombat', async (combat) => {
    if (isActiveGM() && combat.getFlag(MODULE_ID, FLAG)) await stop(combat);
});

// Кнопка «Подыграть»: у владельца того, чей сейчас ход
onRenderChatMessage((message, html) => {
    const flag = message.flags?.[MODULE_ID]?.spotlight;
    const button = html?.querySelector?.('[data-spotlight-assist]');
    if (!flag || !button) return;
    const combat = game.combats.get(flag.combatId);
    if (!stateOf(combat)) { button.disabled = true; return; }
    button.addEventListener('click', () => {
        const current = combat.combatant;
        if (!current?.actor?.isOwner) return ui.notifications.warn(t('Подыграть можно в свой ход.'));
        requestGM('lightSpotlightAssist', { combatantId: current.id });
    });
});
