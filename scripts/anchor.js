/**
 * Gacha Roguelike dnd5e — Якорь и Запах
 *
 * Якорь — хаб в Пределе: в начале сессии Мастер открывает его кнопкой на панели токенов. В Якоре
 * открыт Алтарь Памяти (через точку расширения queryRest), но это не Привал: Кости Хитов не
 * восстанавливаются, короткого отдыха нет. Якорь закрывается той же кнопкой или первым шагом по карте.
 *
 * Запах — сколько кристаллов несёт отряд; по нему Пожиратель находит добычу (правила — «Пожиратель»
 * в Справочнике Мастера). Мастер видит Запах в карте этажа и шёпотом при входе на узел, игроки — только
 * строку атмосферы.
 */

import { MODULE_ID } from "./constants.js";
import { HOOKS, notifyRestChanged } from "./memory-api.js";
import { announceRest } from "./memory-altar.js";
import { partyActors } from "./horsemen.js";
import { getFloor } from "./economy.js";
import { isCrystalItem } from "./inventory.js";
import { isMemorySkill, occupiesSlot, naturalSlotCap } from "./synergy.js";

// ==========================================
// ЗАПАХ
// ==========================================

const SCENT_WEIGHT = { gray: 1, green: 1, blue: 2, purple: 3, red: 5, orange: 5 };
const OVERLOAD_SCENT = 2;
// Узлы, на которые Пожиратель прорывается во время Охоты
const BREACH_NODES = ['mob', 'elite', 'event', 'rest'];

export const SCENT_STATES = {
    silence: { label: 'Тишина', color: '#7f8c8d', icon: 'fa-wind' },
    whisper: { label: 'Шёпот', color: '#d4a64a', icon: 'fa-ear-listen' },
    hunt: { label: 'Охота', color: '#ff4d4d', icon: 'fa-paw' }
};

/** Пороги Запаха этажа: Шёпот от 4 + 2Э, Охота от 6 + 3Э */
export function scentThresholds(floor = getFloor()) {
    return { whisper: 4 + 2 * floor, hunt: 6 + 3 * floor };
}

/** Запах одного персонажа: кристаллы в инвентаре и слоты перегрузки. Навыки в Памяти не пахнут */
export function actorScent(actor) {
    let crystals = 0;
    for (const item of actor.items) {
        if (!isCrystalItem(item)) continue;
        const rarity = item.flags?.[MODULE_ID]?.rarity ?? 'gray';
        crystals += (SCENT_WEIGHT[rarity] ?? 1) * Math.max(0, Number(item.system?.quantity ?? 1));
    }
    const active = actor.items.filter(i => isMemorySkill(i) && i.flags[MODULE_ID]?.is_active && occupiesSlot(i)).length;
    const overload = Math.max(0, active - naturalSlotCap(actor));
    return { crystals, overload, value: crystals + OVERLOAD_SCENT * overload };
}

/** Запах отряда и его состояние на текущем этаже */
export function partyScent(actors = partyActors(), floor = getFloor()) {
    const members = actors.map(actor => ({ name: actor.name, ...actorScent(actor) }));
    const value = members.reduce((sum, m) => sum + m.value, 0);
    const thresholds = scentThresholds(floor);
    const state = value >= thresholds.hunt ? 'hunt' : value >= thresholds.whisper ? 'whisper' : 'silence';
    return { value, state, ...SCENT_STATES[state], thresholds, floor, members };
}

// Строки для игроков: ни чисел, ни порогов — только то, что чувствуют персонажи
const ATMOSPHERE = {
    whisper: 'Туман пахнет металлом. Кристаллы в сумках тихо гудят, и сквозь стены доносится: «ещё…»',
    hunt: 'Гул кристаллов срывается на дрожь. Где-то рядом рвётся ткань узла — что-то идёт по следу.'
};
const ANCHOR_ATMOSPHERE = {
    whisper: 'Под куполом тихо, но кристаллы в сумках гудят громче рун над головой.',
    hunt: 'За границей купола, среди голодных душ, что-то медленно ходит кругами.'
};

function scentReport(scent) {
    const members = scent.members.filter(m => m.value).map(m => `${m.name} ${m.value}${m.overload ? ` (перегрузка ${m.overload})` : ''}`).join(', ');
    return `<strong style="color: ${scent.color}">${scent.label}</strong> · Запах ${scent.value} (Шёпот от ${scent.thresholds.whisper}, Охота от ${scent.thresholds.hunt})${members ? `<br><small>${members}</small>` : ''}`;
}

function whisperGM(content) {
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Нюх Пожирателя' }),
        whisper: ChatMessage.getWhisperRecipients('GM').map(u => u.id),
        content: `<div class="gd-scent-chat">${content}</div>`
    });
}

function atmosphere(text) {
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Туман' }),
        content: `<div class="gd-scent-chat atmosphere"><i class="fas fa-wind"></i> <em>${text}</em></div>`
    });
}

/** Отряд вошёл на узел: Мастеру — Запах и можно ли здесь прорваться, игрокам — атмосфера */
export async function announceScent(nodeType) {
    if (!game.user.isGM) return;
    const scent = partyScent();
    if (scent.state === 'silence') return;
    let hint = '';
    if (scent.state === 'hunt') {
        hint = BREACH_NODES.includes(nodeType)
            ? '<br>Узел подходит: Пожиратель может прорваться (на узел Привала — до отдыха).'
            : '<br>Сюда он не входит — прорвётся на следующем подходящем узле.';
    }
    await whisperGM(scentReport(scent) + hint);
    await atmosphere(ATMOSPHERE[scent.state]);
}

// ==========================================
// ЯКОРЬ
// ==========================================

export function registerAnchorSettings() {
    game.settings.register(MODULE_ID, 'anchorOpen', {
        scope: 'world', config: false, type: Boolean, default: false,
        onChange: () => notifyRestChanged()
    });
}

export function isAnchorOpen() {
    try {
        return !!game.settings.get(MODULE_ID, 'anchorOpen');
    } catch (err) {
        return false;
    }
}

// Алтарь в Якоре открыт так же, как на Привале; подпись в Терминале — «Якорь»
Hooks.on(HOOKS.queryRest, state => {
    if (isAnchorOpen()) Object.assign(state, { atRest: true, site: 'anchor', label: 'Якорь' });
});

/** Открыть или закрыть Якорь (только Мастер). При открытии у игроков открывается Алтарь */
export async function setAnchor(open = true) {
    if (!game.user.isGM) return ui.notifications.warn('Открывать Якорь может только Мастер.');
    open = !!open;
    if (open === isAnchorOpen()) return;
    await game.settings.set(MODULE_ID, 'anchorOpen', open);
    if (!open) {
        return ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: 'Якорь' }),
            content: '<div class="gd-scent-chat"><i class="fas fa-anchor"></i> Отряд покидает купол Якоря. Голодные души смыкаются за спиной.</div>'
        });
    }
    announceRest();
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Якорь' }),
        content: '<div class="gd-scent-chat"><i class="fas fa-anchor"></i> Отряд в <strong>Якоре</strong>. Руны над куполом медленно вращаются; Алтарь Памяти открыт. Кости Хитов здесь не восстанавливаются.</div>'
    });
    const scent = partyScent();
    if (scent.state === 'silence') return;
    const hint = scent.state === 'hunt' ? '<br>Отряд выделяется на фоне купола: Пожиратель кружит у границы. Внутрь не входит.' : '';
    await whisperGM(scentReport(scent) + hint);
    await atmosphere(ANCHOR_ATMOSPHERE[scent.state]);
}

/** Первый шаг по карте уводит отряд из Якоря */
export async function leaveAnchor() {
    if (game.user.isGM && isAnchorOpen()) await setAnchor(false);
}
