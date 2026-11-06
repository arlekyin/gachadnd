import { soundOn, sfxVolume } from "../core/prefs.js";
import { t } from "./i18n.js";
/**
 * Gacha Roguelike dnd5e — Звуки Терминала Тумана
 *
 * Пути к звукам задаёт Мастер в настройках модуля, громкость и отключение — каждый игрок у себя.
 * По умолчанию используются встроенные звуки Foundry.
 */

const MODULE_ID = 'gachadnd';

const SOUNDS = {
    equip: { name: t('Звук экипировки'), fallback: () => CONFIG.sounds?.notification ?? 'sounds/notify.wav' },
    unequip: { name: t('Звук снятия'), fallback: () => CONFIG.sounds?.lock ?? 'sounds/lock.wav' },
    merge: { name: t('Звук слияния на Алтаре Памяти'), fallback: () => CONFIG.sounds?.combat ?? 'sounds/drums.wav' }
};

export function registerSoundSettings() {
    game.settings.register(MODULE_ID, 'soundsEnabled', {
        name: t('Звуки Терминала Тумана'),
        hint: t('Звуки экипировки, снятия и слияния навыков.'),
        scope: 'client',
        config: false,
        type: Boolean,
        default: true
    });
    game.settings.register(MODULE_ID, 'soundsVolume', {
        name: t('Громкость звуков Терминала'),
        scope: 'client',
        config: false,
        type: Number,
        range: { min: 0, max: 1, step: 0.05 },
        default: 0.5
    });
    for (const [key, config] of Object.entries(SOUNDS)) {
        game.settings.register(MODULE_ID, `sound_${key}`, {
            name: config.name,
            hint: t('По умолчанию — встроенный звук Foundry.'),
            scope: 'world',
            config: false,
            type: String,
            filePicker: 'audio',
            // Поле выбора файла не принимает пустую строку: без значения по умолчанию форма настроек не сохраняется
            default: config.fallback()
        });
    }
}

export function playTerminalSound(key) {
    if (!SOUNDS[key] || !soundOn()) return;
    const src = game.settings.get(MODULE_ID, `sound_${key}`) || SOUNDS[key].fallback();
    const volume = sfxVolume();
    const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
    helper?.play({ src, volume, autoplay: true, loop: false }, false);
}
