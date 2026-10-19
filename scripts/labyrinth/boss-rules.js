/**
 * Gacha Roguelike dnd5e — Правила Боссов и откуда берутся шрамы
 *
 * Правило Босса. В начале боя на узле Босса модуль тянет одно правило и объявляет его всем строкой.
 * Мастеру — шёпот с кнопками «другое» и «без правила» (подсказку можно выключить). Правило действует до
 * конца боя, модуль применяет его сам. Флаг боя bossRule { id, ids, tag?, bossId, tokenId }.
 * На паутине (web-map.js) правил столько, сколько ступеней Босс набрал, пока отряд ходил: 1 — Глушитель,
 * 2 — и Крайний спит, 3 — ещё +25% ПЗ, 4 — ещё свита (подсказка Мастеру).
 *   muffle (Глушитель)     — синергии самого частого тега отряда в этом бою не действуют;
 *   sleepy (Крайний спит)  — последний экипированный навык каждого персонажа спит, пока у Босса больше
 *                            половины ПЗ.
 *
 * Шрамы (memory/skills/living/scars.js) кладут: критический Укус Пожирателя — тому, по кому он пришёлся;
 * элита с 3-го этажа — после боя к4, на 1 случайный участник отряда; исход события scar.
 */

import { MODULE_ID } from "../core/constants.js";
import { HOOKS as MEMORY_HOOKS } from "../memory/memory-api.js";
import { isActiveGM } from "../core/socket.js";
import { hint } from "../core/prefs.js";
import { onRenderChatMessage } from "../core/chat-hooks.js";
import { isMemorySkill, isAwake, updateActorSynergies, TAG_COUNT_MODIFIERS } from "../memory/synergy/synergy.js";
import { sleepSkill, wakeSkill } from "../memory/skills/living/common.js";
import { grantScar, isScar } from "../memory/skills/living/scars.js";
import { mapScene } from "./scene-travel.js";
import { MAP_DATA } from "./map.js";
import { getFloor } from "./economy.js";
import { findBoss } from "./moon-boons.js";
import { isWeb, webStage, activeStages } from "./web-map.js";

const esc = s => foundry.utils.escapeHTML(String(s ?? ''));
const FLAG = 'bossRule';

export const BOSS_RULES = {
    muffle: { name: 'Глушитель', icon: 'fa-volume-xmark', text: rule => `Босс питается тегом «${esc(rule.tag)}»: синергии этого тега в этом бою не действуют.` },
    sleepy: { name: 'Крайний спит', icon: 'fa-moon', text: () => 'Последний экипированный навык каждого спит, пока у Босса больше половины ПЗ.' }
};

/** Тип узла, на котором стоит отряд */
export function currentNodeType() {
    const map = mapScene()?.getFlag(MODULE_ID, 'floorMap');
    return map?.nodes?.find(n => n.id === map.currentNodeId)?.type ?? null;
}

const partyIn = combat => combat.combatants.map(c => c.actor).filter(a => a?.type === 'character' && a.hasPlayerOwner);
export const ruleOf = combat => combat?.getFlag(MODULE_ID, FLAG) ?? null;
/** В правиле боя есть это правило Босса */
export const hasRule = (rule, id) => !!rule && (rule.ids ?? [rule.id]).includes(id);
const ruleFor = actor => ruleOf(game.combats?.find(c => c.started && ruleOf(c) && c.combatants.some(cb => cb.actor?.id === actor.id)));

/** Самый частый тег экипированных навыков отряда */
function partyTopTag(actors) {
    const counts = {};
    for (const actor of actors) {
        for (const item of actor.items.filter(i => isMemorySkill(i) && isAwake(i))) (item.flags[MODULE_ID].tags ?? []).forEach(t => { counts[t] = (counts[t] ?? 0) + 1; });
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// Глушитель: тег не считается
TAG_COUNT_MODIFIERS.push((actor, counts) => {
    const rule = ruleFor(actor);
    if (hasRule(rule, 'muffle') && rule.tag) counts[rule.tag] = 0;
});

const lastEquipped = actor => actor.items
    .filter(i => isMemorySkill(i) && isAwake(i) && !isScar(i) && !i.flags[MODULE_ID].horseman)
    .sort((a, b) => (Number(b.flags[MODULE_ID].equipped_at) || 0) - (Number(a.flags[MODULE_ID].equipped_at) || 0))[0] ?? null;

/** Снять правило: проснуться, пересчитать синергии */
async function clearRule(combat) {
    const rule = ruleOf(combat);
    if (!rule) return;
    await combat.unsetFlag(MODULE_ID, FLAG);
    for (const actor of partyIn(combat)) {
        for (const item of actor.items.filter(i => i.flags?.[MODULE_ID]?.asleep?.bossRule)) await wakeSkill(item);
        await updateActorSynergies(actor);
    }
}

/**
 * Поставить правило Босса на бой (Мастер). id — muffle | sleepy | null (без правила).
 * @returns {Promise<object|null>} правило
 */
export const setBossRule = (combat, id) => setBossRules(combat, id ? [id] : []);

/**
 * Поставить несколько правил Босса сразу (паутина: по ступеням). Пустой список — снять.
 * @returns {Promise<object|null>} правило боя { id, ids, tag?, bossId, tokenId }
 */
export async function setBossRules(combat, ids) {
    if (!combat || !game.user.isGM) return null;
    const previous = ruleOf(combat);
    await clearRule(combat);
    ids = [...new Set(ids.filter(id => BOSS_RULES[id]))];
    if (!ids.length) {
        if (previous) await announce(`<strong>Правило Босса снято.</strong>`);
        return null;
    }
    const party = partyIn(combat);
    const boss = findBoss(combat.scene ?? canvas.scene);
    const bossToken = (combat.scene ?? canvas.scene)?.tokens.find(t => t.actorId === boss?.id) ?? null;
    const rule = { bossId: boss?.id ?? null, tokenId: bossToken?.id ?? null };
    if (ids.includes('muffle')) {
        rule.tag = partyTopTag(party);
        // Глушить нечего — вместо него Крайний спит
        if (!rule.tag) ids = [...new Set(ids.map(id => (id === 'muffle' ? 'sleepy' : id)))];
    }
    Object.assign(rule, { id: ids[0], ids });
    await combat.setFlag(MODULE_ID, FLAG, rule);
    if (ids.includes('sleepy')) {
        for (const actor of party) {
            const item = lastEquipped(actor);
            if (item) await sleepSkill(item, { combatId: combat.id, bossRule: true, reason: 'правило Босса «Крайний спит», пока у Босса больше половины ПЗ' });
        }
    }
    for (const actor of party) await updateActorSynergies(actor);
    const sleepers = ids.includes('sleepy') ? party.map(a => a.items.find(i => i.flags?.[MODULE_ID]?.asleep?.bossRule)).filter(Boolean) : [];
    const lines = ids.map(id => `<i class="fas ${BOSS_RULES[id].icon}"></i> <strong>Правило Босса — ${BOSS_RULES[id].name}.</strong> ${BOSS_RULES[id].text(rule)}`);
    await announce(`${lines.join('<br>')}${sleepers.length ? `<br>Спят: ${sleepers.map(i => `«${esc(i.name)}» (${esc(i.actor.name)})`).join(', ')}.` : ''}`);
    return rule;
}

// Паутина, ступень 3: Босс окреп — на бой +25% к максимуму ПЗ (эффект уходит с концом боя)
async function strengthen(combat) {
    const boss = findBoss(combat.scene ?? canvas.scene);
    const token = (combat.scene ?? canvas.scene)?.tokens.find(t => t.actorId === boss?.id);
    const actor = token?.actor;
    const hp = actor?.system?.attributes?.hp;
    if (!hp?.max) return null;
    const extra = Math.round(hp.max * 0.25);
    await actor.createEmbeddedDocuments('ActiveEffect', [{
        name: 'Ступень Босса: окреп', img: 'icons/svg/regen.svg', origin: actor.uuid,
        changes: [{ key: 'system.attributes.hp.max', mode: 2, value: String(extra) }],
        description: '<p>Отряд долго ходил по этажу: у Босса на четверть больше ПЗ до конца боя.</p>',
        flags: { [MODULE_ID]: { bossBoost: combat.id } }
    }]);
    await actor.update({ 'system.attributes.hp.value': (Number(hp.value) || 0) + extra });
    return extra;
}

const announce = (html, whisper = false) => ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: 'Лабиринт' }),
    ...(whisper ? { whisper: ChatMessage.getWhisperRecipients('GM').map(u => u.id) } : {}),
    content: `<div class="gd-boss-rule">${html}</div>`
});

// Начало боя на узле Босса — правило (на паутине — по ступеням)
Hooks.on('combatStart', async combat => {
    if (!isActiveGM() || currentNodeType() !== MAP_DATA.NODE_BOSS || ruleOf(combat)) return;
    const map = mapScene()?.getFlag(MODULE_ID, 'floorMap');
    if (isWeb(map)) {
        const stage = webStage(map.web?.ticks ?? 0);
        if (!stage) return announce('<i class="fas fa-feather"></i> <strong>Босс спокоен:</strong> отряд уложился в тишину этажа — ни одной ступени.');
        const got = activeStages().slice(0, stage).map(s => s.id);
        const rules = got.filter(id => id === 'muffle' || id === 'sleepy');
        if (rules.length) await setBossRules(combat, rules);
        if (got.includes('strong')) {
            const extra = await strengthen(combat);
            if (extra) await announce(`<i class="fas fa-heart-circle-plus"></i> <strong>Ступень Босса — Окрепший:</strong> +${extra} к максимуму ПЗ до конца боя.`);
        }
        if (got.includes('retinue')) await announce('<i class="fas fa-users"></i> <strong>Ступень Босса — Свита:</strong> выставьте с Боссом двух приспешников его этажа.', true);
        if (hint('hintBossRules')) await announce(`<i class="fas fa-hourglass-half"></i> Ступеней Босса: ${stage} — отряд ходил по этажу ${map.web.ticks} шаг.<div class="gd-boss-rule-buttons"><button type="button" data-gd-bossrule="none"><i class="fas fa-ban"></i> Снять правила</button></div>`, true);
        return;
    }
    const ids = Object.keys(BOSS_RULES);
    const rule = await setBossRule(combat, ids[Math.floor(Math.random() * ids.length)]);
    if (!rule || !hint('hintBossRules')) return;
    await announce(`<i class="fas fa-dice"></i> Правило Босса выпало само — решать вам.<div class="gd-boss-rule-buttons"><button type="button" data-gd-bossrule="other"><i class="fas fa-rotate"></i> Другое правило</button><button type="button" data-gd-bossrule="none"><i class="fas fa-ban"></i> Без правила</button></div>`, true);
});

onRenderChatMessage((message, html) => {
    const buttons = html?.querySelectorAll?.('[data-gd-bossrule]');
    if (!buttons?.length) return;
    for (const button of buttons) {
        if (!game.user.isGM) { button.disabled = true; continue; }
        button.addEventListener('click', async () => {
            const combat = game.combat;
            if (!combat) return ui.notifications.warn('Боя нет.');
            if (button.dataset.gdBossrule === 'none') return setBossRule(combat, null);
            const current = ruleOf(combat)?.id;
            const others = Object.keys(BOSS_RULES).filter(id => id !== current);
            return setBossRule(combat, others[Math.floor(Math.random() * others.length)]);
        });
    }
});

// Крайний спит: у Босса половина ПЗ — навыки просыпаются
Hooks.on('updateActor', async actor => {
    if (!isActiveGM()) return;
    const combat = game.combats?.find(c => c.started && hasRule(ruleOf(c), 'sleepy'));
    const rule = ruleOf(combat);
    if (!rule || rule.woke) return;
    const isBoss = (rule.tokenId && actor.token?.id === rule.tokenId) || (!actor.isToken && actor.id === rule.bossId);
    if (!isBoss) return;
    const hp = actor.system?.attributes?.hp;
    if (!hp?.max || hp.value > hp.max / 2) return;
    await combat.setFlag(MODULE_ID, FLAG, { ...rule, woke: true });
    for (const a of partyIn(combat)) {
        for (const item of a.items.filter(i => i.flags?.[MODULE_ID]?.asleep?.bossRule)) await wakeSkill(item);
    }
    await announce('<i class="fas fa-sun"></i> <strong>Босс ранен наполовину</strong> — спящие навыки просыпаются.');
});

// Конец боя: правило уходит вместе с боем — синергии считаются заново (спящие просыпаются в scars.js)
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    // Ступень «Окрепший» уходит вместе с боем
    for (const token of (combat.scene ?? canvas.scene)?.tokens ?? []) {
        const boosts = token.actor?.effects.filter(e => e.flags?.[MODULE_ID]?.bossBoost === combat.id).map(e => e.id) ?? [];
        if (boosts.length) await token.actor.deleteEmbeddedDocuments('ActiveEffect', boosts);
    }
    if (!ruleOf(combat)) return;
    for (const actor of partyIn(combat)) await updateActorSynergies(actor);
});

// ==========================================
// ШРАМЫ: Укус Пожирателя и элита
// ==========================================

// Критический Укус Пожирателя — шрам тому, по кому он пришёлся (цель — выделенная Мастером)
Hooks.on('dnd5e.rollAttackV2', async (rolls, { subject } = {}) => {
    if (!isActiveGM()) return;
    const item = subject?.item;
    if (item?.actor?.getFlag(MODULE_ID, 'creature') !== 'devourer' || !/Укус/.test(item.name)) return;
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if (!roll?.isCritical) return;
    const target = [...game.user.targets][0]?.actor;
    if (target?.type === 'character' && target.hasPlayerOwner) await grantScar(target, { reason: 'Критический Укус Пожирателя' });
});

// Элита с 3-го этажа: после боя к4, на 1 — шрам случайному участнику отряда
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM() || currentNodeType() !== MAP_DATA.NODE_ELITE || getFloor() < 3) return;
    const party = partyIn(combat).filter(a => (Number(a.system?.attributes?.hp?.value) || 0) > 0);
    if (!party.length) return;
    const roll = await new Roll('1d4').evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ alias: 'Лабиринт' }), flavor: `Элита оставляет следы: к4${roll.total === 1 ? ' — шрам' : ''}` });
    if (roll.total !== 1) return;
    await grantScar(party[Math.floor(Math.random() * party.length)], { reason: 'Элита оставила шрам' });
});

// Награда за ступени Босса паутины: каждая набранная ступень — ещё один кристалл в добыче Босса; если набраны
// все — один из них фиолетовый. Жадный отряд рискует сильнее, но и уносит больше
Hooks.on(MEMORY_HOOKS.lootPlanned, plan => {
    if (plan.roomType !== 'boss' || currentNodeType() !== MAP_DATA.NODE_BOSS) return;
    const map = mapScene()?.getFlag(MODULE_ID, 'floorMap');
    if (!isWeb(map)) return;
    const stage = webStage(map.web?.ticks ?? 0);
    if (!stage) return;
    plan.extra += stage;
    if (stage >= activeStages().length) plan.rarities.push('purple');
    plan.lines.push(`<div style="text-align: center; margin-top: 8px; color: #e8a49c;"><i class="fas fa-skull"></i> Босс набрал ступеней: ${stage} — в добыче ещё ${stage} крист.${stage >= activeStages().length ? ', один из них фиолетовый' : ''}.</div>`);
});
