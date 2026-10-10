/**
 * Gacha Roguelike dnd5e — Пульс отряда
 *
 * Подсказка Мастеру по сложности боёв, как ИИ-директор в Left 4 Dead: модуль записывает, как прошёл каждый
 * бой (раунды, самые низкие ПЗ отряда, падения до 0), и советует ступень следующего боя по бюджету опыта
 * DMG 2024. Добычу Пульс не трогает никогда. Видит его только Мастер: подвал карты и шёпот после боя.
 *
 *   Легко   — бой занял не больше 2 раундов и никто не опускался ниже половины ПЗ.
 *   Тяжело  — кто-то падал до 0 ПЗ, или бой длился дольше 5 раундов и кто-то опускался ниже четверти ПЗ.
 *   Ровно   — всё остальное.
 * Два «легко» подряд поднимают ступень на одну (до +2), «тяжело» опускает (до −1). Привал и новый этаж
 * возвращают ступень к базовой.
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM } from "../core/socket.js";
import { partyActors } from "./horsemen.js";

const STEPS = ['низкий', 'умеренный', 'высокий', 'высокий+', 'высокий++'];
// Базовая ступень узла: индекс в STEPS
const BASE = { mob: 1, elite: 2, outpost: 2, boss: 3 };
const RESULTS = {
    easy: { label: 'легко', color: '#4fae5a' },
    even: { label: 'ровно', color: '#8c8275' },
    hard: { label: 'тяжело', color: '#c0392b' }
};
const EMPTY = { offset: 0, easyStreak: 0, last: null };

export function registerPulseSettings() {
    game.settings.register(MODULE_ID, 'pulse', {
        scope: 'world', config: false, type: Object, default: EMPTY,
        onChange: () => {
            const app = foundry.applications.instances?.get('gachadnd-map-terminal');
            if (app?.rendered && game.user.isGM) app.render({ parts: ['footer'] });
        }
    });
}

const getPulse = () => ({ ...EMPTY, ...(game.settings.get(MODULE_ID, 'pulse') ?? {}) });

/** Ступень боя для узла с учётом Пульса */
export function pulseStep(type, pulse = getPulse()) {
    const base = BASE[type] ?? BASE.mob;
    return STEPS[Math.max(0, Math.min(STEPS.length - 1, base + pulse.offset))];
}

/** Строка для подвала карты Мастера */
export function pulseView() {
    const pulse = getPulse();
    const last = pulse.last ? RESULTS[pulse.last.result] : null;
    const shift = pulse.offset > 0 ? `+${pulse.offset}` : String(pulse.offset);
    return {
        last: last ? `${last.label}${pulse.easyStreak > 1 ? ` ×${pulse.easyStreak}` : ''}` : 'боёв не было',
        color: last?.color ?? '#8c8275',
        shift: pulse.offset ? `ступень ${shift}` : 'базовая ступень',
        mob: pulseStep('mob', pulse), elite: pulseStep('elite', pulse), boss: pulseStep('boss', pulse),
        detail: pulse.last ? `Последний бой: ${pulse.last.rounds} р., минимум ПЗ ${Math.round(pulse.last.minHp * 100)} %, падений ${pulse.last.downs}` : ''
    };
}

/** Привал и новый этаж возвращают ступень к базовой */
export async function resetPulse() {
    if (!game.user.isGM) return;
    const pulse = getPulse();
    if (pulse.offset || pulse.easyStreak) await game.settings.set(MODULE_ID, 'pulse', { ...pulse, offset: 0, easyStreak: 0 });
}

// ==========================================
// УЧЁТ БОЯ (активный Мастер)
// ==========================================

const isParty = actor => actor?.type === 'character' && actor.hasPlayerOwner;
const hpShare = actor => {
    const hp = actor.system.attributes?.hp;
    return hp?.max ? Math.max(0, hp.value) / hp.max : 1;
};

// Самые низкие ПЗ и падения за бой — во флаге боя: переживают перезагрузку Мастера
Hooks.on('updateActor', async (actor, changes) => {
    if (!isActiveGM() || !isParty(actor) || !foundry.utils.hasProperty(changes, 'system.attributes.hp.value')) return;
    const combat = game.combats?.find(c => c.started && c.combatants.some(cb => cb.actor?.id === actor.id));
    if (!combat) return;
    const track = { minHp: 1, downs: 0, ...(combat.getFlag(MODULE_ID, 'pulse') ?? {}) };
    const share = hpShare(actor);
    const next = { minHp: Math.min(track.minHp, share), downs: track.downs + (share <= 0 ? 1 : 0) };
    if (next.minHp !== track.minHp || next.downs !== track.downs) await combat.setFlag(MODULE_ID, 'pulse', next);
});

Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM() || !combat.started || (combat.round ?? 0) < 1) return;
    const actors = combat.combatants.map(cb => cb.actor).filter(Boolean);
    const party = actors.filter(isParty);
    const hostile = combat.combatants.some(cb => cb.token?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE);
    if (!party.length || !hostile) return;

    const track = { minHp: 1, downs: 0, ...(combat.getFlag(MODULE_ID, 'pulse') ?? {}) };
    const minHp = Math.min(track.minHp, ...party.map(hpShare));
    const { downs } = track;
    const rounds = combat.round;
    const result = downs > 0 || (rounds > 5 && minHp < 0.25) ? 'hard'
        : rounds <= 2 && minHp >= 0.5 ? 'easy' : 'even';

    const pulse = getPulse();
    let { offset, easyStreak } = pulse;
    if (result === 'easy') {
        easyStreak += 1;
        if (easyStreak >= 2) { offset = Math.min(2, offset + 1); easyStreak = 0; }
    } else {
        easyStreak = 0;
        if (result === 'hard') offset = Math.max(-1, offset - 1);
    }
    const updated = { offset, easyStreak, last: { result, rounds, minHp, downs } };
    await game.settings.set(MODULE_ID, 'pulse', updated);

    const view = pulseView();
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Пульс отряда' }),
        whisper: ChatMessage.getWhisperRecipients('GM').map(u => u.id),
        content: `<div class="gd-scent-chat"><i class="fas fa-heart-pulse"></i> Бой — <strong style="color: ${RESULTS[result].color}">${RESULTS[result].label}</strong>: ${rounds} р., минимум ПЗ ${Math.round(minHp * 100)} %, падений ${downs}.<br>Следующий бой (${view.shift}): Монстры — ${view.mob}, Элита и Застава — ${view.elite}, Босс — ${view.boss}.</div>`
    });
});

// Состояние Пульса и ПЗ отряда — для проверки в консоли: game.gachadnd.pulse()
export function pulseReport() {
    return { ...getPulse(), party: partyActors().map(a => `${a.name} ${Math.round(hpShare(a) * 100)} %`) };
}
