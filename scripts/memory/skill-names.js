/**
 * Gacha Roguelike dnd5e — Названия навыков на столе
 *
 * Название навыка у персонажа и у его кристаллов — «название на столе»:
 *   1) своё название Мастера (настройка «Свои названия навыков»: «Название из модуля = Своё»; хранится в
 *      мире, с модулем не распространяется — так столу можно вернуть любимые мемы и прямые отсылки);
 *   2) грубое название (18+) — если навык его имеет и включены «Грубые названия навыков»;
 *   3) название из компендиума.
 * Навык и кристалл связаны с компендиумом по id (флаг skill_id), поэтому название можно менять когда угодно:
 * при запуске мира и при смене настроек Мастер приводит названия выданных навыков и кристаллов (в том числе
 * в Хранилищах) к нужным. Надставки к названию сохраняются: тег Сингулярности «[тег]», имя сращённого всадника.
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM } from "../core/socket.js";
import { getSkillPack } from "./crystals.js";

const CRYSTAL = 'Кристалл: ';
let cache = null;

export function registerSkillNameSettings() {
    game.settings.register(MODULE_ID, 'rudeNames', {
        name: 'Грубые названия навыков (18+)',
        hint: 'Навыки с ненормативной лексикой в названии показываются в исходном виде. Выключено — приличные названия.',
        scope: 'world', config: true, type: Boolean, default: false,
        onChange: () => syncSkillNames()
    });
    game.settings.register(MODULE_ID, 'skillNames', {
        name: 'Свои названия навыков',
        hint: 'По строке на навык: «Название из модуля = Своё название». Хранится в этом мире и с модулем не распространяется. Удалите строку — вернётся название модуля.',
        scope: 'world', config: false, type: String, default: '', multiline: true,
        onChange: () => syncSkillNames()
    });
}

/** Компендиум навыков: id → { name, explicit } */
async function loadCache() {
    const pack = getSkillPack();
    if (!pack) return null;
    const index = await pack.getIndex({ fields: [`flags.${MODULE_ID}.explicit_name`] });
    cache = new Map([...index].map(e => [e._id, { name: e.name, explicit: e.flags?.[MODULE_ID]?.explicit_name ?? null }]));
    return cache;
}

/** Свои названия Мастера: id навыка → название */
function customNames() {
    const map = new Map();
    const text = String(game.settings.get(MODULE_ID, 'skillNames') ?? '');
    const byName = new Map([...(cache ?? [])].map(([id, e]) => [e.name.trim().toLowerCase(), id]));
    for (const line of text.split('\n')) {
        const at = line.indexOf('=');
        if (at < 0) continue;
        const from = line.slice(0, at).trim(), to = line.slice(at + 1).trim();
        const id = cache?.has(from) ? from : byName.get(from.toLowerCase());
        if (id && to) map.set(id, to);
    }
    return map;
}

/** Название навыка на столе по id в компендиуме; null — навыка нет в компендиуме */
export function displayName(skillId, custom = customNames()) {
    const entry = cache?.get(skillId);
    if (!entry) return null;
    return custom.get(skillId) || (game.settings.get(MODULE_ID, 'rudeNames') && entry.explicit) || entry.name;
}

/** Новое имя предмета: прежнее название навыка заменяется, надставки остаются */
function renamed(name, prev, next, crystal) {
    if (crystal) return `${CRYSTAL}${next}`;
    if (!prev || name === prev) return next;
    if (name.startsWith(prev)) return next + name.slice(prev.length);
    return null;
}

/** Привести названия выданных навыков и кристаллов (и Хранилищ) к названиям на столе — Мастер */
export async function syncSkillNames() {
    if (!isActiveGM()) return;
    if (!cache) await loadCache();
    if (!cache) return;
    const custom = customNames();
    const actors = new Set(game.actors);
    for (const scene of game.scenes) for (const token of scene.tokens) if (!token.actorLink && token.actor) actors.add(token.actor);
    for (const actor of actors) {
        const updates = [];
        for (const item of actor.items) {
            const flags = item.flags?.[MODULE_ID];
            if (!flags?.skill_id) continue;
            const next = displayName(flags.skill_id, custom);
            if (!next) continue;
            const name = renamed(item.name, flags.skill_name, next, !!flags.is_crystal_item);
            if (name && (name !== item.name || flags.skill_name !== next)) updates.push({ _id: item.id, name, [`flags.${MODULE_ID}.skill_name`]: next });
        }
        if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
        const stash = actor.getFlag(MODULE_ID, 'stash');
        if (Array.isArray(stash) && stash.length) {
            let changed = false;
            const fixed = stash.map(data => {
                const flags = data.flags?.[MODULE_ID];
                const next = flags?.skill_id ? displayName(flags.skill_id, custom) : null;
                if (!next || (data.name === `${CRYSTAL}${next}` && flags.skill_name === next)) return data;
                changed = true;
                return { ...data, name: `${CRYSTAL}${next}`, flags: { ...data.flags, [MODULE_ID]: { ...flags, skill_name: next } } };
            });
            if (changed) await actor.setFlag(MODULE_ID, 'stash', fixed);
        }
    }
}

// Новый навык или кристалл из компендиума сразу получает название на столе
Hooks.on('preCreateItem', (item) => {
    const flags = item.flags?.[MODULE_ID];
    if (!flags?.skill_id || !cache) return;
    const next = displayName(flags.skill_id);
    if (!next) return;
    const name = renamed(item.name, flags.skill_name, next, !!flags.is_crystal_item);
    if (name && (name !== item.name || flags.skill_name !== next)) item.updateSource({ name, [`flags.${MODULE_ID}.skill_name`]: next });
});

Hooks.once('ready', async () => {
    await loadCache();
    await syncSkillNames();
});
