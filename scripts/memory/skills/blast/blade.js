/**
 * Gacha Roguelike dnd5e — Раскалённый клинок (зелёный навык огня)
 *
 * Пока навык экипирован, каждое попадание оружием нагревает клинок на 1 (флаг навыка bladeHeat,
 * 0–4). Атаки оружием наносят дополнительный урон огнём, равный нагреву (отдельная строка в
 * карточке урона). Нагрев 4 — клинок плавится: владелец получает 2d6 урона огнём, нагрев — 0.
 * Попадание — критическое или итог не ниже КД единственной цели; без цели нагрев не растёт.
 *
 * Использование — стравить жар: dnd5e ставит конус, задетые совершают спасбросок Ловкости, урон —
 * нагрев d6 огнём (успех — половина); нагрев — 0. Холодный клинок стравить нечего.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { emit, onSocket } from "../../../core/socket.js";
import { inBeam } from "../light/lighthouse.js";
import { isBlast, blastSkill, tokenOf, quiet, dcOf, blast } from "./common.js";
import { placedTemplate, shapeOf } from "../../../core/templates.js";
import { t } from "../../../core/i18n.js";

const MAX = 4, MELT = '2d6';
const FLAG = 'bladeHeat';

export const heatOf = item => Number(item?.getFlag?.(MODULE_ID, FLAG)) || 0;

/** Над токеном — нагрев */
function pop(actor, text, color = '#ff8a3c') {
    const token = tokenOf(actor);
    if (!token) return;
    const data = { sceneId: token.document.parent.id, tokenId: token.id, text, color };
    emit('bladePop', data);
    showPop(data);
}
onSocket('bladePop', data => showPop(data));
function showPop({ sceneId, tokenId, text, color }) {
    const token = canvas?.scene?.id === sceneId ? canvas.tokens.get(tokenId) : null;
    if (token) canvas.interface?.createScrollingText?.(token.center, text, { anchor: CONST.TEXT_ANCHOR_POINTS?.TOP ?? 2, fontSize: 26, fill: color, stroke: '#000000', strokeThickness: 4, duration: 1800 });
}

/** Попало ли: крит, иначе итог против КД единственной цели; null — не известно */
function hit(roll) {
    if (roll.isCritical) return true;
    if (roll.isFumble) return false;
    const targets = [...(game.user.targets ?? [])];
    if (targets.length !== 1) return null;
    const ac = targets[0].actor?.system?.attributes?.ac?.value;
    return Number.isFinite(ac) ? roll.total >= ac : null;
}

const counted = new WeakSet();
const onAttack = async (rolls, { subject } = {}) => {
    const roll = rolls?.[0];
    const item = subject?.item, actor = subject?.actor ?? item?.actor;
    if (!roll || counted.has(roll) || item?.type !== 'weapon' || !actor?.isOwner) return;
    counted.add(roll);
    const blade = blastSkill(actor, 'blade');
    if (!blade || hit(roll) !== true) return;
    const heat = heatOf(blade) + 1;
    if (heat < MAX) {
        await blade.setFlag(MODULE_ID, FLAG, heat);
        pop(actor, t('Нагрев {heat}', { heat }));
        return;
    }
    // Плавится в руке
    await blade.setFlag(MODULE_ID, FLAG, 0);
    pop(actor, t('Клинок плавится!'), '#ff3b2f');
    const token = tokenOf(actor);
    await blast({ actor, title: t('Раскалённый клинок плавится в руке {name}', { name: actor.name }), icon: 'fa-temperature-arrow-up', victims: token ? [token.document] : [], formula: MELT, type: 'fire' });
};
Hooks.on('dnd5e.rollAttack', onAttack);
Hooks.on('dnd5e.rollAttackV2', onAttack);

// Урон атаки оружием: + нагрев огнём отдельной строкой
Hooks.on('dnd5e.preRollDamageV2', (config) => {
    const activity = config?.subject;
    const item = activity?.item, actor = activity?.actor ?? item?.actor;
    if (item?.type !== 'weapon' || activity?.type !== 'attack') return;
    const heat = heatOf(blastSkill(actor, 'blade'));
    if (!heat) return;
    config.rolls ??= [];
    // dnd5e 6 ждёт у каждой строки данные формулы (config.data) — берём их у строки оружия
    const data = config.rolls[0]?.data ?? activity.getRollData?.() ?? {};
    config.rolls.push({ parts: [String(heat)], data: { ...data, roll: {} }, options: { type: 'fire', types: ['fire'], properties: [] } });
});

// Стравить жар
const venting = new Map();
Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item;
    if (!isBlast(item, 'blade') || !item.actor) return;
    const heat = heatOf(item);
    if (!heat) {
        ui.notifications.warn(t('Раскалённый клинок холодный — стравливать нечего. Нагрейте его попаданиями.'));
        return false;
    }
    if (message) message.create = false;
    venting.set(item.id, heat);
});

Hooks.on('dnd5e.postUseActivity', async (activity, usage, results) => {
    const item = activity?.item, actor = item?.actor;
    const heat = venting.get(item?.id);
    if (!heat) return;
    venting.delete(item.id);
    const template = placedTemplate(results);
    const shape = shapeOf(template);
    await item.setFlag(MODULE_ID, FLAG, 0);
    const self = tokenOf(actor)?.document;
    const victims = template ? template.parent.tokens.filter(t => t.actor && !t.hidden && t.id !== self?.id && inBeam(template, { x: t.x + (t.width || 1) * template.parent.grid.size / 2, y: t.y + (t.height || 1) * template.parent.grid.size / 2 })) : [];
    await blast({ actor, title: t('{name} стравливает жар клинка', { name: actor.name }), icon: 'fa-fire-flame-curved', victims, formula: `${heat}d6`, type: 'fire', ability: 'dex', dc: dcOf(item), at: shape ? { sceneId: template.parent.id, x: shape.x, y: shape.y, radius: template.parent.grid.size * 1.5 } : null });
    if (template) await template.delete();
});
