/**
 * Gacha Roguelike dnd5e — Главный клиентский скрипт модуля
 */

import { MemoryTerminal } from "./ui.js";
import { GachaLootTerminal } from "./loot.js";
import { GachaMapTerminal } from "./map.js";
import "./compendium.js";
import { registerGachaPeriods, recoverPeriodUses } from "./recovery.js";
import { registerGachaEnrichers } from "./enrichers.js";

export const MODULE_ID = 'gachadnd';

Hooks.once('init', () => {
    console.log(`%c🎲 GachaDND | Инициализация...`, 'color: #ffaa00; font-weight: bold;');

    registerGachaPeriods();
    registerGachaEnrichers();

    game.gachadnd = {
        openTerminal: (actor) => {
            const targetActor = actor || canvas.tokens?.controlled[0]?.actor || game.user?.character;
            if (!targetActor) return ui.notifications.warn("⚠️ Выберите персонажа или токен на сцене.");
            const existing = Object.values(ui.windows).find(w => w instanceof MemoryTerminal && w.actor?.id === targetActor.id);
            if (existing) existing.bringToTop(); else new MemoryTerminal(targetActor).render(true);
        },
        openLootTerminal: () => {
            if (!game.user?.isGM) return ui.notifications.warn("⚠️ У вас нет прав на генерацию лута.");
            const existing = Object.values(ui.windows).find(w => w instanceof GachaLootTerminal);
            if (existing) existing.bringToTop(); else new GachaLootTerminal().render(true);
        },
        openMapTerminal: () => {
            const existing = Object.values(ui.windows).find(w => w instanceof GachaMapTerminal);
            if (existing) existing.bringToTop(); else new GachaMapTerminal().render(true);
        },
        // Восстановление зарядов по периоду: 'gachaFloor', 'gachaRun', 'gachaScene' или стандартный период dnd5e
        recoverUses: async (period, actors) => {
            if (!game.user?.isGM) return ui.notifications.warn("⚠️ Восстанавливать заряды может только Мастер.");
            const count = await recoverPeriodUses(period, actors);
            const label = CONFIG.DND5E.limitedUsePeriods[period]?.label ?? period;
            ui.notifications.info(`🔄 Период «${label}»: восстановлены заряды у ${count} навыков.`);
            return count;
        }
    };
});

Hooks.on('getSceneControlButtons', (controls) => {
    let tokenGroup = null;
    
    // 1. Ищем вкладку токенов (Поддерживаем и классические массивы, и словари v12+)
    if (Array.isArray(controls)) {
        tokenGroup = controls.find(c => c.name === 'token');
    } else if (controls && typeof controls === 'object') {
        tokenGroup = controls.token || controls.tokens || Object.values(controls).find(c => c?.name === 'token' || c?.name === 'tokens');
    }

    if (!tokenGroup) return;

    // 2. УНИВЕРСАЛЬНЫЙ ДОБАВЛЯТОР КНОПОК
    // Обходит Type Error, адаптируясь под любую структуру данных (Array, Map, Object)
    const safeAddTool = (tool) => {
        if (!tokenGroup.tools) tokenGroup.tools = [];
        
        // Если это стандартный Массив (Foundry v11)
        if (Array.isArray(tokenGroup.tools)) {
            if (!tokenGroup.tools.some(t => t.name === tool.name)) tokenGroup.tools.push(tool);
        } 
        // Если это Коллекция или Map (Foundry v12+ / Monk's Modules)
        else if (tokenGroup.tools instanceof Map || (typeof Collection !== 'undefined' && tokenGroup.tools instanceof Collection)) {
            if (!tokenGroup.tools.has(tool.name)) tokenGroup.tools.set(tool.name, tool);
        } 
        // Если это просто Объект-словарь
        else if (typeof tokenGroup.tools === 'object') {
            const exists = Object.values(tokenGroup.tools).some(t => t?.name === tool.name);
            if (!exists) tokenGroup.tools[tool.name] = tool;
        }
    };

    const isGM = game.user ? game.user.isGM : false;

    // 3. Безопасно внедряем наши инструменты
    safeAddTool({
        name: 'gachadnd-map',
        title: 'Карта Этажа (Туман)',
        icon: 'fas fa-map-marked-alt',
        visible: true,
        button: true,
        onClick: () => game.gachadnd.openMapTerminal()
    });

    safeAddTool({
        name: 'gachadnd-terminal',
        title: 'Терминал Тумана',
        icon: 'fas fa-brain',
        visible: true,
        button: true,
        onClick: () => game.gachadnd.openTerminal()
    });

    if (isGM) {
        safeAddTool({
            name: 'gachadnd-loot',
            title: 'Генератор Лута (Мастер)',
            icon: 'fas fa-gem',
            visible: true,
            button: true,
            onClick: () => game.gachadnd.openLootTerminal()
        });
    }
});

// 4. Принудительная отрисовка UI после загрузки, чтобы новые кнопки 100% появились на экране
Hooks.once('ready', () => {
    if (ui.controls) {
        ui.controls.initialize();
        ui.controls.render(true);
    }
});