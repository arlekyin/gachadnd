/**
 * Gacha Roguelike dnd5e — Тлеющий уголь (фиолетовый навык огня, растёт за забег)
 *
 * Действием — пламя вокруг точки в пределах 60 футов: урон навыка огнём, спасбросок Ловкости — половина.
 * Радиус — 5 футов и ещё 5 за каждые 3 существа, убитых уроном огнём (любым уроном огнём владельца), до 30.
 * Счёт (флаг counter навыка) не сбрасывается до конца забега.
 *
 * Убийство огнём видит Мастер: урон огнём (dnd5e.preCalculateDamage) по существу, которое после него
 * упало до 0 ПЗ; источник — сообщение урона или навык модуля. Персонажи игроков в счёт не идут.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { pickCell } from "../pick.js";
import { isLiving, livingSkill, counterOf, setCounter, ref, tokenOf, quiet, dcOf, damageOf, inCircle, blast, feetToPx, sourceOf } from "./common.js";

const KIND = 'ember';
const BASE = 5, STEP = 5, MAX = 30, PER = 3;

/** Радиус пламени по счёту убийств огнём */
export const emberRadius = item => Math.min(MAX, BASE + STEP * Math.floor(counterOf(item) / PER));

const chosen = new Map();
Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLiving(item, KIND) || !actor) return;
    quiet(usage);
    if (chosen.has(item.id)) return;
    const caster = tokenOf(actor);
    if (!caster) {
        ui.notifications.warn('Тлеющий уголь: токена персонажа нет на сцене.');
        return false;
    }
    const radius = emberRadius(item);
    pickCell({
        caster, range: Number(activity.range?.value) || 60,
        draw: (g, cell, ok, s) => g.lineStyle(2, ok ? 0xff7a1a : 0xff3030, 0.9).beginFill(0xff7a1a, ok ? 0.22 : 0.05).drawCircle(cell[0] * s + s / 2, cell[1] * s + s / 2, feetToPx(radius) + s / 2).endFill(),
        hint: `Тлеющий уголь: точка пламени, радиус ${radius} футов. Правая кнопка или Esc — отмена.`
    }).then(cell => {
        if (!cell) return;
        chosen.set(item.id, cell);
        return Promise.resolve(activity.use()).finally(() => chosen.delete(item.id));
    }).catch(error => console.error(`${MODULE_ID} | Тлеющий уголь`, error));
    return false;
});

Hooks.on('dnd5e.postUseActivity', activity => {
    const item = activity?.item;
    const cell = chosen.get(item?.id);
    if (!cell) return;
    chosen.delete(item.id);
    requestGM('livingEmber', { ...ref(item.actor), cell, radius: emberRadius(item), damage: damageOf(item, { formula: '4d6', type: 'fire' }), dc: dcOf(item) });
});

onSocket('livingEmber', ({ payload }) => {
    if (isActiveGM()) flare(payload).catch(error => console.error(`${MODULE_ID} | Тлеющий уголь`, error));
});

export async function flare({ actorId, sceneId, cell, radius, damage, dc }) {
    const scene = game.scenes.get(sceneId);
    const actor = game.actors.get(actorId);
    if (!scene || !actor) return;
    const size = scene.grid.size;
    const point = { x: cell[0] * size + size / 2, y: cell[1] * size + size / 2 };
    const reach = feetToPx(radius, scene) + size / 2;
    return blast({
        actor, title: 'Тлеющий уголь', icon: 'fa-fire', victims: inCircle(scene, point, reach),
        formula: damage.formula, type: 'fire', ability: 'dex', dc, note: `Радиус пламени — ${radius} футов.`,
        at: { sceneId, ...point, radius: reach, color: 0xff7a1a }
    });
}

// Убийство огнём раздувает уголь
const fiery = new WeakMap();
Hooks.on('dnd5e.preCalculateDamage', (actor, damages, options) => {
    if (damages.some(d => d.type === 'fire' && Number(d.value) > 0)) fiery.set(options, true);
});
Hooks.on('dnd5e.applyDamage', async (actor, amount, options) => {
    if (!fiery.get(options) || !isActiveGM()) return;
    fiery.delete(options);
    if ((Number(actor.system?.attributes?.hp?.value) || 0) > 0 || actor.hasPlayerOwner) return;
    const killer = sourceOf(options);
    const skill = killer ? livingSkill(killer, KIND) ?? killer.items.find(i => isLiving(i, KIND)) : null;
    if (!skill) return;
    const before = emberRadius(skill);
    await setCounter(skill, counterOf(skill) + 1);
    const after = emberRadius(skill);
    if (after > before) ui.notifications.info(`${skill.name}: уголь разгорается — радиус ${after} футов.`);
});
