/**
 * Gacha Roguelike dnd5e — Главный клиентский скрипт модуля
 */

// MODULE_ID — из constants.js; реэкспорт оставлен для макросов и старого кода
export { MODULE_ID } from "./constants.js";
import { MODULE_ID } from "./constants.js";
import { MemoryTerminal } from "./ui.js";
import { GachaLootTerminal } from "./loot.js";
import "./compendium.js";
import { registerGachaPeriods, recoverPeriodUses } from "./recovery.js";
import { registerSoundSettings } from "./sounds.js";
import { giveCrystal } from "./inventory.js";
import { registerSocket } from "./socket.js";
import { MemoryAltar, announceRest } from "./memory-altar.js";
import { registerMemorySettings } from "./memory-api.js";
import { registerTriggerSettings } from "./triggers.js";
import { addTokenTools } from "./controls.js";
// Лабиринт — роглайк поверх Памяти: карта, экономика, Магазин, Риск, Погибель, Всадники.
// Память от него не зависит: без этой строки она работает как самостоятельная система
import "./labyrinth.js";

Hooks.once('init', () => {
    console.log(`%c🎲 GachaDND | Инициализация...`, 'color: #ffaa00; font-weight: bold;');

    registerGachaPeriods();
    registerSoundSettings();
    registerMemorySettings();
    registerTriggerSettings();

    // Лабиринт дописывает в этот же объект свои функции
    game.gachadnd = Object.assign(game.gachadnd ?? {}, {
        openTerminal: (actor) => {
            const targetActor = actor || canvas.tokens?.controlled[0]?.actor || game.user?.character;
            if (!targetActor) return ui.notifications.warn("⚠️ Выберите персонажа или токен на сцене.");
            const existing = foundry.applications.instances?.get(`gachadnd-terminal-${targetActor.id}`);
            if (existing) existing.render({ force: true }).then(() => existing.bringToFront?.());
            else new MemoryTerminal(targetActor).render({ force: true });
        },
        openLootTerminal: () => {
            if (!game.user?.isGM) return ui.notifications.warn("⚠️ У вас нет прав на генерацию лута.");
            const existing = Object.values(ui.windows).find(w => w instanceof GachaLootTerminal);
            if (existing) existing.bringToTop(); else new GachaLootTerminal().render(true);
        },
        openMemoryAltar: (actor) => MemoryAltar.open(actor),
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