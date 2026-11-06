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

import { MODULE_ID, CRYSTAL_WEIGHT } from "../core/constants.js";
import { hint as hintOn } from "../core/prefs.js";
import { mapScene, anchorScene, travelTo } from "./scene-travel.js";
import { HOOKS, notifyRestChanged } from "../memory/memory-api.js";
import { announceRest } from "../memory/altar/memory-altar.js";
import { partyActors } from "./horsemen.js";
import { getFloor } from "./economy.js";
import { isCrystalItem } from "../memory/inventory.js";
import { isMemorySkill, occupiesSlot, naturalSlotCap } from "../memory/synergy/synergy.js";
import { GraveyardWindow } from "./graveyard.js";
import { t } from "../core/i18n.js";

// ==========================================
// ЗАПАХ
// ==========================================

const OVERLOAD_SCENT = 2;
// Узлы, на которые Пожиратель прорывается во время Охоты
const BREACH_NODES = ['mob', 'elite', 'event', 'rest'];

export const SCENT_STATES = {
    silence: { label: t('Тишина'), color: '#7f8c8d', icon: 'fa-wind' },
    whisper: { label: t('Шёпот'), color: '#d4a64a', icon: 'fa-ear-listen' },
    hunt: { label: t('Охота'), color: '#ff4d4d', icon: 'fa-paw' }
};

/** Пороги Запаха этажа: Шёпот от 4 + 2Э, Охота от 6 + 3Э */
export function scentThresholds(floor = getFloor()) {
    return { whisper: 4 + 2 * floor, hunt: 6 + 3 * floor };
}

/** Вес кристалла — сколько вероятности он несёт: для Запаха и платы за портал */
export function crystalWeight(item) {
    return CRYSTAL_WEIGHT[item.flags?.[MODULE_ID]?.rarity ?? 'gray'] ?? 1;
}

/** Запах одного персонажа: кристаллы в инвентаре и слоты перегрузки. Навыки в Памяти не пахнут */
export function actorScent(actor) {
    let crystals = 0;
    for (const item of actor.items) {
        if (!isCrystalItem(item)) continue;
        crystals += crystalWeight(item) * Math.max(0, Number(item.system?.quantity ?? 1));
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
    whisper: t('Туман пахнет металлом. Кристаллы в сумках тихо гудят, и сквозь стены доносится: «ещё…»'),
    hunt: t('Гул кристаллов срывается на дрожь. Где-то рядом рвётся ткань узла — что-то идёт по следу.')
};
const ANCHOR_ATMOSPHERE = {
    whisper: t('Под куполом тихо, но кристаллы в сумках гудят громче рун над головой.'),
    hunt: t('За границей купола, среди голодных душ, что-то медленно ходит кругами.')
};

function scentReport(scent) {
    const members = scent.members.filter(m => m.value).map(m => `${m.name} ${m.value}${m.overload ? t(' (перегрузка {overload})', { overload: m.overload }) : ''}`).join(', ');
    return `<strong style="color: ${scent.color}">${scent.label}</strong> ${t('· Запах {value} (Шёпот от {whisper}, Охота от {hunt}){v}', { value: scent.value, whisper: scent.thresholds.whisper, hunt: scent.thresholds.hunt, v: members ? `<br><small>${members}</small>` : '' })}`;
}

function whisperGM(content) {
    if (!hintOn('hintScent')) return null;
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: t('Нюх Пожирателя') }),
        whisper: ChatMessage.getWhisperRecipients('GM').map(u => u.id),
        content: `<div class="gd-scent-chat">${content}</div>`
    });
}

function atmosphere(text) {
    if (!hintOn('hintAtmosphere')) return null;
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: t('Туман') }),
        content: `<div class="gd-scent-chat atmosphere"><i class="fas fa-wind"></i> <em>${text}</em></div>`
    });
}

/** Отряд вошёл на узел: Мастеру — Запах и можно ли здесь прорваться, игрокам — атмосфера */
export async function announceScent(nodeType, { web = false } = {}) {
    if (!game.user.isGM) return;
    const scent = partyScent();
    if (scent.state === 'silence') return;
    let hint = '';
    // Паутина: Пожиратель ходит по карте сам (web-map.js) — здесь только Запах и атмосфера
    if (web) {
        await whisperGM(scentReport(scent) + (scent.state === 'hunt' ? t('<br>Паутина: Пожиратель на карте идёт к отряду — скорость по Запаху.') : ''));
        return atmosphere(ATMOSPHERE[scent.state]);
    }
    // Жильцы Якоря (приманка) дописывают своё к прорыву: ctx.gm — Мастеру, ctx.players — атмосфера
    const ctx = { nodeType, breach: scent.state === 'hunt' && BREACH_NODES.includes(nodeType), gm: [], players: [], tasks: [] };
    if (scent.state === 'hunt') {
        hint = ctx.breach
            ? t('<br>Узел подходит: Пожиратель может прорваться (на узел Привала — до отдыха).')
            : t('<br>Сюда он не входит — прорвётся на следующем подходящем узле.');
        Hooks.callAll('gachadnd.huntBreach', ctx);
        await Promise.all(ctx.tasks);
    }
    await whisperGM(scentReport(scent) + hint + ctx.gm.join(''));
    await atmosphere(ctx.players[0] ?? ATMOSPHERE[scent.state]);
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

// В Лабиринте Алтарь открыт только в Якоре; подпись в Терминале — «Якорь»
Hooks.on(HOOKS.queryRest, state => {
    if (!isAnchorOpen()) return;
    Object.assign(state, { atRest: true, site: 'anchor', label: t('Якорь') });
    state.links.push({ label: t('Кладбище'), icon: 'fas fa-cross', title: t('Надгробия тех, чьи тела забрал Предел'), run: () => GraveyardWindow.open() });
    state.links.push({ label: t('Жильцы'), icon: 'fas fa-people-roof', title: t('Жильцы Якоря и их услуги'), run: () => game.gachadnd.openResidents() });
});

/**
 * Открыть или закрыть Якорь (только Мастер). При открытии у игроков открывается Алтарь.
 * Если выбрана сцена Якоря — отряд переносится на неё и обратно на сцену этажа сквозь туман Предела;
 * travel: false — переход уже сделала катсцена портала.
 */
export async function setAnchor(open = true, { travel = true } = {}) {
    if (!game.user.isGM) return ui.notifications.warn(t('Открывать Якорь может только Мастер.'));
    open = !!open;
    if (open === isAnchorOpen()) return;
    const anchor = anchorScene();
    if (open && travel && anchor) await travelTo(anchor);
    if (!open && anchor && canvas.scene?.id === anchor.id) {
        const floor = mapScene();
        if (floor && floor.id !== anchor.id) await travelTo(floor);
    }
    await game.settings.set(MODULE_ID, 'anchorOpen', open);
    if (!open) {
        const map = mapScene()?.getFlag(MODULE_ID, 'floorMap');
        const here = { mob: t('Монстры'), elite: t('Элита'), event: t('Событие'), risk: t('Риск'), shop: t('Магазин'), rest: t('Привал'), doom: t('Погибель'), boss: t('Босс'), start: t('Вход') }[map?.nodes?.find(n => n.id === map.currentNodeId)?.type];
        return ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: t('Якорь') }),
            content: `<div class="gd-scent-chat"><i class="fas fa-anchor"></i> ${t('Отряд покидает купол Якоря и возвращается в Лабиринт{v}. Голодные души смыкаются за спиной.', { v: here ? t(' — на узел «{here}»', { here }) : '' })}</div>`
        });
    }
    announceRest();
    // Жильцы: ячейки Ростовщика закрываются, после Босса у купола ждут новые
    Hooks.callAll('gachadnd.anchorOpened');
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: t('Якорь') }),
        content: t('<div class="gd-scent-chat"><i class="fas fa-anchor"></i> Отряд в <strong>Якоре</strong>. Руны над куполом медленно вращаются; Алтарь Памяти открыт. Отдыха здесь нет: Кости Хитов возвращает только Расщепление.</div>')
    });
    const scent = partyScent();
    if (scent.state === 'silence') return;
    const hint = scent.state === 'hunt' ? t('<br>Отряд выделяется на фоне купола: Пожиратель кружит у границы. Внутрь не входит.') : '';
    await whisperGM(scentReport(scent) + hint);
    await atmosphere(ANCHOR_ATMOSPHERE[scent.state]);
}

/** Первый шаг по карте уводит отряд из Якоря */
export async function leaveAnchor() {
    if (game.user.isGM && isAnchorOpen()) await setAnchor(false);
}
