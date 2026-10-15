/**
 * Gacha Roguelike dnd5e — Звуки Терминала Тумана
 *
 * Пути к звукам задаёт Мастер в настройках модуля, громкость и отключение — каждый игрок у себя.
 * По умолчанию используются встроенные звуки Foundry.
 */

const MODULE_ID = 'gachadnd';

const SOUNDS = {
    equip: { name: 'Звук экипировки', fallback: () => CONFIG.sounds?.notification ?? 'sounds/notify.wav' },
    unequip: { name: 'Звук снятия', fallback: () => CONFIG.sounds?.lock ?? 'sounds/lock.wav' },
    merge: { name: 'Звук слияния на Алтаре Памяти', fallback: () => CONFIG.sounds?.combat ?? 'sounds/drums.wav' }
};

export function registerSoundSettings() {
    game.settings.register(MODULE_ID, 'soundsEnabled', {
        name: 'Звуки Терминала Тумана',
        hint: 'Звуки экипировки, снятия и слияния навыков.',
        scope: 'client',
        config: true,
        type: Boolean,
        default: true
    });
    game.settings.register(MODULE_ID, 'soundsVolume', {
        name: 'Громкость звуков Терминала',
        scope: 'client',
        config: true,
        type: Number,
        range: { min: 0, max: 1, step: 0.05 },
        default: 0.5
    });
    for (const [key, config] of Object.entries(SOUNDS)) {
        game.settings.register(MODULE_ID, `sound_${key}`, {
            name: config.name,
            hint: 'По умолчанию — встроенный звук Foundry.',
            scope: 'world',
            config: true,
            type: String,
            filePicker: 'audio',
            // Поле выбора файла не принимает пустую строку: без значения по умолчанию форма настроек не сохраняется
            default: config.fallback()
        });
    }
}

export function playTerminalSound(key) {
    if (!SOUNDS[key] || !game.settings.get(MODULE_ID, 'soundsEnabled')) return;
    const src = game.settings.get(MODULE_ID, `sound_${key}`) || SOUNDS[key].fallback();
    const volume = game.settings.get(MODULE_ID, 'soundsVolume');
    const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
    helper?.play({ src, volume, autoplay: true, loop: false }, false);
}
