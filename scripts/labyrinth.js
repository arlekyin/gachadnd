/**
 * Gacha Roguelike dnd5e — Лабиринт: роглайк поверх Памяти
 *
 * Карта этажа, экономика, Магазин, Риск, Алтарь Погибели, Всадники и награды событий. Лабиринт пользуется
 * Памятью напрямую, а Память узнаёт о нём только через свои точки расширения (memory-api.js):
 * запреты Риска и Всадников, Привал на карте, золото в добыче, плашки всадников в Терминале.
 */

import { GachaMapTerminal } from "./map.js";
import "./horsemen.js";
import { DoomAltar } from "./altar.js";
import { ShopWindow } from "./shop.js";
import { RiskWindow, registerRiskSettings } from "./risk.js";
import { registerEconomySettings } from "./economy.js";
import { addTokenTools } from "./controls.js";
import { EventRewardsWindow, offerEventRewards, expireFloorSlots } from "./rewards.js";

Hooks.once('init', () => {
    registerEconomySettings();
    registerRiskSettings();
    // Смена этажа закрывает временные слоты Памяти из наград событий
    const floorSetting = game.settings.settings.get(`gachadnd.runFloor`);
    const previous = floorSetting.onChange;
    floorSetting.onChange = value => { previous?.(value); expireFloorSlots(); };
    game.gachadnd = Object.assign(game.gachadnd ?? {}, {
        openMapTerminal: () => GachaMapTerminal.open(),
        openDoomAltar: () => DoomAltar.open(),
        openShop: () => ShopWindow.open(),
        openRisk: () => RiskWindow.open(),
        // Награды события: game.gachadnd.eventRewards({ tier: 'notable', count: 3 }) — каждому персонажу отряда
        eventRewards: (config) => offerEventRewards(config),
        openEventRewards: () => new EventRewardsWindow().render({ force: true })
    });
});

Hooks.on('getSceneControlButtons', (controls) => {
    addTokenTools(controls, [{
        name: 'gachadnd-map',
        title: 'Карта Этажа (Туман)',
        icon: 'fas fa-map-marked-alt',
        visible: true,
        button: true,
        onClick: () => game.gachadnd.openMapTerminal()
    }]);
});
