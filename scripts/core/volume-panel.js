/**
 * Gacha Roguelike dnd5e — Громкость модуля в «Управление громкостью» (вкладка плейлистов)
 *
 * Под ползунками Foundry (музыка, окружение, интерфейс) — свой блок: общая громкость модуля и по звукам —
 * Терминал, тема героя, фон арены. Настройки клиента: у каждого игрока свои. Ползунок пишет настройку сразу,
 * без окна настроек; сами звуки модуля подхватывают её (фон арены — хуком gachadnd.volume).
 */

import { MODULE_ID } from "./constants.js";

const ROWS = [
    { key: 'volume', label: 'Gacha: всё', tooltip: 'Общая громкость всех звуков модуля' },
    { key: 'arenaAmbienceVolume', label: 'Фон арены', tooltip: 'Лес, ночь, ливень, ветер, туман на арене' },
    { key: 'soundsVolume', label: 'Терминал', tooltip: 'Звуки экипировки, снятия и слияния навыков' },
    { key: 'auraMusicVolume', label: 'Тема героя', tooltip: 'Музыкальная тема Счётчика ауры' }
];

const icon = v => (v <= 0 ? 'fa-volume-xmark' : v < 0.5 ? 'fa-volume-low' : 'fa-volume-high');

Hooks.on('renderPlaylistDirectory', (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const list = root?.querySelector('.global-volume ol');
    if (!list || list.querySelector('.gd-volume')) return;
    const rows = ROWS.filter(r => game.settings.settings.has(`${MODULE_ID}.${r.key}`)).map(r => {
        const v = Number(game.settings.get(MODULE_ID, r.key)) || 0;
        return `<li class="flexrow gd-volume" data-tooltip="${r.tooltip}">
            <label>${r.label}</label><i class="volume-icon fa-fw fa-solid ${icon(v)}" inert></i>
            <input type="range" min="0" max="1" step="0.05" value="${v}" data-gd-volume="${r.key}" aria-label="${r.label}">
        </li>`;
    }).join('');
    list.insertAdjacentHTML('beforeend', `<li class="gd-volume gd-volume-head"><strong>Gacha Roguelike</strong></li>${rows}`);
    list.querySelectorAll('[data-gd-volume]').forEach(input => {
        input.addEventListener('input', () => { input.previousElementSibling.className = `volume-icon fa-fw fa-solid ${icon(Number(input.value))}`; });
        input.addEventListener('change', async () => {
            await game.settings.set(MODULE_ID, input.dataset.gdVolume, Number(input.value));
            Hooks.callAll('gachadnd.volume', input.dataset.gdVolume);
        });
    });
});
