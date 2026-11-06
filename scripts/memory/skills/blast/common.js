/**
 * Gacha Roguelike dnd5e — Навыки огня и взрыва: общее
 *
 * Навык — флаг blast: <вид> (fine, lava, blade, phoenix, potato, hiss, barrel, corpse, gas, ohyeah).
 * Каждый вид — свой файл в этой папке. Здесь: поиск навыка, формула урона и Сл активности, карточка
 * взрыва с кнопками dnd5e (бросают игроки и цели, применяет Мастер лотком), ожидание спасброска для
 * эффектов провала и вспышка взрыва на сцене у всех.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { emit, onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage, messageItem } from "../../../core/chat-hooks.js";
import { feetBetween } from "../light/flash.js";
import { esc, centerOf } from "../light/common.js";
import { t } from "../../../core/i18n.js";

export { ref, actorFrom, tokenOf, esc, centerOf, feetToPx } from "../light/common.js";
export { feetBetween };

export const blastKind = item => item?.flags?.[MODULE_ID]?.blast ?? null;
export const isBlast = (item, kind) => blastKind(item) === kind && !item.flags[MODULE_ID].is_crystal_item;
/** Экипированный навык этого вида у персонажа */
export const blastSkill = (actor, kind) => actor?.items?.find(i => isBlast(i, kind) && i.flags[MODULE_ID].is_active) ?? null;

const ABILITY = { str: t('Силы'), dex: t('Ловкости'), con: t('Телосложения'), int: t('Интеллекта'), wis: t('Мудрости'), cha: t('Харизмы') };
const DAMAGE = { fire: t('огнём'), thunder: t('звуком'), bludgeoning: t('дробящий'), poison: t('ядом'), force: t('силовым полем') };

/**
 * Шаблон dnd5e не ставится — область навык считает сам. Карточка навыка dnd5e остаётся в чате, как у
 * любой способности; её кнопки броска прячутся (см. ниже) — броски придут карточкой события
 */
export function quiet(usage) {
    if (usage) usage.create = { ...(usage.create ?? {}), measuredTemplate: false };
}

/** Карточка проверки без урона: кто бросает спасбросок, кнопка dnd5e; onFail — эффект на провале */
export async function saveCard({ actor, title, icon = 'fa-shield', tokens, ability, dc, note = '', onFail = null }) {
    const TextEditor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    const content = await TextEditor.enrichHTML(`<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas ${icon}"></i> ${esc(title)}</div>
        ${note ? `<p>${note}</p>` : ''}<p>${t('Спасбросок {v} Сл {dc}: {v2}', { v: ABILITY[ability] ?? ability, dc, v2: esc(tokens.map(t => t.name).join(', ')) })}</p>
        <p class="gd-blast-rolls">[[/save ${ability} ${dc}]]</p></div>`, { rollData: actor?.getRollData?.() ?? {} });
    const message = await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
    if (onFail) await expectSave(tokens, { ability, dc, ...onFail });
    return message;
}

/** Урон навыка на его ранге: { formula, type } из первой части урона активности */
export function damageOf(item, fallback = null) {
    const part = item?.system?.activities?.contents?.[0]?.damage?.parts?.[0];
    if (!part) return fallback;
    const formula = part.custom?.enabled ? part.custom.formula
        : (part.number && part.denomination ? `${part.number}d${part.denomination}${part.bonus ? ` + ${part.bonus}` : ''}` : null);
    return formula ? { formula, type: [...(part.types ?? [])][0] ?? fallback?.type ?? 'fire' } : fallback;
}

/** Сл навыка: спасбросок активности, иначе Сл заклинаний персонажа, иначе 8 + бонус мастерства */
export function dcOf(item) {
    const activity = item?.system?.activities?.contents?.[0];
    const value = Number(activity?.save?.dc?.value);
    if (value) return value;
    const actor = item?.actor;
    return Number(actor?.system?.attributes?.spell?.dc) || 8 + (Number(actor?.system?.attributes?.prof) || 2);
}

/** Размер области навыка (футы): шаблон активности на ранге */
export const areaOf = (item, fallback) => Number(item?.system?.activities?.contents?.[0]?.target?.template?.size) || fallback;

/** Существа сцены в радиусе (футы) от токена-источника: по клеткам, от края до края */
export function around(source, feet, { except = [] } = {}) {
    const reach = Math.max(0, feet - (source.parent.grid.distance || 5));
    return source.parent.tokens.filter(t => t.actor && !t.hidden && !except.includes(t.id) && t.id !== source.id && feetBetween(source, t) <= reach);
}

/** Существа, чей центр в радиусе (пиксели) от точки */
export function inCircle(scene, point, radius) {
    return scene.tokens.filter(t => {
        if (!t.actor || t.hidden) return false;
        const c = centerOf(t);
        return Math.hypot(c.x - point.x, c.y - point.y) <= radius;
    });
}

export const isDead = actor => (Number(actor?.system?.attributes?.hp?.value) || 0) <= 0;

/**
 * Взрыв — как у способностей dnd5e: модуль не бросает и не применяет урон сам. Карточка в чате: кто
 * задет, кнопка спасброска (бросают цели) и кнопка урона (бросает игрок), Мастер применяет урон лотком
 * dnd5e — защиты цели считает dnd5e, успех спасброска — множитель ½ в лотке. splash — осколки (половина
 * без спасброска), self — владельцу половина. lead — подпись задетых вместо «Без спасброска». onFail — эффект на провале спасброска: модуль ждёт
 * спасбросок каждой задетой цели и накладывает его сам (expectSave).
 * @returns {Promise<{ victims: TokenDocument[], message: ChatMessage }>}
 */
export async function blast({ actor, title, icon = 'fa-burst', victims = [], splash = [], formula, type = 'fire', ability = null, dc = null, half = true, self = null, at = null, note = '', onFail = null, flags = {}, lead = null }) {
    if (at) boom(at);
    const names = list => esc(list.map(t => t.name).join(', '));
    const lines = [];
    if (victims.length) lines.push(`<li>${ability ? t('Спасбросок {v} Сл {dc}{v2}', { v: ABILITY[ability] ?? ability, dc, v2: half ? t(' — успех: половина урона') : t(' — успех: без урона') }) : (lead ?? t('Без спасброска'))}: ${names(victims)}</li>`);
    if (splash.length) lines.push(`<li>${t('Осколки — половина урона без спасброска: {v}', { v: names(splash) })}</li>`);
    if (self) lines.push(`<li>${t('{v} — половина урона без спасброска', { v: esc(self.name) })}</li>`);
    const buttons = [ability && victims.length ? `[[/save ${ability} ${dc}]]` : '', `[[/damage ${formula} ${type}]]`].filter(Boolean).join(' ');
    const TextEditor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    const content = await TextEditor.enrichHTML(`<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas ${icon}"></i> ${esc(title)}</div>
        ${note ? `<p>${note}</p>` : ''}<ul class="gd-blast-list">${lines.join('') || t('<li>Никого не задело.</li>')}</ul>
        <p class="gd-blast-rolls">${buttons}</p><p class="gd-blast-hint">${t('Урон {v} применяет Мастер лотком под броском.', { v: DAMAGE[type] ?? type })}</p></div>`, { rollData: actor?.getRollData?.() ?? {} });
    const message = await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }), content,
        flags: { [MODULE_ID]: { blastCard: {
            victims: victims.map(t => t.id), splash: splash.map(t => t.id), self: self?.id ?? null,
            sceneId: victims[0]?.parent?.id ?? splash[0]?.parent?.id ?? at?.sceneId ?? canvas?.scene?.id ?? null,
            formula, type, ability, dc, half, ...flags
        } } }
    });
    if (onFail && ability) await expectSave(victims, { ability, dc, ...onFail });
    return { victims, message };
}

// ==========================================
// ОЖИДАНИЕ СПАСБРОСКА: эффект на провале
// ==========================================

const SAVE_FLAG = 'pendingSave';

/**
 * Цели бросят спасбросок сами (кнопкой в карточке); на провале модуль накладывает эффект.
 * @param {TokenDocument[]} tokens
 * @param {object} o { ability, dc, status, effect, until } — status: id состояния dnd5e (prone…);
 *   effect: данные эффекта; until: 'thisTurn' | 'nextTurn' | 'nextStart' — эффект на ход в бою
 */
export async function expectSave(tokens, { ability, dc, status = null, effect = null, until = null }) {
    for (const token of tokens) {
        if (!token?.actor) continue;
        await token.actor.setFlag(MODULE_ID, SAVE_FLAG, { ability, dc, status, effect, until, tokenId: token.id, sceneId: token.parent?.id ?? null });
    }
}

// Спасбросок цели с ожиданием — у того клиента, где брошен; решает Мастер
Hooks.on('dnd5e.rollSavingThrow', (rolls, data) => {
    const actor = data?.subject;
    const pending = actor?.getFlag?.(MODULE_ID, SAVE_FLAG);
    if (!pending || data.ability !== pending.ability) return;
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if (roll) requestGM('blastSaveResult', { actorUuid: actor.uuid, total: roll.total });
});

onSocket('blastSaveResult', ({ payload }) => {
    if (isActiveGM()) settleSave(payload).catch(error => console.error(`${MODULE_ID} | спасбросок`, error));
});

export async function settleSave({ actorUuid, total }) {
    const actor = await fromUuid(actorUuid);
    const pending = actor?.getFlag(MODULE_ID, SAVE_FLAG);
    if (!pending) return;
    await actor.unsetFlag(MODULE_ID, SAVE_FLAG);
    if (total >= pending.dc) return;
    if (pending.status && !actor.statuses?.has(pending.status)) await actor.toggleStatusEffect(pending.status, { active: true });
    if (pending.effect) {
        const combat = game.combat?.started ? game.combat : null;
        if (combat && pending.until) {
            const { addTurnEffect } = await import("../turn-effects.js");
            await addTurnEffect(actor, combat, pending.effect, { until: pending.until, tokenId: pending.tokenId });
        } else await actor.createEmbeddedDocuments('ActiveEffect', [{ showIcon: 2, ...pending.effect }]);
    }
}

// Карточка навыка огня и взрыва: кнопки броска dnd5e прячутся — урон и спасбросок придут карточкой
// события модуля (взрыв картошки, бочки, газа…), когда он случится
const ROLL_BUTTONS = '[data-action="rollDamage"], [data-action="rollSave"], [data-action="rollAttack"], [data-action="placeTemplate"]';
onRenderChatMessage((message, html) => {
    if (!html?.querySelectorAll) return;
    const item = messageItem(message);
    if (!blastKind(item)) return;
    html.querySelectorAll(ROLL_BUTTONS).forEach(b => b.remove());
});

/** Вспышка взрыва у всех: { sceneId, x, y, radius (пиксели), color } */
export function boom(data) {
    emit('blastBoom', data);
    showBoom(data);
}
onSocket('blastBoom', data => showBoom(data));

export function showBoom({ sceneId, x, y, radius, color = 0xff7a1a }) {
    if (!canvas?.ready || canvas.scene?.id !== sceneId) return;
    const g = new PIXI.Graphics();
    g.eventMode = 'none';
    (canvas.interface ?? canvas.controls).addChild(g);
    const start = performance.now(), duration = 750;
    const tick = () => {
        const k = (performance.now() - start) / duration;
        if (k >= 1 || g.destroyed) { canvas.app.ticker.remove(tick); if (!g.destroyed) g.destroy(); return; }
        const r = radius * (0.25 + 0.75 * Math.sqrt(k));
        g.clear();
        g.beginFill(0xfff1c4, Math.max(0, 0.7 - k * 1.4)).drawCircle(x, y, r * 0.6).endFill();
        g.beginFill(color, 0.45 * (1 - k)).drawCircle(x, y, r).endFill();
        g.lineStyle(canvas.grid.size * 0.12, color, 1 - k).drawCircle(x, y, r);
    };
    canvas.app.ticker.add(tick);
}

/** Взрыв с центром в токене: точка для вспышки */
export const boomAt = (token, feet) => ({ sceneId: token.parent.id, ...centerOf(token), radius: feet / (token.parent.grid.distance || 5) * token.parent.grid.size });
