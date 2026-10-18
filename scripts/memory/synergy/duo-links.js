/**
 * Gacha Roguelike dnd5e — Связки синергий (двойные навыки, флаг duo: [тег, тег])
 *
 * Двойной навык не выпадает кристаллом. Это связка двух синергий: она включается сама у персонажа, у
 * которого экипировано не меньше DUO_THRESHOLD навыков каждого из двух тегов (навык с обоими тегами идёт
 * в оба счёта), и пропадает, когда условие перестаёт держаться — как способность синергии.
 *
 * Выдачу ведёт расчёт синергий (synergy.js): связка — способность синергии с tagSource «duo:тег+тег».
 * Потраченные заряды связки запоминаются на персонаже (флаг duo_spent) и возвращаются, если она пропала и
 * появилась снова; отдых их стирает.
 */

import { MODULE_ID } from "../../core/constants.js";
import { getSkillPack } from "../crystals.js";

export const DUO_THRESHOLD = 2;
export const DUO_SOURCE = 'duo:';
export const isDuoLink = item => String(item?.flags?.[MODULE_ID]?.tagSource ?? '').startsWith(DUO_SOURCE);

// Двойные навыки компендиума: читаются один раз
let cache = null;
export async function duoSkills() {
    if (cache) return cache;
    const pack = getSkillPack();
    if (!pack) return [];
    const index = await pack.getIndex({ fields: [`flags.${MODULE_ID}.duo`] });
    const entries = [...index].filter(e => e.flags?.[MODULE_ID]?.duo?.length === 2);
    cache = (await Promise.all(entries.map(e => pack.getDocument(e._id)))).filter(Boolean).map(d => d.toObject());
    return cache;
}

/** Сколько не хватает до каждой связки: [{ name, img, duo: [a, b], have: [n, m], ready }] */
export async function duoProgress(tagCounts) {
    return (await duoSkills()).map(skill => {
        const duo = skill.flags[MODULE_ID].duo;
        const have = duo.map(t => tagCounts[t] ?? 0);
        return { name: skill.name, img: skill.img, duo, have, ready: have.every(n => n >= DUO_THRESHOLD) };
    });
}

/**
 * Данные способностей связок, которые положены персонажу при этом счёте тегов.
 * @param {Actor} actor
 * @param {Object<string, number>} tagCounts  счёт тегов экипированных навыков (с поправками)
 * @param {number} version                     версия способностей синергий
 */
export async function duoGrants(actor, tagCounts, version) {
    const spent = actor.getFlag(MODULE_ID, 'duo_spent') ?? {};
    const grants = [];
    for (const skill of await duoSkills()) {
        const flags = skill.flags[MODULE_ID];
        if (!flags.duo.every(t => (tagCounts[t] ?? 0) >= DUO_THRESHOLD)) continue;
        const { _id, ...data } = foundry.utils.deepClone(skill);
        data.flags[MODULE_ID] = { ...flags, is_synergy_item: true, is_active: true, tagSource: `${DUO_SOURCE}${flags.duo.join('+')}`, feature_version: version };
        if (spent[flags.skill_id ?? _id] && data.system?.uses) data.system.uses.spent = spent[flags.skill_id ?? _id];
        grants.push(data);
    }
    return grants;
}

/** Связки уходят: их потраченные заряды запоминаются до отдыха */
export async function rememberSpent(actor, items) {
    const links = items.filter(isDuoLink);
    if (!links.length) return;
    const spent = { ...(actor.getFlag(MODULE_ID, 'duo_spent') ?? {}) };
    for (const item of links) spent[item.flags[MODULE_ID].skill_id ?? item.id] = Number(item.system?.uses?.spent) || 0;
    await actor.setFlag(MODULE_ID, 'duo_spent', spent);
}

Hooks.on('dnd5e.restCompleted', actor => {
    if (actor?.isOwner && game.users.activeGM?.isSelf && actor.getFlag(MODULE_ID, 'duo_spent')) actor.unsetFlag(MODULE_ID, 'duo_spent');
});
