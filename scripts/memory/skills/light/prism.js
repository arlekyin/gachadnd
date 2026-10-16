/**
 * Gacha Roguelike dnd5e — Призма (зелёный навык света)
 *
 * Использование взводит призму: урон ближайшей атаки персонажа (в бою — до конца хода) делится на 7
 * равных частей по цветам радуги, остаток — к первой.
 *
 * Бросок урона помечается свойством gdPrism. Перед созданием сообщения (preCreateChatMessage)
 * помеченные броски заменяются семью бросками-константами разных типов (свойство gdPrismPart), и
 * кнопка применения dnd5e считает сопротивления, иммунитеты и уязвимости цели по каждой части.
 * В карточке урона — цветная строка раскладки (исходный бросок Dice So Nice показывает кубиками);
 * после применения — карточка цели: сколько дошло каждого цвета и что сделали её защиты.
 * Если сообщение не создавалось, помеченный урон делится перед расчётом урона цели
 * (dnd5e.preCalculateDamage) — dnd5e переносит roll.options.properties в описание урона.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { isLight, lightCard, esc } from "./common.js";

export const MARK = 'gdPrism';
export const PART = 'gdPrismPart';
/** Цвета радуги для строк раскладки */
const COLORS = { fire: '#e53935', acid: '#fb8c00', lightning: '#f9c900', poison: '#43a047', cold: '#29b6f6', thunder: '#3949ab', force: '#8e24aa' };
/** Красный, оранжевый, жёлтый, зелёный, голубой, синий, фиолетовый */
export const SPECTRUM = ['fire', 'acid', 'lightning', 'poison', 'cold', 'thunder', 'force'];
const FLAG = 'prism';

const isHealing = type => type === 'healing' || type === 'temphp';
const marked = properties => [...(properties ?? [])].includes(MARK);
const typeLabel = type => CONFIG.DND5E?.damageTypes?.[type]?.label ?? type;

/** Сумма → 7 частей по цветам, остаток — к первой; нулевые части не нужны */
export function spectrum(total) {
    const base = Math.trunc(total / SPECTRUM.length);
    const rest = total - base * SPECTRUM.length;
    return SPECTRUM.map((type, i) => ({ type, value: base + (i === 0 ? rest : 0) })).filter(p => p.value);
}

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isLight(item, 'prism') || !actor) return;
    const combat = game.combat?.started ? game.combat : null;
    actor.setFlag(MODULE_ID, FLAG, { combatId: combat?.id ?? null, round: combat?.round ?? null, turn: combat?.turn ?? null });
    lightCard(actor, 'Призма', `<p>Урон следующей атаки разложится на семь цветов радуги: ${SPECTRUM.map(typeLabel).join(', ')}. Сопротивления цели считаются по каждой части.</p>`, { icon: 'fa-rainbow', cls: 'prism' });
});

// Бросок урона атаки взведённого персонажа: части урона помечаются, призма гаснет
Hooks.on('dnd5e.preRollDamageV2', (config) => {
    const activity = config?.subject;
    const actor = activity?.actor ?? activity?.item?.actor;
    if (activity?.type !== 'attack' || !actor?.getFlag(MODULE_ID, FLAG)) return;
    for (const roll of config.rolls ?? []) {
        roll.options ??= {};
        roll.options.properties = [...(roll.options.properties ?? []), MARK];
    }
    actor.unsetFlag(MODULE_ID, FLAG);
});

// Карточка урона: помеченные броски → семь строк по цветам
Hooks.on('preCreateChatMessage', (message) => {
    // dnd5e 5 — тип броска во флаге, dnd5e 6 — тип самого сообщения
    if ((message.flags?.dnd5e?.roll?.type ?? message.type) !== 'damage') return;
    const rolls = message.rolls ?? [];
    const prism = rolls.filter(r => marked(r.options?.properties) && !isHealing(r.options?.type));
    if (!prism.length) return;
    const total = prism.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
    const properties = [...[...(prism[0].options.properties ?? [])].filter(p => p !== MARK), PART];
    const DamageRoll = CONFIG.Dice.DamageRoll ?? Roll;
    const parts = spectrum(total).map(({ type, value }) => {
        const roll = new DamageRoll(String(value), {}, { type, types: [type], properties });
        roll.evaluateSync();
        return roll;
    });
    const kept = rolls.filter(r => !prism.includes(r));
    const source = prism.map(r => r.formula).join(' + ');
    message.updateSource({
        rolls: [...kept, ...parts].map(r => JSON.stringify(r.toJSON())),
        [`flags.${MODULE_ID}.prism`]: { total, source, parts: spectrum(total) }
    });
    // Кубики исходного броска — их больше нет в сообщении
    for (const roll of prism) game.dice3d?.showForRoll?.(roll, game.user, true);
});

/** Запасной путь: помеченный урон без карточки делится перед расчётом урона. @returns {boolean} */
export function split(damages) {
    const found = damages.filter(d => d.properties?.has?.(MARK) && !isHealing(d.type));
    if (!found.length) return false;
    const total = found.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
    const properties = [...found[0].properties].filter(p => p !== MARK);
    for (const d of found) damages.splice(damages.indexOf(d), 1);
    for (const { type, value } of spectrum(total)) damages.push({ type, value, properties: new Set(properties) });
    return true;
}

// Итог по цели: значения до защит — перед расчётом, после — после него, карточка — после применения
const pending = new WeakMap();
Hooks.on('dnd5e.preCalculateDamage', (actor, damages, options) => {
    split(damages);
    if (damages.some(d => d.properties?.has?.(PART))) pending.set(options, { before: damages.map(d => Number(d.value) || 0) });
});
Hooks.on('dnd5e.calculateDamage', (actor, damages, options) => {
    const entry = pending.get(options);
    if (entry) entry.after = damages.map(d => ({ type: d.type, value: d.value, active: { ...(d.active ?? {}) }, part: !!d.properties?.has?.(PART) }));
});
Hooks.on('dnd5e.applyDamage', (actor, amount, options) => {
    const entry = pending.get(options);
    pending.delete(options);
    if (!entry?.after) return;
    const rows = entry.after.map((d, i) => {
        if (!d.part) return null;
        const before = entry.before[i];
        const value = Math.trunc(d.value);
        // dnd5e 5: active.resistance, dnd5e 6: active.type.resistance или active.all.resistance
        const has = c => !!(d.active[c] || d.active.type?.[c] || d.active.all?.[c]);
        const why = has('immunity') ? 'иммунитет' : has('resistance') ? 'сопротивление' : has('vulnerability') ? 'уязвимость' : '';
        const arrow = value !== before ? ` → <strong>${value}</strong>` : '';
        return `<li style="--gd-prism:${COLORS[d.type] ?? '#888'}"><span>${esc(typeLabel(d.type))}</span> ${before}${arrow}${why ? ` <em>(${why})</em>` : ''}</li>`;
    }).filter(Boolean);
    ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-light-card prism"><div class="gd-light-title"><i class="fas fa-rainbow"></i> Призма — ${esc(actor.name)}</div><ul class="gd-prism-parts">${rows.join('')}</ul><p>Итого урона: <strong>${amount}</strong>.</p></div>`
    });
});

// Карточка урона: цветная строка раскладки под заголовком. dnd5e 6 перестраивает блок броска уже после
// хука ядра — строка ставится и в его хуке (dnd5e.renderChatMessage), второй раз она не добавится
onRenderChatMessage(prismLine);
Hooks.on('dnd5e.renderChatMessage', prismLine);

function prismLine(message, html) {
    const flag = message.flags?.[MODULE_ID]?.prism;
    if (!flag?.parts || !html || html.querySelector?.('.gd-prism-line')) return;
    const line = document.createElement('div');
    line.className = 'gd-prism-line';
    line.innerHTML = `<i class="fas fa-rainbow"></i> Призма: ${flag.total} (${esc(flag.source)}) → `
        + flag.parts.map(p => `<span style="--gd-prism:${COLORS[p.type] ?? '#888'}">${p.value} ${esc(typeLabel(p.type).toLowerCase())}</span>`).join(' · ');
    // dnd5e 6: кнопка броска стоит в строке с иконкой — строку раскладки ставим перед всей строкой
    const roll = html.querySelector('.dice-roll');
    const anchor = roll?.closest('section.icon-row') ?? roll ?? html.querySelector('.message-content');
    anchor?.parentNode?.insertBefore(line, anchor);
}

// В бою призма гаснет с концом хода, в котором её взвели
Hooks.on('updateCombat', (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM()) return;
    for (const c of combat.combatants) {
        const flag = c.actor?.getFlag(MODULE_ID, FLAG);
        if (flag?.combatId === combat.id && (flag.round !== combat.round || flag.turn !== combat.turn)) c.actor.unsetFlag(MODULE_ID, FLAG);
    }
});
