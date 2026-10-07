/**
 * Gacha Roguelike dnd5e — Точки расширения Памяти
 *
 * Память (кристаллы, навыки, синергии, Терминал, Алтарь Памяти) не знает о Лабиринте: карте,
 * Риске, Всадниках, экономике. Лабиринт подключается к ней через хуки ниже, как прибор к розетке.
 * Без Лабиринта хуки просто никто не слушает, и Память работает сама.
 *
 * Хуки-запреты (Hooks.call: слушатель возвращает false и сам объясняет причину игроку):
 *   gachadnd.preAbsorbCrystal (actor, crystal, usageConfig) — перед поглощением кристалла в Память.
 *       usageConfig.gachadndToMemory = true, если поглощение уже подтверждено слушателем (повторный вызов).
 *   gachadnd.preChangeSkill   (actor, item, equipping)      — перед экипировкой или снятием навыка в Терминале.
 *
 * Хуки-запросы (Hooks.callAll: слушатель дописывает данные в переданный объект):
 *   gachadnd.queryRest        (state)                       — state.atRest: отряд на Привале.
 *   gachadnd.terminalSkillView(item, view)                  — плашки и кнопки выбранного навыка в Терминале:
 *       view.notes.push({ text, cls }); view.actions.push({ label, icon, title, run: async () => {} }).
 *   gachadnd.lootGenerated    (loot)                        — добыча сгенерирована, до карточки в чате:
 *       loot = { roomType, actor, lines: [], tasks: [] }; слушатель добавляет строку карточки и промис.
 *
 * События (Hooks.callAll):
 *   gachadnd.restChanged      ()                            — Привал мог открыться или закрыться.
 */

import { MODULE_ID } from "./constants.js";

export const HOOKS = {
    preAbsorbCrystal: 'gachadnd.preAbsorbCrystal',
    preChangeSkill: 'gachadnd.preChangeSkill',
    queryRest: 'gachadnd.queryRest',
    terminalSkillView: 'gachadnd.terminalSkillView',
    lootGenerated: 'gachadnd.lootGenerated',
    restChanged: 'gachadnd.restChanged'
};

// Привал без карты: Мастер открывает его вручную — game.gachadnd.setRest(true)
export function registerMemorySettings() {
    game.settings.register(MODULE_ID, 'restOpen', {
        scope: 'world', config: false, type: Boolean, default: false,
        onChange: () => notifyRestChanged()
    });
}

/** Сообщить Памяти, что Привал мог открыться или закрыться (Терминал покажет баннер) */
export function notifyRestChanged() {
    Hooks.callAll(HOOKS.restChanged);
}

/** Отряд на Привале: открыт вручную Мастером или так считает Лабиринт */
export function isAtRest() {
    let manual = false;
    try {
        manual = !!game.settings.get(MODULE_ID, 'restOpen');
    } catch (err) {
        manual = false;
    }
    const state = { atRest: manual };
    Hooks.callAll(HOOKS.queryRest, state);
    return state.atRest;
}

/** Можно ли поглотить кристалл: false, если кто-то из Лабиринта запретил */
export function allowAbsorb(actor, crystal, usageConfig) {
    return Hooks.call(HOOKS.preAbsorbCrystal, actor, crystal, usageConfig) !== false;
}

/** Можно ли экипировать или снять навык */
export function allowSkillChange(actor, item, equipping) {
    return Hooks.call(HOOKS.preChangeSkill, actor, item, equipping) !== false;
}
