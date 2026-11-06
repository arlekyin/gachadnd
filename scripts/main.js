/**
 * Gacha Roguelike dnd5e — Главный клиентский скрипт модуля
 */

// MODULE_ID — из constants.js; реэкспорт оставлен для макросов и старого кода
export { MODULE_ID } from "./core/constants.js";
import { MODULE_ID } from "./core/constants.js";
// Перевод: t() и словарь языка клиента; идентификаторы-теги отдельно от подписей (docs/i18n.md)
import "./core/i18n.js";
import "./core/ids.js";
import { MemoryTerminal } from "./memory/terminal/terminal.js";
import { TerminalDock, defaultTerminalActor } from "./dock/dock.js";
// Генератор арен (прототип): game.gachadnd.arena.generate()
import "./arena/arena.js";
import "./core/volume-panel.js";
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
import { offerTrade, trades, TradeWindow } from "./trade/trade.js";
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
import "./memory/skills/qte.js";
import "./memory/skills/gwent-panel.js";
import "./memory/skills/aura-panel.js";
import "./memory/overheat.js";
import "./memory/skills/light/index.js";
import "./memory/skills/blast/index.js";
import "./memory/skills/knack/index.js";
import "./memory/skills/living/index.js";
import "./memory/echo/index.js";
import "./memory/facet/index.js";
import { registerAuraSettings } from "./memory/skills/aura-fx.js";
import { registerPrefs, migratePrefs } from "./core/prefs.js";
import { registerSettingsMenus } from "./core/settings-menu.js";
import { registerSkillNameSettings } from "./memory/skill-names.js";
// Лабиринт — роглайк поверх Памяти: карта, экономика, Магазин, Риск, Погибель, Всадники.
// Память от него не зависит: без этой строки она работает как самостоятельная система
import "./labyrinth/labyrinth.js";
import { t } from "./core/i18n.js";

Hooks.once('init', () => {
    console.log(`%c🎲 GachaDND | Инициализация...`, 'color: #ffaa00; font-weight: bold;');

    // Общие настройки — первыми в списке; частные уходят в подменю
    registerPrefs();
    registerSkillNameSettings();
    registerGachaPeriods();
    registerSoundSettings();
    registerImpactSettings();
    registerMemorySettings();
    registerDraftSettings();
    registerLootSettings();
    registerTriggerSettings();
    registerAutomationMenu();
    registerPortalSettings();
    registerAuraSettings();
    registerSettingsMenus();

    // Лабиринт дописывает в этот же объект свои функции
    game.gachadnd = Object.assign(game.gachadnd ?? {}, {
        // Проверка импакт-кадра без навыка и урона: выделенный токен бьёт цель (T)
        impactTest,
        openTerminal: (actor) => {
            // Без выбора — выбранный токен, свой персонаж или первый подконтрольный (dock.js)
            const targetActor = actor || defaultTerminalActor();
            if (!targetActor) return ui.notifications.warn(t("⚠️ У вас нет персонажа — Терминал открыть не для кого."));
            // Терминал — панель модуля слева (dock/dock.js); старое окно — game.gachadnd.openTerminalWindow
            return TerminalDock.open(targetActor);
        },
        toggleTerminal: (actor) => {
            const targetActor = actor || defaultTerminalActor();
            const open = foundry.applications.instances?.get('gachadnd-dock');
            if (open?.rendered && (!targetActor || open.actor?.id === targetActor.id)) return open.close();
            if (!targetActor) return ui.notifications.warn(t("⚠️ У вас нет персонажа — Терминал открыть не для кого."));
            return TerminalDock.open(targetActor);
        },
        openTerminalWindow: (actor) => {
            const targetActor = actor || canvas.tokens?.controlled[0]?.actor || game.user?.character;
            if (!targetActor) return ui.notifications.warn(t("⚠️ Выберите персонажа или токен на сцене."));
            const existing = foundry.applications.instances?.get(`gachadnd-terminal-${targetActor.id}`);
            if (existing) existing.render({ force: true }).then(() => existing.bringToFront?.());
            else new MemoryTerminal(targetActor).render({ force: true });
        },
        openLootTerminal: () => {
            if (!game.user?.isGM) return ui.notifications.warn(t("⚠️ У вас нет прав на генерацию лута."));
            return GachaLootTerminal.open();
        },
        openMemoryAltar: (actor) => MemoryAltar.open(actor),
        // Хранилище кристаллов персонажа (там же, где Алтарь)
        openStash: (actor) => StashWindow.open(actor),
        // Обмен: game.gachadnd.trade.offer(actor) — как правый щелчок по токену товарища; list() — сделки этого клиента
        trade: { offer: offerTrade, list: trades, show: id => TradeWindow.show(id) },
        // Окно распределения добычи (если оно идёт)
        openDraft: () => DraftWindow.show(),
        // Головоломка Кирпичей персонажа; уборка всех его блоков со сцены (Мастер)
        openTetris: (actor) => openTetris(actor || canvas.tokens?.controlled[0]?.actor || game.user?.character),
        clearTetris: (scene) => clearTetris(scene),
        // Убрать порталы со сцены (Мастер)
        clearPortals: (scene) => clearPortals(scene),
        // Сводка для отладки Портала: версия, порталы на сцене, выделенные токены
        portalReport,
        // Журнал Портала (отладка, у этого клиента): game.gachadnd.portalDebug(true)
        portalDebug: (on = true) => game.settings.set(MODULE_ID, 'portalDebug', !!on),
        // Привал без карты: Мастер открывает и закрывает его вручную; при открытии у игроков открывается Алтарь
        setRest: async (open = true) => {
            if (!game.user?.isGM) return ui.notifications.warn(t("⚠️ Открывать Привал может только Мастер."));
            await game.settings.set(MODULE_ID, 'restOpen', !!open);
            if (open) announceRest();
        },
        // Кристалл навыка вручную: game.gachadnd.giveCrystal(actor, 'Голос предков')
        giveCrystal: (actor, skillName) => giveCrystal(actor, { skillName }),
        // Восстановление зарядов по периоду: 'gachaRun', 'gachaScene' или стандартный период dnd5e
        recoverUses: async (period, actors) => {
            if (!game.user?.isGM) return ui.notifications.warn(t("⚠️ Восстанавливать заряды может только Мастер."));
            const count = await recoverPeriodUses(period, actors);
            const label = CONFIG.DND5E.limitedUsePeriods[period]?.label ?? period;
            ui.notifications.info(t('🔄 Период «{label}»: восстановлены заряды у {count} навыков.', { label, count }));
            return count;
        }
    });
});

// Кнопки Памяти на панели токенов (кнопку карты добавляет Лабиринт)
Hooks.on('getSceneControlButtons', (controls) => {
    addTokenTools(controls, [
        {
            name: 'gachadnd-terminal',
            title: t('Терминал Тумана'),
            icon: 'fas fa-brain',
            visible: true,
            button: true,
            onClick: () => game.gachadnd.toggleTerminal()
        },
        ...(game.user?.isGM ? [{
            name: 'gachadnd-loot',
            title: t('Генератор Лута (Мастер)'),
            icon: 'fas fa-gem',
            visible: true,
            button: true,
            onClick: () => game.gachadnd.openLootTerminal()
        }, {
            // Блоки Кирпичей и порталы сами уходят в конце боя; вне боя — этой кнопкой
            name: 'gachadnd-clear-field',
            title: t('Убрать блоки Кирпичей и порталы со сцены (Мастер)'),
            icon: 'fas fa-broom',
            visible: true,
            button: true,
            onClick: async () => {
                if (!canvas?.scene) return;
                await clearTetris(canvas.scene);
                await clearPortals(canvas.scene);
                ui.notifications.info(t('Блоки Кирпичей и порталы убраны со сцены.'));
            }
        }] : [])
    ]);
});

// Принудительная отрисовка UI после загрузки, чтобы новые кнопки появились на экране
Hooks.once('ready', () => {
    registerSocket();
    migratePrefs().catch(error => console.error(`${MODULE_ID} | перенос настроек`, error));
    if (ui.controls) {
        // v13+: инструменты пересобирает render({ reset }), initialize() там устарел
        if (game.release.generation >= 13) ui.controls.render({ reset: true });
        else { ui.controls.initialize(); ui.controls.render(true); }
    }
});