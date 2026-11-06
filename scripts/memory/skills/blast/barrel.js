/**
 * Gacha Roguelike dnd5e — Красная бочка (синий навык взрыва)
 *
 * Использование: две свободные клетки в пределах дальности — в них встают бочки (токены
 * персонажа «Красная бочка», 1 ПЗ, КД 10, без отношения). Любой урон по бочке — взрыв: каждое
 * существо в радиусе навыка (10 футов) совершает спасбросок Ловкости, урон навыка огнём (успех —
 * половина). Бочка в радиусе тоже получает урон — и взрывается следом. Бочки стоят до конца боя.
 *
 * Флаг токена barrel { ownerId, formula, dc, radius, combatId }; персонаж бочки — флаг barrelActor.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { pickCell } from "../pick.js";
import { occupied, key } from "../grid.js";
import { isBlast, ref, actorFrom, tokenOf, quiet, damageOf, dcOf, areaOf, around, blast, boomAt } from "./common.js";
import { t } from "../../../core/i18n.js";

const IMG = 'icons/containers/barrels/barrel-drum-steel-oil.webp';
const FLAG = 'barrel';

const chosen = new Map();
Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isBlast(item, 'barrel') || !actor) return;
    quiet(usage, message);
    if (chosen.has(item.id)) return;
    const caster = tokenOf(actor);
    if (!canvas?.ready || !caster) {
        ui.notifications.warn(t('Красная бочка: токена персонажа нет на сцене.'));
        return false;
    }
    const range = Number(activity.range?.value) || 30;
    const size = canvas.grid.size;
    const draw = (g, cell, ok, s) => g.lineStyle(3, ok ? 0xd8282a : 0x666666, 0.9).beginFill(0xd8282a, ok ? 0.35 : 0.1).drawCircle(cell[0] * s + s / 2, cell[1] * s + s / 2, s * 0.38).endFill();
    (async () => {
        const taken = occupied(canvas.scene, size);
        const cells = [];
        for (const n of [1, 2]) {
            const cell = await pickCell({ caster, range, allowed: c => !taken.has(key(...c)), draw, hint: t('Красная бочка {n} из 2: выберите свободную клетку.', { n }) });
            if (!cell) return;
            taken.add(key(...cell));
            cells.push(cell);
        }
        chosen.set(item.id, cells);
        await Promise.resolve(activity.use()).finally(() => chosen.delete(item.id));
    })().catch(error => console.error(`${MODULE_ID} | Бочка`, error));
    return false;
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    const cells = chosen.get(item?.id);
    if (!cells) return;
    chosen.delete(item.id);
    requestGM('blastBarrel', { ...ref(item.actor), cells, formula: damageOf(item, { formula: '3d6' }).formula, dc: dcOf(item), radius: areaOf(item, 10) });
});

onSocket('blastBarrel', ({ payload }) => { if (isActiveGM()) place(payload).catch(error => console.error(`${MODULE_ID} | Бочка`, error)); });

/** Персонаж «Красная бочка» мира — создаётся при первой бочке */
async function barrelActor() {
    const found = game.actors.find(a => a.flags?.[MODULE_ID]?.barrelActor);
    if (found) return found;
    return Actor.create({
        name: t('Красная бочка'), type: 'npc', img: IMG,
        system: { attributes: { hp: { value: 1, max: 1 }, ac: { calc: 'flat', flat: 10 } }, details: { cr: 0 } },
        prototypeToken: { actorLink: false, disposition: 0, texture: { src: IMG, tint: '#ff4a3d' }, displayName: 0, displayBars: 0 },
        flags: { [MODULE_ID]: { barrelActor: true } }
    });
}

export async function place({ actorId, tokenId, sceneId, cells, formula, dc, radius }) {
    const scene = game.scenes.get(sceneId);
    const owner = actorFrom({ actorId, tokenId, sceneId });
    if (!scene || !owner) return;
    const actor = await barrelActor();
    const size = scene.grid.size;
    const combatId = game.combat?.started ? game.combat.id : null;
    await scene.createEmbeddedDocuments('Token', cells.map(([x, y]) => ({
        ...actor.prototypeToken.toObject(), actorId: actor.id, name: t('Красная бочка'), x: x * size, y: y * size,
        flags: { [MODULE_ID]: { [FLAG]: { ownerId: owner.id, formula, dc, radius, combatId } } }
    })));
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: owner }), content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-oil-can"></i> ${t('Красная бочка')}</div><p>${t('На поле две бочки. Одно попадание — и бум.')}</p></div>` });
}

const exploding = new Set();
/** Мастер: бочка взрывается */
export async function explode(token) {
    const flag = token?.flags?.[MODULE_ID]?.[FLAG];
    if (!flag || exploding.has(token.id)) return;
    exploding.add(token.id);
    // Горящие бочки не задеваются; бочка удаляется после взрыва — после пометок dnd5e о 0 ПЗ
    const victims = around(token, flag.radius).filter(t => !exploding.has(t.id));
    const at = boomAt(token, flag.radius);
    const owner = game.actors.get(flag.ownerId);
    await blast({ actor: owner, title: t('Красная бочка взрывается'), icon: 'fa-oil-can', victims, formula: flag.formula, type: 'fire', ability: 'dex', dc: flag.dc, at });
    await new Promise(r => setTimeout(r, 300));
    if (token.parent?.tokens.has(token.id)) await token.delete();
    exploding.delete(token.id);
}

// Любой урон по бочке — взрыв (урон применяет Мастер: игроки бочкой не владеют)
Hooks.on('dnd5e.applyDamage', (actor, amount) => {
    const token = actor?.token;
    if (!(amount > 0) || !token?.flags?.[MODULE_ID]?.[FLAG] || !isActiveGM()) return;
    explode(token).catch(error => console.error(`${MODULE_ID} | Бочка`, error));
});

Hooks.on('deleteCombat', async (combat) => {
    if (!isActiveGM()) return;
    for (const scene of game.scenes) {
        const ids = scene.tokens.filter(t => t.flags?.[MODULE_ID]?.[FLAG]?.combatId === combat.id).map(t => t.id);
        if (ids.length) await scene.deleteEmbeddedDocuments('Token', ids);
    }
});
