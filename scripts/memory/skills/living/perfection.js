/**
 * Gacha Roguelike dnd5e — Само совершенство (красный навык разума, docs/perfection.md)
 *
 * В бою — огранка из семи штрихов. Действие нового для боя вида зажигает штрих: удар, чары, навык Памяти, манёвр,
 * помощь, приём, окружение. Удар, чары, навык Памяти, расходник и лечение союзника модуль отмечает сам (у того,
 * кто использует, — хук dnd5e); остальное — кнопкой в окне огранки (использование навыка). Ход без нового штриха —
 * «Небрежно»: последний гаснет (кроме хода, когда герой не мог действовать). Пять — «Почти»: +1 к броскам атаки,
 * проверкам и спасброскам. Семь — «Само совершенство»: до конца следующего хода владельца к20 не ниже 10, потом
 * огранка гаснет целиком. Конец боя — гаснет.
 *
 * Состояние — на навыке: strokes [ид], counter (число — значок у токена, badges.js), turnLit (штрих в этот ход),
 * perfect { combatId, round, combatantId } — до конца какого хода горит совершенство. Ход и бой ведёт Мастер.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { requestGM, onSocket, isActiveGM } from "../../../core/socket.js";
import { isMemorySkill } from "../../synergy/synergy.js";
import { livingSkill, note, esc } from "./common.js";
import { t } from "../../../core/i18n.js";

const KIND = 'perfection';
export const STROKES = [
    { id: 'strike', name: t('Удар'), icon: 'fa-hand-fist', hint: t('атака оружием или безоружная'), auto: true },
    { id: 'spell', name: t('Чары'), icon: 'fa-wand-sparkles', hint: t('заклинание или заговор'), auto: true },
    { id: 'memory', name: t('Память'), icon: 'fa-brain', hint: t('навык Памяти или связка'), auto: true },
    { id: 'move', name: t('Манёвр'), icon: 'fa-person-running', hint: t('Рывок, Отход или Уклонение') },
    { id: 'help', name: t('Помощь'), icon: 'fa-handshake-angle', hint: t('Помощь, лечение или защита союзника') },
    { id: 'trick', name: t('Приём'), icon: 'fa-hand-back-fist', hint: t('толчок, захват, обезоруживание, подножка') },
    { id: 'prop', name: t('Окружение'), icon: 'fa-flask', hint: t('предмет, зелье, бочка, рычаг, дверь') }
];
export const ALMOST = 5;
const ALL = STROKES.length;
const MIN_D20 = 10;
// Не мог действовать — «Небрежно» не считается
const HELPLESS = ['dead', 'unconscious', 'incapacitated', 'paralyzed', 'petrified', 'stunned'];

const flags = item => item?.flags?.[MODULE_ID] ?? {};
export const strokesOf = item => flags(item).strokes ?? [];
export const perfectOf = item => flags(item).perfect ?? null;
export const isPerfection = item => flags(item).living === KIND && !flags(item).is_crystal_item;
/** Бой, в котором участвует персонаж и который начат */
const combatOf = actor => game.combats?.find(c => c.started && c.combatants.some(x => x.actor?.id === actor?.id)) ?? null;
const isTurnOf = (combat, actor) => combat?.combatant?.actor?.id === actor?.id;

// ==========================================
// ШТРИХИ (пишет Мастер: зажечь, погасить, совершенство, конец)
// ==========================================

async function save(item, data) {
    const next = { ...data };
    if ('strokes' in next) next.counter = next.strokes.length;
    await item.update(Object.fromEntries(Object.entries(next).map(([k, v]) => [`flags.${MODULE_ID}.${k}`, v])));
    await syncAlmost(item.actor, item);
}

/** Мастер: зажечь штрих (или погасить, если on === false) */
async function gmLight(item, id, { on = true, by = 'auto' } = {}) {
    const stroke = STROKES.find(s => s.id === id);
    const actor = item?.actor, combat = combatOf(actor);
    if (!stroke || !combat) return;
    const strokes = strokesOf(item);
    if (!on) {
        if (!strokes.includes(id)) return;
        return save(item, { strokes: strokes.filter(s => s !== id) });
    }
    if (strokes.includes(id) || perfectOf(item)) return;
    const next = [...strokes, id];
    const turnLit = isTurnOf(combat, actor) ? true : !!flags(item).turnLit;
    await save(item, { strokes: next, turnLit });
    await note(actor, `${item.name}: ${stroke.name}`, `<p>${t('Штрих {length} из {ALL}{v}.{v2}', { length: next.length, ALL, v: by === 'gm' ? t(' — отметил Мастер') : '', v2: next.length === ALMOST ? t(' <strong>Почти</strong> — +1 к броскам атаки, проверкам и спасброскам.') : '' })}</p>`, stroke.icon);
    if (next.length >= ALL) {
        await save(item, { perfect: { combatId: combat.id, round: combat.round, combatantId: combat.combatant?.actor?.id === actor.id ? combat.combatant.id : null } });
        await note(actor, t('Само совершенство'), `<p>${t('Все семь штрихов. До конца следующего хода {v} — к20 не ниже {MIN_D20}. Потом огранка погаснет, и всё по новой.', { v: esc(actor.name), MIN_D20 })}</p>`, 'fa-gem');
    }
}

onSocket('perfectionLight', ({ payload }) => {
    if (!isActiveGM()) return;
    const item = game.actors.get(payload.actorId)?.items.get(payload.itemId);
    if (item) gmLight(item, payload.id, payload).catch(error => console.error(`${MODULE_ID} | Само совершенство`, error));
});
/** Зажечь штрих: Мастер — сразу, игрок — просьбой Мастеру */
export const light = (item, id, options = {}) => requestGM('perfectionLight', { actorId: item.actor?.id, itemId: item.id, id, ...options });

// ---------- «Почти»: +1 к броскам, пока горят пять и больше

const attackBonus = value => ['mwak', 'rwak', 'msak', 'rsak'].map(k => ({ key: `system.bonuses.${k}.attack`, mode: 2, value }));
// По очереди на персонажа: две записи подряд иначе обе снимают один эффект — «does not exist»
const queues = new Map();
function syncAlmost(actor, item) {
    if (!actor) return;
    const run = (queues.get(actor.id) ?? Promise.resolve()).then(() => applyAlmost(actor, item)).catch(error => console.error(`${MODULE_ID} | Само совершенство`, error));
    queues.set(actor.id, run);
    return run;
}
async function applyAlmost(actor, item) {
    item = actor.items.get(item.id) ?? item;
    const on = strokesOf(item).length >= ALMOST;
    const effects = [...actor.effects].filter(e => e.flags?.[MODULE_ID]?.perfectionAlmost);
    if (on && !effects.length) {
        await actor.createEmbeddedDocuments('ActiveEffect', [{
            name: t('Почти совершенство'), img: 'icons/svg/aura.svg', showIcon: 2,
            changes: [...attackBonus('+1'), { key: 'system.bonuses.abilities.check', mode: 2, value: '+1' }, { key: 'system.bonuses.abilities.save', mode: 2, value: '+1' }],
            description: t('+1 к броскам атаки, проверкам и спасброскам.'), flags: { [MODULE_ID]: { perfectionAlmost: true } }
        }]);
    } else if (!on && effects.length) {
        await actor.deleteEmbeddedDocuments('ActiveEffect', effects.map(e => e.id));
    }
}

// ==========================================
// ХОДЫ: НЕБРЕЖНО, КОНЕЦ СОВЕРШЕНСТВА, КОНЕЦ БОЯ
// ==========================================

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const prev = combat.previous?.combatantId ? combat.combatants.get(combat.previous.combatantId) : null;
    const actor = prev?.actor;
    const item = actor ? livingSkill(actor, KIND) : null;
    if (!item) return;
    try {
        const perfect = perfectOf(item);
        if (perfect) {
            // Совершенство горит до конца следующего хода владельца: ход, в котором оно пришло, — не в счёт
            // (пришло не в свой ход — следующий свой ход и есть последний)
            const sameTurn = perfect.combatantId === prev.id && perfect.round === combat.previous.round;
            if (sameTurn && !perfect.ended) return save(item, { perfect: { ...perfect, ended: true }, turnLit: false });
            await save(item, { strokes: [], perfect: null, turnLit: false });
            return note(actor, t('Всё по новой'), t('<p>Совершенство погасло — огранка пуста.</p>'), 'fa-rotate-left');
        }
        const strokes = strokesOf(item);
        const helpless = HELPLESS.some(s => actor.statuses?.has(s)) || (Number(actor.system?.attributes?.hp?.value) || 0) <= 0;
        if (!flags(item).turnLit && strokes.length && !helpless) {
            const gone = STROKES.find(s => s.id === strokes.at(-1));
            await save(item, { strokes: strokes.slice(0, -1), turnLit: false });
            return note(actor, t('Небрежно'), `<p>${t('Ход без нового штриха — погас «{name}». Осталось {v} из {ALL}.', { name: gone?.name, v: strokes.length - 1, ALL })}</p>`, 'fa-face-meh');
        }
        if (flags(item).turnLit) await save(item, { turnLit: false });
    } catch (error) {
        console.error(`${MODULE_ID} | Само совершенство`, error);
    }
});

Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    for (const c of combat.combatants) {
        const item = c.actor ? c.actor.items.find(i => isPerfection(i) && (strokesOf(i).length || perfectOf(i))) : null;
        if (item) await save(item, { strokes: [], perfect: null, turnLit: false }).catch(error => console.error(`${MODULE_ID} | Само совершенство`, error));
    }
});

// ==========================================
// САМИ: УДАР, ЧАРЫ, ПАМЯТЬ, ОКРУЖЕНИЕ, ПОМОЩЬ
// ==========================================

/** Какой штрих даёт использование активности (или null) */
export function strokeOf(activity) {
    const item = activity?.item;
    if (!item || isPerfection(item)) return null;
    if (item.type === 'spell') return 'spell';
    if (isMemorySkill(item)) return 'memory';
    if (activity.type === 'attack' && (activity.attack?.type?.classification ?? (item.type === 'weapon' ? 'weapon' : '')) !== 'spell') return 'strike';
    if (item.type === 'consumable') return 'prop';
    // Лечение союзника: активность лечения, цель — не сам
    const targets = [...(game.user.targets ?? [])].map(t => t.actor).filter(Boolean);
    if (activity.type === 'heal' && targets.some(t => t.id !== item.actor?.id)) return 'help';
    return null;
}

Hooks.on('dnd5e.postUseActivity', activity => {
    const actor = activity?.item?.actor;
    if (!actor?.isOwner || isPerfection(activity.item)) return;
    // Использует владелец — пишет он; Мастер за персонажа игрока — тоже он
    const item = livingSkill(actor, KIND);
    const id = item && combatOf(actor) ? strokeOf(activity) : null;
    if (id && !strokesOf(item).includes(id)) light(item, id);
});

// ==========================================
// К20 НЕ НИЖЕ 10
// ==========================================

const subjectActor = subject => subject?.documentName === 'Actor' || typeof subject?.getActiveTokens === 'function' ? subject : (subject?.actor ?? subject?.item?.actor ?? null);
Hooks.on('dnd5e.preRollD20TestV2', config => {
    const actor = subjectActor(config?.subject);
    const item = actor ? livingSkill(actor, KIND) : null;
    if (!item || !perfectOf(item)) return;
    for (const roll of (config.rolls ??= [{}])) {
        roll.options ??= {};
        roll.options.minimum = Math.max(MIN_D20, Number(roll.options.minimum) || 0);
    }
});

// ==========================================
// ОКНО ОГРАНКИ: использование навыка
// ==========================================

export async function openFacets(item) {
    const actor = item.actor, lit = strokesOf(item), gm = game.user.isGM;
    const inCombat = !!combatOf(actor);
    const rows = STROKES.map(s => {
        const on = lit.includes(s.id);
        const can = gm || (!s.auto && !on && inCombat && !perfectOf(item));
        return `<li class="${on ? 'on' : ''}"><i class="fas ${s.icon}"></i> <strong>${s.name}</strong> <small>${s.hint}${s.auto && !gm ? t(' — сам') : ''}</small>
            ${can ? `<button type="button" data-stroke="${s.id}" data-on="${on ? 0 : 1}">${on ? t('Погасить') : t('Зажечь')}</button>` : ''}</li>`;
    }).join('');
    const state = perfectOf(item) ? `<p class="gd-perfection-state"><strong>${t('Само совершенство')}</strong> ${t('— к20 не ниже {MIN_D20} до конца следующего хода.', { MIN_D20 })}</p>`
        : `<p class="gd-perfection-state">${t('{length} из {ALL}{v}.{v2}', { length: lit.length, ALL, v: lit.length >= ALMOST ? t(' — <strong>Почти</strong>: +1 к броскам') : '', v2: inCombat ? '' : t(' Штрихи горят только в бою.') })}</p>`;
    const dialog = new foundry.applications.api.DialogV2({
        window: { title: `${item.name} — ${actor.name}`, icon: 'fas fa-gem' },
        content: `<div class="gd-perfection">${state}<ul class="gd-perfection-strokes">${rows}</ul><p class="gd-perfection-note">${t('Ход без нового штриха — «Небрежно»: последний гаснет.')}</p></div>`,
        buttons: [{ action: 'close', label: t('Закрыть'), default: true }]
    });
    await dialog.render({ force: true });
    dialog.element.querySelectorAll('[data-stroke]').forEach(b => b.addEventListener('click', async () => {
        await light(item, b.dataset.stroke, { on: b.dataset.on === '1', by: gm ? 'gm' : 'player' });
        dialog.close();
    }));
    return dialog;
}

// Использование навыка — окно огранки, без карточки и без траты действия
Hooks.on('dnd5e.preUseActivity', activity => {
    if (!isPerfection(activity?.item)) return;
    openFacets(activity.item);
    return false;
});
