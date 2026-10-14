/**
 * Gacha Roguelike dnd5e — Главный клиентский скрипт модуля
 */

// MODULE_ID — из constants.js; реэкспорт оставлен для макросов и старого кода
export { MODULE_ID } from "./core/constants.js";
import { MODULE_ID } from "./core/constants.js";
import { MemoryTerminal } from "./memory/terminal/terminal.js";
import { GachaLootTerminal, registerLootSettings } from "./memory/loot.js";
import "./core/compendium.js";
import "./memory/crystal-peek.js";
import { registerGachaPeriods, recoverPeriodUses } from "./core/recovery.js";
import { registerSoundSettings } from "./core/sounds.js";
import { registerImpactSettings, impactTest } from "./memory/effects/impact-frame.js";
import { giveCrystal } from "./memory/inventory.js";
import { registerSocket } from "./core/socket.js";
import { MemoryAltar, announceRest } from "./memory/altar/memory-altar.js";
import { StashWindow } from "./memory/stash.js";
import { registerDraftSettings, DraftWindow } from "./memory/draft.js";
import { registerMemorySettings } from "./memory/memory-api.js";
import { registerTriggerSettings } from "./memory/synergy/triggers.js";
import { registerAutomationMenu } from "./core/automation-settings.js";
import { addTokenTools } from "./core/controls.js";
import { openTetris, clearTetris } from "./memory/tetris/tetris.js";
import { clearPortals, registerPortalSettings, portalReport } from "./memory/skills/aperture.js";
import "./memory/skills/fez.js";
import "./memory/skills/cat.js";
import "./memory/skills/freaky.js";
import "./memory/skills/flashback.js";
// Лабиринт — роглайк поверх Памяти: карта, экономика, Магазин, Риск, Погибель, Всадники.
// Память от него не зависит: без этой строки она работает как самостоятельная система
import "./labyrinth/labyrinth.js";

Hooks.once('init', () => {
    console.log(`%c🎲 GachaDND | Инициализация...`, 'color: #ffaa00; font-weight: bold;');

    registerGachaPeriods();
    registerSoundSettings();
    registerImpactSettings();
    registerMemorySettings();
    registerDraftSettings();
    registerLootSettings();
    registerTriggerSettings();
    registerAutomationMenu();
    registerPortalSettings();

    // Лабиринт дописывает в этот же объект свои функции
    game.gachadnd = Object.assign(game.gachadnd ?? {}, {
        // Проверка импакт-кадра без навыка и урона: выделенный токен бьёт цель (T)
        impactTest,
        openTerminal: (actor) => {
            const targetActor = actor || canvas.tokens?.controlled[0]?.actor || game.user?.character;
            if (!targetActor) return ui.notifications.warn("⚠️ Выберите персонажа или токен на сцене.");
            const existing = foundry.applications.instances?.get(`gachadnd-terminal-${targetActor.id}`);
            if (existing) existing.render({ force: true }).then(() => existing.bringToFront?.());
            else new MemoryTerminal(targetActor).render({ force: true });
        },
        openLootTerminal: () => {
            if (!game.user?.isGM) return ui.notifications.warn("⚠️ У вас нет прав на генерацию лута.");
            return GachaLootTerminal.open();
        },
        openMemoryAltar: (actor) => MemoryAltar.open(actor),
        // Хранилище кристаллов персонажа (там же, где Алтарь)
        openStash: (actor) => StashWindow.open(actor),
        // Окно распределения добычи (если оно идёт)
        openDraft: () => DraftWindow.show(),
        // Головоломка Тетриса персонажа; уборка всех его блоков со сцены (Мастер)
        openTetris: (actor) => openTetris(actor || canvas.tokens?.controlled[0]?.actor || game.user?.character),
        clearTetris: (scene) => clearTetris(scene),
        // Убрать порталы со сцены (Мастер)
        clearPortals: (scene) => clearPortals(scene),
        // Сводка для отладки Портала: версия, порталы на сцене, выделенные токены
        portalReport,
        // Привал без карты: Мастер открывает и закрывает его вручную; при открытии у игроков открывается Алтарь
        setRest: async (open = true) => {
            if (!game.user?.isGM) return ui.notifications.warn("⚠️ Открывать Привал может только Мастер.");
            await game.settings.set(MODULE_ID, 'restOpen', !!open);
            if (open) announceRest();
        },
        // Кристалл навыка вручную: game.gachadnd.giveCrystal(actor, 'Фус-Ро-Да')
        giveCrystal: (actor, skillName) => giveCrystal(actor, { skillName }),
        // Восстановление зарядов по периоду: 'gachaRun', 'gachaScene' или стандартный период dnd5e
        recoverUses: async (period, actors) => {
            if (!game.user?.isGM) return ui.notifications.warn("⚠️ Восстанавливать заряды может только Мастер.");
            const count = await recoverPeriodUses(period, actors);
            const label = CONFIG.DND5E.limitedUsePeriods[period]?.label ?? period;
            ui.notifications.info(`🔄 Период «${label}»: восстановлены заряды у ${count} навыков.`);
            return count;
        }
    });
});

// Кнопки Памяти на панели токенов (кнопку карты добавляет Лабиринт)
Hooks.on('getSceneControlButtons', (controls) => {
    addTokenTools(controls, [
        {
            name: 'gachadnd-terminal',
            title: 'Терминал Тумана',
            icon: 'fas fa-brain',
            visible: true,
            button: true,
            onClick: () => game.gachadnd.openTerminal()
        },
        ...(game.user?.isGM ? [{
            name: 'gachadnd-loot',
            title: 'Генератор Лута (Мастер)',
            icon: 'fas fa-gem',
            visible: true,
            button: true,
            onClick: () => game.gachadnd.openLootTerminal()
        }, {
            // Блоки Тетриса и порталы сами уходят в конце боя; вне боя — этой кнопкой
            name: 'gachadnd-clear-field',
            title: 'Убрать блоки Тетриса и порталы со сцены (Мастер)',
            icon: 'fas fa-broom',
            visible: true,
            button: true,
            onClick: async () => {
                if (!canvas?.scene) return;
                await clearTetris(canvas.scene);
                await clearPortals(canvas.scene);
                ui.notifications.info('Блоки Тетриса и порталы убраны со сцены.');
            }
        }] : [])
    ]);
});

// Принудительная отрисовка UI после загрузки, чтобы новые кнопки появились на экране
Hooks.once('ready', () => {
    registerSocket();
    if (ui.controls) {
        ui.controls.initialize();
        ui.controls.render(true);
    }
});