/**
 * Gacha Roguelike dnd5e — Маяк (фиолетовый навык света)
 *
 * Использование ставит шаблон dnd5e — конус 30 футов: его вершина — маяк, направление — луч (колесо
 * мыши поворачивает его при постановке). Мастер зажигает в вершине источник света с тем же углом
 * и направлением. В начале каждого раунда луч поворачивается на 90° по часовой стрелке.
 *
 * В начале хода существа в луче: союзник владельца получает +1d4 к броскам атаки и спасброскам до
 * конца хода; враг совершает спасбросок Телосложения (Сл 8 + бонус мастерства + наибольший
 * модификатор характеристики владельца), провал — Ослеплён до конца своего хода.
 *
 * Маяк стоит 10 раундов (1 минута) или до конца боя. Разбили (удалили шаблон) — свет гаснет.
 * Флаг шаблона lighthouse { actorId, tokenId, lightId, combatId, until }.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { addTurnEffect } from "../turn-effects.js";
import { isLight, ref, actorFrom, centerOf, feetToPx, lightCard, esc } from "./common.js";
import { placedTemplate, sceneTemplates, shapeOf, hasTemplate, turnTemplate, onDeleteTemplate } from "../../../core/templates.js";

const ROUNDS = 10;
const TURN = 90;
const FLAG = 'lighthouse';
const attackBonus = value => ['mwak', 'rwak', 'msak', 'rsak'].map(k => ({ key: `system.bonuses.${k}.attack`, mode: 2, value }));

/** Направление шаблона (0° — восток, по часовой) → поворот источника света (0° — юг) */
export const lightRotation = direction => ((direction - 90) % 360 + 360) % 360;

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item;
    if (!isLight(item, 'lighthouse') || !item.actor) return;
    if (!canvas?.ready) {
        ui.notifications.warn('Маяк ставится на сцену.');
        return false;
    }
});

Hooks.on('dnd5e.postUseActivity', (activity, usage, results) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLight(item, 'lighthouse') || !actor) return;
    const template = placedTemplate(results);
    if (!template) return ui.notifications.warn('Маяк: луч не поставлен — поставьте конус на сцене.');
    requestGM('lightLighthouse', { ...ref(actor), templateId: template.id, templateType: template.documentName, sceneId: template.parent.id });
});

onSocket('lightLighthouse', ({ payload }) => {
    if (!isActiveGM()) return;
    raise(payload).catch(error => console.error('gachadnd | Маяк', error));
});

/** Мастер: свет маяка и флаг шаблона */
export async function raise({ actorId, tokenId, sceneId, templateId, templateType }) {
    const scene = game.scenes.get(sceneId);
    const template = templateType === 'Region' ? scene?.regions.get(templateId) : scene?.templates.get(templateId);
    const shape = shapeOf(template);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!shape || !actor) return;
    const combat = game.combat?.started ? game.combat : null;
    const [light] = await scene.createEmbeddedDocuments('AmbientLight', [{
        x: shape.x, y: shape.y, rotation: lightRotation(shape.direction),
        config: { bright: shape.distance / 2, dim: shape.distance, angle: shape.angle || 53.13, color: '#ffe9a8', alpha: 0.6, animation: { type: 'sunburst', speed: 2, intensity: 3 } },
        flags: { [MODULE_ID]: { lighthouseLight: true } }
    }]);
    await template.update({
        [template.documentName === 'Region' ? 'color' : 'fillColor']: '#ffd75e',
        [`flags.${MODULE_ID}.${FLAG}`]: { actorId: actor.id, tokenId, lightId: light.id, combatId: combat?.id ?? null, until: combat ? combat.round + ROUNDS : null }
    });
    await lightCard(actor, 'Маяк', `<p>Маяк зажжён. Луч поворачивается на 90° в начале каждого раунда${combat ? `, горит до конца раунда ${combat.round + ROUNDS - 1}` : ''}.</p>`, { icon: 'fa-tower-observation' });
}

const lighthouses = scene => sceneTemplates(scene).filter(t => t.flags?.[MODULE_ID]?.[FLAG]);

/** Точка в луче: в пределах дальности и в угле конуса */
export function inBeam(template, point) {
    const shape = shapeOf(template);
    if (!shape) return false;
    const dx = point.x - shape.x, dy = point.y - shape.y;
    const reach = feetToPx(shape.distance, template.parent);
    if (Math.hypot(dx, dy) > reach + 1) return false;
    if (!dx && !dy) return true;
    const angle = Math.toDegrees(Math.atan2(dy, dx));
    const diff = Math.abs((((angle - shape.direction) % 360) + 540) % 360 - 180);
    return diff <= (shape.angle || 53.13) / 2 + 0.5;
}

async function douse(template) {
    const flag = template.flags[MODULE_ID][FLAG];
    const light = template.parent.lights.get(flag.lightId);
    if (light) await light.delete();
    if (hasTemplate(template)) await template.delete();
}

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const scene = combat.scene ?? canvas.scene;
    // Новый раунд: луч поворачивается, срок истекает
    if ('round' in changed) {
        for (const template of lighthouses(scene)) {
            const flag = template.flags[MODULE_ID][FLAG];
            if (flag.combatId !== combat.id) continue;
            if (flag.until && combat.round >= flag.until) { await douse(template); continue; }
            const direction = (shapeOf(template).direction + TURN) % 360;
            await turnTemplate(template, direction);
            await scene.lights.get(flag.lightId)?.update({ rotation: lightRotation(direction) });
        }
    }
    await shine(combat, scene);
});

/** Начало хода: союзник в луче — +1d4, враг — спасбросок Телосложения */
async function shine(combat, scene) {
    const combatant = combat.combatant;
    const token = combatant?.token, actor = combatant?.actor;
    if (!token || !actor || (actor.system?.attributes?.hp?.value ?? 1) <= 0) return;
    const center = centerOf(token);
    for (const template of lighthouses(scene)) {
        const flag = template.flags[MODULE_ID][FLAG];
        if (flag.combatId !== combat.id || !inBeam(template, center)) continue;
        const owner = actorFrom({ actorId: flag.actorId, tokenId: flag.tokenId, sceneId: scene.id });
        const ownerToken = flag.tokenId ? scene.tokens.get(flag.tokenId) : null;
        const ally = ownerToken ? token.disposition === ownerToken.disposition : !!actor.hasPlayerOwner;
        if (ally) {
            await addTurnEffect(actor, combat, {
                name: 'Маяк: свет', img: 'icons/svg/sun.svg',
                description: 'Луч маяка: +1d4 к броскам атаки и спасброскам до конца хода.',
                changes: [...attackBonus('+1d4'), { key: 'system.bonuses.abilities.save', mode: 2, value: '+1d4' }]
            }, { until: 'thisTurn', tokenId: token.id });
            await lightCard(actor, 'Маяк', `<p>${esc(token.name)} в луче маяка: +1d4 к атакам и спасброскам до конца хода.</p>`, { icon: 'fa-tower-observation' });
        } else {
            const dc = dcOf(owner);
            const success = await conSave(actor, dc);
            if (success) continue;
            await addTurnEffect(actor, combat, {
                name: 'Маяк: ослеплён', img: 'icons/svg/blind.svg', statuses: ['blinded'],
                description: 'Луч маяка: ослеплён до конца своего хода.'
            }, { until: 'thisTurn', tokenId: token.id });
            await lightCard(owner ?? actor, 'Маяк', `<p>${esc(token.name)} проваливает спасбросок Телосложения (Сл ${dc}) — ослеплён до конца своего хода.</p>`, { icon: 'fa-tower-observation' });
        }
        return;
    }
}

/** Универсальная Сл: 8 + бонус мастерства + наибольший модификатор характеристики */
export function dcOf(actor) {
    const mods = Object.values(actor?.system?.abilities ?? {}).map(a => Number(a.mod) || 0);
    return 8 + (Number(actor?.system?.attributes?.prof) || 2) + Math.max(0, ...mods);
}

async function conSave(actor, dc) {
    try {
        const rolls = await actor.rollSavingThrow({ ability: 'con', target: dc }, { configure: false }, {});
        const roll = Array.isArray(rolls) ? rolls[0] : rolls;
        if (roll) return roll.isSuccess ?? roll.total >= dc;
    } catch (error) {
        console.warn('gachadnd | Маяк: спасбросок', error);
    }
    return false;
}

// Шаблон удалили (маяк разбили) — свет гаснет
onDeleteTemplate((template) => {
    const flag = template.flags?.[MODULE_ID]?.[FLAG];
    if (!flag || !isActiveGM()) return;
    template.parent?.lights.get(flag.lightId)?.delete();
});

Hooks.on('deleteCombat', async (combat) => {
    if (!isActiveGM()) return;
    for (const scene of game.scenes) {
        for (const template of lighthouses(scene)) if (template.flags[MODULE_ID][FLAG].combatId === combat.id) await douse(template);
    }
});
