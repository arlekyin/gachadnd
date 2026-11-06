/**
 * Gacha Roguelike dnd5e — Вспышка камеры (красный навык света)
 *
 * Использование в бою — снимок: места всех существ в пределах 30 футов (по клеткам, от края до края)
 * и ПЗ персонажа. Пока снимок есть, повторное использование навыка (без заряда) — проявка: живые
 * существа из кадра возвращаются на места со снимка (занятое место — ближайшая свободная клетка),
 * ПЗ персонажа — как на снимке. Проявить можно один раз; конец боя стирает снимок.
 *
 * Флаг персонажа cameraFlash { combatId, sceneId, hp, temp, tokens: [{ id, x, y, name }] }; снимок и
 * проявку делает Мастер. У всех — белая вспышка.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { cellOf, occupied, nearestFree } from "../grid.js";
import { placeToken } from "../pick.js";
import { isLight, ref, actorFrom, tokenOf, lightCard, esc } from "./common.js";
import { fxCalm } from "../../../core/prefs.js";
import { t } from "../../../core/i18n.js";

const FRAME_FT = 30;
const FLAG = 'cameraFlash';

const snapshotOf = actor => {
    const shot = actor?.getFlag?.(MODULE_ID, FLAG);
    return shot && shot.combatId === game.combat?.id ? shot : null;
};

/** Расстояние между токенами-документами в футах: по клеткам, от края до края */
export function feetBetween(a, b) {
    const size = a.parent.grid.size, distance = a.parent.grid.distance || 5;
    const box = d => ({ x0: d.x, y0: d.y, x1: d.x + (d.width || 1) * size, y1: d.y + (d.height || 1) * size });
    const p = box(a), q = box(b);
    const dx = Math.max(0, q.x0 - p.x1, p.x0 - q.x1) / size, dy = Math.max(0, q.y0 - p.y1, p.y0 - q.y1) / size;
    return Math.max(Math.round(dx), Math.round(dy)) * distance;
}

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLight(item, 'flash') || !actor) return;
    if (snapshotOf(actor)) {
        requestGM('lightFlashDevelop', ref(actor));
        return false;
    }
    const combat = game.combat;
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id)) {
        ui.notifications.warn(t('Вспышка камеры: снимок делается в бою — он хранится до его конца.'));
        return false;
    }
    if (!tokenOf(actor)) {
        ui.notifications.warn(t('Вспышка камеры: токена персонажа нет на сцене.'));
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    if (!isLight(item, 'flash') || !item.actor) return;
    requestGM('lightFlashShot', ref(item.actor));
});

onSocket('lightFlashShot', ({ payload }) => {
    if (isActiveGM()) shoot(payload).catch(error => console.error(`gachadnd | Вспышка камеры`, error));
});
onSocket('lightFlashDevelop', ({ payload }) => {
    if (isActiveGM()) develop(payload).catch(error => console.error(`gachadnd | Вспышка камеры`, error));
});

/** Мастер: снимок */
export async function shoot({ actorId, tokenId, sceneId }) {
    const scene = game.scenes.get(sceneId);
    const caster = scene?.tokens.get(tokenId);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!caster || !actor) return;
    const framed = scene.tokens.filter(t => t.actor && !t.hidden && (t.id === caster.id || feetBetween(caster, t) <= FRAME_FT));
    const hp = actor.system.attributes.hp;
    await actor.setFlag(MODULE_ID, FLAG, {
        combatId: game.combat?.id ?? null, sceneId, hp: hp.value, temp: hp.temp ?? 0,
        tokens: framed.map(t => ({ id: t.id, x: t.x, y: t.y, name: t.name }))
    });
    flashAll(sceneId);
    await lightCard(actor, t('Вспышка камеры'), `<p>${t('Щёлк! В кадре: {v}. ПЗ на снимке: {value}. Повторное использование навыка проявит снимок.', { v: framed.map(t => esc(t.name)).join(', '), value: hp.value })}</p>`, { icon: 'fa-camera' });
}

/** Мастер: проявка */
export async function develop({ actorId, tokenId, sceneId }) {
    const actor = actorFrom({ actorId, tokenId, sceneId });
    const shot = snapshotOf(actor);
    if (!actor || !shot) return;
    const scene = game.scenes.get(shot.sceneId);
    const size = scene.grid.size;
    const alive = shot.tokens.map(s => ({ s, token: scene.tokens.get(s.id) }))
        .filter(({ token }) => token?.actor && (token.actor.system?.attributes?.hp?.value ?? 1) > 0);
    // Занятые клетки: все, кроме тех, кто сейчас вернётся на снимок
    const taken = occupied(scene, size, { except: alive.map(({ token }) => token.id) });
    const moved = [];
    for (const { s, token } of alive) {
        const [gx, gy] = cellOf(s, size);
        const cell = nearestFree(scene, size, token, gx, gy, taken);
        if (!cell) continue;
        for (let dx = 0; dx < (token.width || 1); dx++) for (let dy = 0; dy < (token.height || 1); dy++) taken.add(`${cell[0] + dx},${cell[1] + dy}`);
        const x = cell[0] * size, y = cell[1] * size;
        if (x !== token.x || y !== token.y) {
            await placeToken(token, x, y);
            moved.push(token.name);
        }
    }
    const before = actor.system.attributes.hp.value;
    await actor.update({ 'system.attributes.hp.value': shot.hp, 'system.attributes.hp.temp': shot.temp });
    await actor.unsetFlag(MODULE_ID, FLAG);
    flashAll(scene.id);
    await lightCard(actor, t('Вспышка камеры — проявка'), `<p>${t('{v} ПЗ {v2}: {before} → {hp}.', { v: moved.length ? t('Вернулись на места со снимка: {v}.', { v: moved.map(esc).join(', ') }) : t('Все и так на своих местах.'), v2: esc(actor.name), before, hp: shot.hp })}</p>`, { icon: 'fa-camera-retro' });
}

/** Белая вспышка у всех на этой сцене */
function flashAll(sceneId) {
    emit('lightFlash', { sceneId });
    flash({ sceneId });
}
onSocket('lightFlash', data => flash(data));

export function flash({ sceneId }) {
    if (canvas?.scene?.id !== sceneId) return;
    const el = document.createElement('div');
    el.className = 'gd-light-flash';
    document.body.append(el);
    el.animate([{ opacity: 0 }, { opacity: fxCalm() ? 0.45 : 0.95, offset: 0.12 }, { opacity: 0 }], { duration: 700, easing: 'ease-out' }).finished
        .catch(() => {}).finally(() => el.remove());
}

// Конец боя стирает снимки
Hooks.on('deleteCombat', async (combat) => {
    if (!isActiveGM()) return;
    for (const c of combat.combatants) {
        if (c.actor?.getFlag(MODULE_ID, FLAG)?.combatId === combat.id) await c.actor.unsetFlag(MODULE_ID, FLAG);
    }
});
