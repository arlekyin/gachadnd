/**
 * Gacha Roguelike dnd5e — Общие настройки модуля
 *
 * В списке настроек Foundry — только общие: эффекты, громкость, подсказки Мастеру (плюс автоматизация
 * и сцена Якоря из своих файлов). Частные — экономика, файлы звуков, испытания Риска, отдельные
 * подсказки — в подменю (settings-menu.js). Код модуля читает их через помощники отсюда, а не напрямую:
 *   fxOn()    — эффекты не выключены: импакт-кадры, катсцена прорыва, сцена редкой добычи;
 *   fxCalm()  — спокойно: без вспышек, тряски и движения (и когда эффекты выключены);
 *   soundOn() / sfxVolume() / musicVolume() — звуки модуля с общей громкостью;
 *   hint(key) — подсказка Мастеру или строка атмосферы включена (общий переключатель и свой).
 */

import { MODULE_ID } from "./constants.js";
import { t } from "./i18n.js";

const get = (key, fallback) => {
    try { return game.settings.get(MODULE_ID, key) ?? fallback; } catch (error) { return fallback; }
};

export const EFFECTS = {
    full: t('Полные'),
    calm: t('Спокойные — без вспышек, тряски и движения'),
    off: t('Выключены — без импакт-кадров и катсцен, остальное спокойно')
};

export const effectsMode = () => EFFECTS[get('effects', 'calm')] ? get('effects', 'calm') : 'calm';
export const fxOn = () => effectsMode() !== 'off';
export const fxCalm = () => effectsMode() !== 'full';
export const fxSlow = () => Math.max(1, Number(get('impactSlow', 1)) || 1);

export const volumeMaster = () => Math.max(0, Number(get('volume', 1)) || 0);
export const soundOn = () => get('soundsEnabled', true) !== false && volumeMaster() > 0;
export const sfxVolume = () => volumeMaster() * Number(get('soundsVolume', 0.5));
export const musicVolume = () => volumeMaster() * Number(get('auraMusicVolume', 0.35));

/** Подсказки Мастеру и строки атмосферы: каждая — своя галочка в подменю «Подсказки Мастеру» */
export const HINTS = {
    hintScent: { name: t('Шёпот Запаха Мастеру'), hint: t('При входе на узел и в Якорь в Шёпоте и Охоте: Запах отряда и может ли Пожиратель прорваться сюда.') },
    hintAtmosphere: { name: t('Строки атмосферы игрокам'), hint: t('В Шёпоте и Охоте — строка о тумане и гуле кристаллов в общий чат.') },
    hintPulse: { name: t('Шёпот Пульса Мастеру'), hint: t('После каждого боя: итог боя и совет по сложности следующих.') },
    hintMoonBoons: { name: t('Дары луны в начале боя'), hint: t('Если у отряда есть Отголосок Босса или Натравить Пожирателя: шёпот Мастеру с кнопками вызова.') },
    hintCounters: { name: t('Счётчики навыков — строки игрокам'), hint: t('Шёпот владельцу и Мастеру, когда счётчик живого навыка дошёл до порога, и в первом бою сессии — что у кого копится. Значки на токене и правило в карточке навыка — всегда.') },
    hintBossRules: { name: t('Правило Босса — кнопки Мастеру'), hint: t('В начале боя с Боссом этажа: шёпот с кнопками «Другое правило» и «Без правила». Само правило выпадает и без него.') },
    hintWelcome: { name: t('Приветствие при первом запуске'), hint: t('Один раз на мир: шёпот Мастеру с кнопкой «Новый забег».') },
    hintEncounters: { name: t('Встречи на боевых узлах'), hint: t('Отряд вошёл на Монстров, Элиту, Заставу или Босса: шёпот Мастеру с готовым составом из SRD и кнопками «На арену», «На эту сцену», «Другой состав».') },
    hintTrade: { name: t('Обмен между игроками — шёпот Мастеру'), hint: t('Игроки начали обмен: шёпот с кнопкой «Наблюдать» — окно сделки, где видны и правятся обе стороны. Запись итогов в чат — всегда.') },
    hintWeather: { name: t('Погода на важных боях'), hint: t('Арена Элиты (в половине боёв), Заставы и Босса — под ливнем или на ветру: карточка с правилом в начале боя, у Мастера — «Другая погода» и «Снять погоду».') },
    hintVows: { name: t('Обеты на Элите'), hint: t('Вход на Элиту: окно у всех — усложнить бой за большую награду. Выключено — Элита как обычный тяжёлый бой.') }
};
export const hint = key => get('gmHints', true) !== false && get(key, true) !== false;

export function registerPrefs() {
    game.settings.register(MODULE_ID, 'effects', {
        name: t('Эффекты модуля'),
        hint: t('Импакт-кадры, катсцены, предвестия Пожирателя, вспышки добычи, волны навыков. У каждого игрока свои.'),
        // Как и раньше («без вспышек» было включено по умолчанию) — спокойные
        scope: 'client', config: true, type: String, choices: EFFECTS, default: 'calm'
    });
    game.settings.register(MODULE_ID, 'echoVision', {
        name: t('Видения Эха'),
        hint: t('Что видит ваш персонаж, когда эхо прежних владельцев навыков громкое: фантомы, кровь, помехи. Видно только вам. Приглушённые — без пульса, дрожи и мельканий.'),
        scope: 'client', config: true, type: String, default: 'full',
        choices: { full: t('Полные'), calm: t('Приглушённые — без пульса, дрожи и мельканий'), off: t('Выключены — остаются шёпоты и наплывы') },
        onChange: () => game.gachadnd?.echo?.rebuildVision?.()
    });
    game.settings.register(MODULE_ID, 'volume', {
        name: t('Громкость модуля'),
        hint: t('Общая громкость всех звуков модуля; отдельные — в «Звуки и эффекты» и в «Управление громкостью» на вкладке плейлистов. У каждого игрока своя.'),
        scope: 'client', config: true, type: Number, range: { min: 0, max: 1, step: 0.05 }, default: 1,
        onChange: () => Hooks.callAll('gachadnd.volume', 'volume')
    });
    game.settings.register(MODULE_ID, 'gmHints', {
        name: t('Подсказки Мастеру'),
        hint: t('Шёпоты о Запахе и Пульсе и строки атмосферы. Модуль только напоминает — решает Мастер. По отдельности — в «Подсказки Мастеру».'),
        scope: 'world', config: true, type: Boolean, default: true
    });
    for (const [key, config] of Object.entries(HINTS)) {
        game.settings.register(MODULE_ID, key, { scope: 'world', config: false, type: Boolean, default: true, ...config });
    }
}

/**
 * Перенос старых значений: режим эффектов — из «Импакт-кадры» и «без вспышек», если игрок менял их сам,
 * а новый режим ещё не выбирал. Вызывается в ready у каждого клиента.
 */
export async function migratePrefs() {
    const storage = game.settings.storage.get('client');
    const stored = key => storage?.getItem?.(`${MODULE_ID}.${key}`) ?? null;
    if (stored('effects') !== null || (stored('impactFrames') === null && stored('impactCalm') === null)) return;
    const mode = get('impactFrames', true) === false ? 'off' : get('impactCalm', true) ? 'calm' : 'full';
    await game.settings.set(MODULE_ID, 'effects', mode);
}
