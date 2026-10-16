/**
 * Gacha Roguelike dnd5e — Навыки огня и взрыва: общее
 *
 * Навык — флаг blast: <вид> (fine, lava, blade, phoenix, potato, hiss, barrel, corpse, gas, ohyeah).
 * Каждый вид — свой файл в этой папке. Здесь: поиск навыка, формула урона и Сл активности,
 * подавление штатной карточки dnd5e, взрыв (урон один раз, спасброски каждого, защиты целей
 * считает dnd5e, итог — одна карточка) и вспышка взрыва на сцене у всех.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { emit, onSocket } from "../../../core/socket.js";
import { feetBetween } from "../light/flash.js";
import { esc, centerOf } from "../light/common.js";

export { ref, actorFrom, tokenOf, esc, centerOf, feetToPx } from "../light/common.js";
export { feetBetween };

export const blastKind = item => item?.flags?.[MODULE_ID]?.blast ?? null;
export const isBlast = (item, kind) => blastKind(item) === kind && !item.flags[MODULE_ID].is_crystal_item;
/** Экипированный навык этого вида у персонажа */
export const blastSkill = (actor, kind) => actor?.items?.find(i => isBlast(i, kind) && i.flags[MODULE_ID].is_active) ?? null;

const ABILITY = { str: 'Силы', dex: 'Ловкости', con: 'Телосложения', int: 'Интеллекта', wis: 'Мудрости', cha: 'Харизмы' };
const DAMAGE = { fire: 'огнём', thunder: 'звуком', bludgeoning: 'дробящий', poison: 'ядом', force: 'силовым полем' };

/** Без штатной карточки и шаблона dnd5e: навык разрешает себя сам */
export function quiet(usage, message) {
    if (usage) usage.create = { ...(usage.create ?? {}), measuredTemplate: false };
    if (message) message.create = false;
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

const hpOf = actor => {
    const hp = actor?.system?.attributes?.hp ?? {};
    return (Number(hp.value) || 0) + (Number(hp.temp) || 0);
};
export const isDead = actor => (Number(actor?.system?.attributes?.hp?.value) || 0) <= 0;

/**
 * Взрыв: урон бросается один раз, каждый задетый — спасбросок (если есть), урон применяет dnd5e
 * (сопротивления и иммунитеты цели); splash — половина без спасброска, self — половина владельцу.
 * Итог — одна карточка в чате.
 * @returns {Promise<{ total: number, rows: object[], killed: TokenDocument[] }>}
 */
export async function blast({ actor, title, icon = 'fa-burst', victims, splash = [], formula, type = 'fire', ability = null, dc = null, half = true, self = null, at = null, note = '', extra = null }) {
    const roll = await new Roll(formula).evaluate();
    game.dice3d?.showForRoll?.(roll, game.user, true);
    const rows = [], killed = [];
    for (const token of victims) {
        const target = token.actor;
        if (!target) continue;
        let value = roll.total, save = null;
        if (ability) {
            const rolls = await target.rollSavingThrow({ ability, target: dc }, { configure: false }, { create: false });
            const r = Array.isArray(rolls) ? rolls[0] : rolls;
            const success = r ? (r.isSuccess ?? r.total >= dc) : false;
            save = { total: r?.total ?? '—', success };
            if (success) value = half ? Math.floor(value / 2) : 0;
        }
        const before = hpOf(target), alive = !isDead(target);
        if (value > 0) await target.applyDamage([{ value, type }]);
        if (extra) await extra(token, { save, value });
        rows.push({ name: token.name, save, lost: before - hpOf(target) });
        if (alive && isDead(target)) killed.push(token);
    }
    // Осколки: половина урона без спасброска
    for (const token of splash) {
        const target = token.actor;
        if (!target) continue;
        const before = hpOf(target), alive = !isDead(target);
        const value = Math.floor(roll.total / 2);
        if (value > 0) await target.applyDamage([{ value, type }]);
        rows.push({ name: `${token.name} (осколки)`, save: null, lost: before - hpOf(target) });
        if (alive && isDead(target)) killed.push(token);
    }
    let selfRow = '';
    if (self) {
        const value = Math.floor(roll.total / 2);
        const before = hpOf(self);
        if (value > 0) await self.applyDamage([{ value, type }]);
        selfRow = `<li>${esc(self.name)} — половина без спасброска: −${before - hpOf(self)}</li>`;
    }
    if (at) boom(at);
    const list = rows.map(r => `<li>${esc(r.name)}${r.save ? ` — спасбросок ${r.save.total}: ${r.save.success ? 'успех' : 'провал'}` : ''} — <strong>−${r.lost}</strong></li>`).join('');
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas ${icon}"></i> ${esc(title)}</div>
            <p>Урон: <strong>${roll.total}</strong> (${esc(formula)}) ${DAMAGE[type] ?? type}${ability ? `, спасбросок ${ABILITY[ability] ?? ability} Сл ${dc}${half ? ' — успех вдвое меньше' : ''}` : ''}.</p>
            ${note ? `<p>${note}</p>` : ''}<ul class="gd-blast-list">${list || '<li>Никого не задело.</li>'}${selfRow}</ul></div>`
    });
    return { total: roll.total, rows, killed };
}

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
