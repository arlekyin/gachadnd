/**
 * Gacha Roguelike dnd5e — Всадники Погибели
 *
 * Оранжевые кристаллы с двумя состояниями: проклятый всадник (всегда экипирован, занимает слот)
 * и сращённый (экипирован сверх лимита). У персонажа может быть только один всадник за забег.
 * Автоматически: кормление и пожирание Голода, серия боевых узлов Войны, Боевой счёт и Кровавая баня.
 * Остальные эффекты применяет Мастер.
 */

import { MODULE_ID } from "./main.js";
import { isMemorySkill, setSkillEquipped } from "./synergy.js";

export const HORSEMEN = {
    hunger: 'Голод',
    plague: 'Чума',
    war: 'Война',
    death: 'Смерть'
};

const COMBAT_NODES = ['mob', 'elite', 'boss'];
// Риск — небоевое испытание навыков
const PEACE_NODES = ['event', 'shop', 'rest', 'doom', 'risk'];

export const isHorseman = item => !!item?.flags?.[MODULE_ID]?.horseman;
export const isCleansed = item => !!item?.flags?.[MODULE_ID]?.cleansed;

export function getHorseman(actor, key = null) {
    return actor?.items.find(i => isMemorySkill(i) && isHorseman(i) && (!key || i.flags[MODULE_ID].horseman === key)) ?? null;
}

// Всадник уже взят: флаг ставится при выдаче с алтаря и остаётся на весь забег
export function hasTakenHorseman(actor) {
    return !!actor?.getFlag(MODULE_ID, 'horseman') || !!getHorseman(actor);
}

export function partyActors() {
    return game.actors.filter(a => a.type === 'character' && a.hasPlayerOwner);
}

function isActiveGM() {
    return game.user.isActiveGM ?? (game.user.isGM && game.users.activeGM?.id === game.user.id);
}

async function whisperOwners(actor, content) {
    const whisper = game.users.filter(u => actor.testUserPermission(u, 'OWNER')).map(u => u.id);
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content, whisper });
}

// ==========================================
// СРАЩИВАНИЕ
// ==========================================

export async function cleanseHorseman(item) {
    if (!isHorseman(item) || isCleansed(item)) return;
    const flags = item.flags[MODULE_ID];
    await item.update({
        name: `${flags.skill_name}: ${flags.cleansed_name}`,
        'system.description.value': flags.cleansed_description,
        [`flags.${MODULE_ID}.cleansed`]: true,
        [`flags.${MODULE_ID}.cleanse_progress`]: flags.cleanse_goal ?? flags.cleanse_progress ?? 0
    });
    if (!item.flags[MODULE_ID].is_active) await setSkillEquipped(item, true);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: item.actor }),
        content: `<div class="gachadnd-rank-up"><strong>🐎 ${flags.skill_name}</strong> срастается с носителем — <strong>${flags.cleansed_name}</strong></div>`
    });
    Hooks.callAll('gachadnd.synergyUpdated', item.actor);
    if (flags.horseman === 'war') await syncWarEffects();
}

// Прогресс сращивания; при достижении цели всадник срастается сам
export async function addCleanseProgress(item, amount = 1) {
    if (!isHorseman(item) || isCleansed(item)) return;
    const flags = item.flags[MODULE_ID];
    const progress = Math.max(0, (flags.cleanse_progress ?? 0) + amount);
    await item.setFlag(MODULE_ID, 'cleanse_progress', progress);
    if (flags.cleanse_goal && progress >= flags.cleanse_goal) await cleanseHorseman(item);
}

// ==========================================
// ВЗЯТИЕ ВСАДНИКА
// ==========================================

// Проклятый всадник сразу экипирован; Голод сжигает все неэкипированные навыки Памяти
Hooks.on('createItem', async (item, options, userId) => {
    if (game.user.id !== userId || !(item.parent instanceof Actor) || !isMemorySkill(item) || !isHorseman(item)) return;
    const actor = item.parent;
    const flags = item.flags[MODULE_ID];
    await actor.setFlag(MODULE_ID, 'horseman', flags.horseman);
    if (isCleansed(item)) return;

    await setSkillEquipped(item, true);
    if (flags.horseman === 'hunger') {
        const eaten = actor.items.filter(i => isMemorySkill(i) && i.id !== item.id && !i.flags[MODULE_ID].is_active && !i.flags[MODULE_ID].undeletable);
        if (eaten.length) await actor.deleteEmbeddedDocuments('Item', eaten.map(i => i.id));
        await whisperOwners(actor, `<strong>Голод</strong> пожирает неэкипированные навыки: ${eaten.map(i => i.name).join(', ') || 'нечего есть'}.`);
    }
    Hooks.callAll('gachadnd.synergyUpdated', actor);
});

// ==========================================
// ГОЛОД: КОРМЛЕНИЕ И ПОЖИРАНИЕ
// ==========================================

export async function feedHunger(actor, crystal) {
    const hunger = getHorseman(actor, 'hunger');
    if (!hunger || isCleansed(hunger)) return false;
    const quantity = crystal.system?.quantity ?? 1;
    if (quantity > 1) await crystal.update({ 'system.quantity': quantity - 1 });
    else await crystal.delete();
    await hunger.setFlag(MODULE_ID, 'fed_since_rest', true);
    await whisperOwners(actor, `<strong>Голод</strong> съедает ${crystal.name}.`);
    await addCleanseProgress(hunger, 1);
    return true;
}

// Не кормленный с прошлого долгого отдыха Голод пожирает экипированный навык
Hooks.on('dnd5e.restCompleted', async (actor, result, config) => {
    const isLong = result?.longRest ?? (config?.type === 'long');
    if (!isLong) return;
    const hunger = getHorseman(actor, 'hunger');
    if (!hunger || isCleansed(hunger)) return;
    if (!hunger.flags[MODULE_ID].fed_since_rest) {
        const victims = actor.items.filter(i => isMemorySkill(i) && !isHorseman(i) && i.flags[MODULE_ID].is_active && !i.flags[MODULE_ID].undeletable);
        const victim = victims[Math.floor(Math.random() * victims.length)];
        if (victim) {
            await victim.delete();
            await whisperOwners(actor, `<strong>Голод</strong> не дождался еды и пожрал навык «${victim.name}».`);
        }
    }
    await hunger.setFlag(MODULE_ID, 'fed_since_rest', false);
});

// ==========================================
// ВОЙНА: СЕРИЯ УЗЛОВ, БОЕВОЙ СЧЁТ, КРОВАВАЯ БАНЯ
// ==========================================

/**
 * Отряд вошёл в узел карты (вызывается картой на клиенте Мастера).
 * Боевой узел продлевает серию Войны, узел без боя сбрасывает её и ранит носителя проклятой Войны.
 */
export async function onNodeEntered(type) {
    for (const actor of partyActors()) {
        const war = getHorseman(actor, 'war');
        if (!war) continue;
        const streak = war.flags[MODULE_ID].streak ?? 0;
        if (COMBAT_NODES.includes(type)) {
            await war.setFlag(MODULE_ID, 'streak', streak + 1);
            if (!isCleansed(war)) {
                await war.setFlag(MODULE_ID, 'cleanse_progress', streak + 1);
                if (streak + 1 >= (war.flags[MODULE_ID].cleanse_goal ?? 4)) await cleanseHorseman(war);
            }
        } else if (PEACE_NODES.includes(type)) {
            await war.setFlag(MODULE_ID, 'streak', 0);
            if (!isCleansed(war)) {
                await war.setFlag(MODULE_ID, 'cleanse_progress', 0);
                const level = actor.system.details?.level ?? 1;
                const hp = actor.system.attributes.hp.value;
                await actor.update({ 'system.attributes.hp.value': Math.max(0, hp - level) });
                await whisperOwners(actor, `<strong>Война</strong> недовольна миром: −${level} ПЗ, благ этого узла вы не получаете.`);
            }
        }
    }
    await syncWarEffects();
}

function cleansedWarHolder() {
    return partyActors().find(a => {
        const war = getHorseman(a, 'war');
        return war && isCleansed(war) && war.flags[MODULE_ID].is_active;
    }) ?? null;
}

// Эффект на всех персонажах отряда: создать, обновить силу или снять
async function syncPartyEffect(key, n, name, changes) {
    for (const actor of partyActors()) {
        const existing = actor.effects.find(e => e.flags?.[MODULE_ID]?.war_effect === key);
        if (n <= 0) {
            if (existing) await existing.delete();
            continue;
        }
        const data = {
            name: `${name} (${n})`,
            img: 'icons/svg/sword.svg',
            disabled: false,
            changes: changes.map(([k, v]) => ({ key: k, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: v.replaceAll('{n}', n) })),
            flags: { [MODULE_ID]: { war_effect: key, war_n: n } }
        };
        if (!existing) await actor.createEmbeddedDocuments('ActiveEffect', [data]);
        else if (existing.flags[MODULE_ID].war_n !== n) await existing.update(data);
    }
}

const COUNT_CHANGES = ['mwak', 'rwak', 'msak', 'rsak'].flatMap(t => [
    [`system.bonuses.${t}.attack`, '+{n}'],
    [`system.bonuses.${t}.damage`, '+{n}']
]);

export async function syncWarEffects() {
    if (!isActiveGM()) return;
    const holder = cleansedWarHolder();
    const prof = holder?.system.attributes?.prof ?? 0;
    const streak = holder ? (getHorseman(holder, 'war').flags[MODULE_ID].streak ?? 0) : 0;
    await syncPartyEffect('bloodbath', Math.min(streak, prof), 'Кровавая баня', [['system.bonuses.abilities.save', '+{n}']]);
    const combat = game.combats?.find(c => c.started);
    const kills = combat?.getFlag(MODULE_ID, 'war_kills') ?? 0;
    await syncPartyEffect('count', holder ? Math.min(kills, prof) : 0, 'Боевой счёт', COUNT_CHANGES);
}

// Убийство врага в бою: Боевой счёт растёт, если у отряда есть сращённая Война
Hooks.on('updateActor', async (actor, changes) => {
    if (!isActiveGM() || foundry.utils.getProperty(changes, 'system.attributes.hp.value') !== 0) return;
    if (!cleansedWarHolder()) return;
    // Синтетический актёр несвязанного токена — тот же объект, что combatant.actor
    const combat = game.combats?.find(c => c.started && c.combatants.some(cb => cb.actor === actor));
    if (!combat) return;
    const combatant = combat.combatants.find(cb => cb.actor === actor);
    if (combatant?.token?.disposition !== CONST.TOKEN_DISPOSITIONS.HOSTILE) return;
    await combat.setFlag(MODULE_ID, 'war_kills', (combat.getFlag(MODULE_ID, 'war_kills') ?? 0) + 1);
    await syncWarEffects();
});

// Боевой счёт живёт до конца боя
Hooks.on('deleteCombat', async () => {
    if (!isActiveGM()) return;
    await syncPartyEffect('count', 0, 'Боевой счёт', COUNT_CHANGES);
});
