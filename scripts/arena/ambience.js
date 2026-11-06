/**
 * Генератор арен — фон (docs/arena-sounds.md)
 *
 * Фон по месту и погоде: днём лес (птицы), ночью насекомые, в топи — лягушки; погода заменяет фон (ливень, ветер,
 * туман Предела), «Снять погоду» возвращает его. Файлы — assets/sounds/arena/<фон>*.<любой звук>: модуль сам находит
 * варианты по началу имени (forest-day-1, forest-day-2 …) и не ставит прошлый вариант подряд. Нет файла — тишина.
 *
 * Мастер кладёт выбранный файл флагом сцены arenaAmbience { key, path }; играет его каждый клиент у себя, по кругу,
 * в канале «Окружение» — у всех, кто смотрит на арену, выбран токен или нет (звук окружения Foundry слышен только
 * от токена). Громкость — ползунок «Окружение», общий «Gacha: всё» и свой «Фон арены» в «Управление громкостью».
 * В бою фон стихает (настройка Мастера «Фон арены в бою»): тише, выключить или как есть.
 *
 * setAmbience(scene, key) · ambienceKey(scene) · ambiencePlaying()
 */

import { MODULE_ID } from "../core/constants.js";
import { volumeMaster } from "../core/prefs.js";
import { t } from "../core/i18n.js";

const DIR = `modules/${MODULE_ID}/assets/sounds/arena`;
const FLAG = 'arenaAmbience';
const BASE = 0.6;
// В бою: доля обычной громкости
const COMBAT = { quiet: 0.25, off: 0, same: 1 };
const SOUND_EXT = /\.(ogg|mp3|wav|flac|m4a|webm|opus)$/i;

Hooks.once('init', () => {
    game.settings.register(MODULE_ID, 'arenaAmbience', {
        name: t('Фон арены в бою'),
        hint: t('Фон арены (лес, ночь, ливень, ветер, туман) в начале боя: тише, выключить или оставить как есть. До боя и после — обычной громкости.'),
        scope: 'world', config: false, type: String, default: 'quiet',
        choices: { quiet: t('Тише — еле слышно'), off: t('Выключить'), same: t('Как есть') },
        onChange: () => sync()
    });
    game.settings.register(MODULE_ID, 'arenaAmbienceVolume', {
        name: t('Громкость фона арены'), hint: t('0 — фон арены не играет у вас.'),
        scope: 'client', config: false, type: Number, range: { min: 0, max: 1, step: 0.05 }, default: 1,
        onChange: () => sync()
    });
    // Последний вариант каждого фона — чтобы не повторять его подряд
    game.settings.register(MODULE_ID, 'arenaAmbienceLast', { scope: 'world', config: false, type: Object, default: {} });
});

/** Фон без погоды: подземелье — своё (катакомбы, пещеры), ночь — насекомые, топь — лягушки (если есть такой файл), иначе лес днём */
export function ambienceKey(scene) {
    const arena = scene?.getFlag(MODULE_ID, 'arena') ?? {};
    const weather = scene?.getFlag(MODULE_ID, 'arenaWeather')?.kind;
    if (weather) return weather;
    if (arena.biome === 'crypt' || arena.biome === 'caves') return arena.biome;
    if (arena.scheme === 'swamp') return arena.mood === 'night' ? 'swamp-night' : 'swamp';
    return arena.mood === 'night' ? 'forest-night' : 'forest-day';
}
// Запасной фон, если своего файла нет: топь — как лес. Подземелье без своего файла — тишина, не лес; у пещер фона
// пока нет вовсе
const FALLBACK = { swamp: 'forest-day', 'swamp-night': 'forest-night' };

let listing = null;
/** Файлы фона: имя без расширения → путь. Список папки — один раз за сессию */
async function files() {
    if (listing) return listing;
    listing = {};
    try {
        const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
        const { files } = await FP.browse('data', DIR);
        for (const f of files.filter(f => SOUND_EXT.test(f))) listing[decodeURIComponent(f.split('/').pop()).replace(SOUND_EXT, '')] = f;
    } catch (err) { /* папки нет — тишина */ }
    return listing;
}

/** Варианты фона: forest-day, forest-day-2, forest-day_rain… — всё, что начинается с ключа и дальше не буква */
async function variants(key) {
    const all = await files();
    const list = Object.entries(all).filter(([name]) => name === key || name.startsWith(`${key}-`) || name.startsWith(`${key}_`)).map(([, src]) => src);
    return list.length || !FALLBACK[key] ? list : variants(FALLBACK[key]);
}

/**
 * Поставить фон на арену (Мастер): вариант — случайный, но не тот, что звучал в прошлый раз. Нет файла — тишина.
 * @param {Scene} scene
 * @param {string} [key]  без ключа — по месту и погоде
 */
export async function setAmbience(scene, key = ambienceKey(scene)) {
    if (!scene) return null;
    // Прежний фон звуком окружения (до перехода на флаг) — убрать
    const legacy = scene.sounds.filter(s => s.getFlag(MODULE_ID, 'ambience'));
    if (legacy.length) await scene.deleteEmbeddedDocuments('AmbientSound', legacy.map(s => s.id));
    const list = await variants(key);
    if (!list.length) { await scene.unsetFlag(MODULE_ID, FLAG); return null; }
    const last = game.settings.get(MODULE_ID, 'arenaAmbienceLast') ?? {};
    const fresh = list.length > 1 ? list.filter(src => src !== last[key]) : list;
    const path = fresh[Math.floor(Math.random() * fresh.length)];
    await game.settings.set(MODULE_ID, 'arenaAmbienceLast', { ...last, [key]: path });
    await scene.setFlag(MODULE_ID, FLAG, { key, path });
    return { key, path };
}

// ==========================================
// ПРОИГРЫВАНИЕ У КАЖДОГО КЛИЕНТА
// ==========================================

let current = null;   // { path, sound }
let syncing = Promise.resolve();

/** Громкость фона здесь и сейчас: базовая × общая модуля × своя × доля в бою */
function volumeNow(scene) {
    const inCombat = game.combats?.some(c => c.started && c.scene?.id === scene?.id);
    const share = inCombat ? COMBAT[game.settings.get(MODULE_ID, 'arenaAmbience')] ?? 1 : 1;
    return BASE * volumeMaster() * Number(game.settings.get(MODULE_ID, 'arenaAmbienceVolume') ?? 1) * share;
}

/** Свести то, что играет, с флагом текущей сцены: сменить файл, стихнуть, замолчать */
function sync() {
    syncing = syncing.then(async () => {
        const scene = canvas?.ready ? canvas.scene : null;
        const flag = scene?.getFlag(MODULE_ID, FLAG);
        const volume = flag ? volumeNow(scene) : 0;
        const path = flag?.path && volume > 0 ? flag.path : null;
        if (current && current.path !== path) {
            const old = current; current = null;
            old.sound.stop({ fade: 1200 }).catch(() => {});
        }
        if (!path) return;
        if (current) return current.sound.fade(volume, { duration: 800 });
        const sound = await game.audio.play(path, { context: game.audio.environment, loop: true, volume: 0 }).catch(() => null);
        if (!sound) return;
        current = { path, sound };
        sound.fade(volume, { duration: 1500 });
    }).catch(error => console.error(`${MODULE_ID} | фон`, error));
    return syncing;
}

/** Что играет у этого клиента (для проверок): путь и громкость */
export const ambiencePlaying = () => current ? { path: current.path, volume: Math.round(current.sound.volume * 100) / 100, playing: current.sound.playing } : null;

Hooks.on('canvasReady', () => sync());
Hooks.on('canvasTearDown', () => { if (current) { current.sound.stop({ fade: 600 }).catch(() => {}); current = null; } });
Hooks.on('updateScene', (scene, changed) => { if (scene.id === canvas?.scene?.id && foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`)) sync(); });
for (const hook of ['combatStart', 'deleteCombat', 'updateCombat']) Hooks.on(hook, combat => { if (combat.scene?.id === canvas?.scene?.id) sync(); });
Hooks.on('gachadnd.volume', () => sync());
