/**
 * Gacha Roguelike dnd5e — Лабиринт: роглайк поверх Памяти
 *
 * Карта этажа, экономика, Магазин, Риск, Алтарь Погибели и Всадники. Лабиринт пользуется
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

Hooks.once('init', () => {
    registerEconomySettings();
    registerRiskSettings();
    game.gachadnd = Object.assign(game.gachadnd ?? {}, {
        openMapTerminal: () => {
            const existing = Object.values(ui.windows).find(w => w instanceof GachaMapTerminal);
            if (existing) existing.bringToTop(); else new GachaMapTerminal().render(true);
        },
        openDoomAltar: () => DoomAltar.open(),
        openShop: () => ShopWindow.open(),
        openRisk: () => RiskWindow.open()
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
