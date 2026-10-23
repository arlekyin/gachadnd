/**
 * Gacha Roguelike dnd5e — Лабиринт: роглайк поверх Памяти
 *
 * Карта этажа, экономика, Магазин, Риск, Алтарь Погибели, Всадники и награды событий. Лабиринт пользуется
 * Памятью напрямую, а Память узнаёт о нём только через свои точки расширения (memory-api.js):
 * запреты Риска и Всадников, Якорь, золото в добыче, плашки всадников в Терминале.
 */

import { GachaMapTerminal } from "./map.js";
import "./horsemen.js";
import { DoomAltar } from "./doom-altar.js";
import { ShopWindow } from "./shop.js";
import { RiskWindow, registerRiskSettings } from "./risk.js";
import { registerEconomySettings } from "./economy.js";
import { addTokenTools } from "../core/controls.js";
import { NewRunWindow, startRun } from "./new-run.js";
import { EventRewardsWindow, offerEventRewards, expireFloorSlots } from "./rewards.js";
import { registerAnchorSettings, setAnchor, isAnchorOpen, partyScent } from "./anchor.js";
import { PortalWindow } from "./portal.js";
import { registerPulseSettings, resetPulse, pulseReport } from "./pulse.js";
import { registerGraveyardSettings, GraveyardWindow } from "./graveyard.js";
import { registerOmenSettings, setOmen } from "./omen.js";
import { startBreach } from "./breach.js";
import { registerSceneSettings } from "./scene-travel.js";
import { DealWindow, registerDealSettings } from "./moon-deal.js";
import { registerBoonSettings, callEcho, callDevourer } from "./moon-boons.js";
import { registerResidentSettings, settleResident, hasResident } from "./residents.js";
import { ResidentsWindow } from "./residents-window.js";
import "./chronicle-log.js";
import { playChronicle } from "./chronicle.js";
import { EventWindow, registerEventSettings } from "./events.js";
import { registerDevourerSettings, addSatiety, getSatiety, syncDevourer, worldDevourer } from "./devourer-state.js";
import { setBossRule, setBossRules } from "./boss-rules.js";
import { registerWebSettings, isWeb } from "./web-map.js";
import { WebOverlay } from "./web-overlay.js";
import { mapScene } from "./scene-travel.js";
import { requestScar } from "../memory/skills/living/scars.js";

Hooks.once('init', () => {
    registerEconomySettings();
    registerRiskSettings();
    registerAnchorSettings();
    registerPulseSettings();
    registerGraveyardSettings();
    registerOmenSettings();
    registerSceneSettings();
    registerDealSettings();
    registerBoonSettings();
    registerEventSettings();
    registerResidentSettings();
    registerDevourerSettings();
    registerWebSettings();
    // Смена этажа закрывает временные слоты Памяти из наград событий
    const floorSetting = game.settings.settings.get(`gachadnd.runFloor`);
    const previous = floorSetting.onChange;
    floorSetting.onChange = value => { previous?.(value); expireFloorSlots(); resetPulse(); };
    game.gachadnd = Object.assign(game.gachadnd ?? {}, {
        openMapTerminal: () => GachaMapTerminal.open(),
        openDoomAltar: () => DoomAltar.open(),
        openShop: () => ShopWindow.open(),
        openRisk: () => RiskWindow.open(),
        // Награды события: game.gachadnd.eventRewards({ tier: 'notable', count: 3 }) — каждому персонажу отряда
        eventRewards: (config) => offerEventRewards(config),
        openEventRewards: () => new EventRewardsWindow().render({ force: true }),
        // Якорь — хаб в Пределе: game.gachadnd.setAnchor(true) открывает Алтарь всем, false закрывает
        setAnchor: (open = true) => setAnchor(open),
        // Запах отряда для Пожирателя: { value, state, label, thresholds, members }
        scent: () => partyScent(),
        // Портал в Предел на Привале: окно платы кристаллами у всех
        openPortal: () => PortalWindow.open(),
        // Пульс отряда: ступень сложности боёв и итог последнего боя
        pulse: () => pulseReport(),
        // Кладбище Предела: надгробия персонажей, чьи тела отряд оставил на узле
        openGraveyard: () => GraveyardWindow.open(),
        // Предвестия Пожирателя у всех: '3', '2', '1' — ходов до прихода, 'here' — пришёл, 'off' — снять
        omen: stage => setOmen(stage),
        // Прорыв Пожирателя: Мастер щёлкает точку, у всех катсцена, затем его токен в этой точке
        breach: () => startBreach(),
        // Насыщение Пожирателя: game.gachadnd.satiety(+1) — откуп, уход с Брюхом; без числа — текущее
        satiety: delta => delta ? addSatiety(delta, 'Мастер') : getSatiety(),
        // Глубина и Насыщение на листе Пожирателя — заново (restore: ПЗ и легендарные ресурсы на максимум)
        syncDevourer: (options = {}) => syncDevourer(worldDevourer(), options),
        // Правило Босса на текущий бой (Мастер): 'muffle' | 'sleepy' | null — снять
        bossRule: id => (Array.isArray(id) ? setBossRules(game.combat, id) : setBossRule(game.combat, id)),
        // Шрам персонажу: game.gachadnd.scar(actor, 'voice' | 'burn' | 'crack' | без вида — случайный)
        scar: (actor, kind = null) => requestScar(actor, { kind, reason: 'Мастер' }),
        // Сделка луны после Босса: окно с весами у всех (Мастер, отряд на узле Босса)
        openDeal: () => DealWindow.open(),
        // Дары луны в бою (Мастер, по просьбе отряда): Отголосок Босса и натравленный Пожиратель
        callEcho: options => callEcho(options),
        callDevourer: options => callDevourer(options),
        // Жильцы Якоря: окно (focus — чей прилавок: smith, cartographer, broker, healer, lurer) и поселить (Мастер)
        openResidents: focus => ResidentsWindow.open(focus),
        settleResident: id => settleResident(id),
        // Летопись этажа у себя (показ, без рассылки): { oldMap, oldFloor, newMap, newFloor, marks }
        playChronicle: data => playChronicle(data),
        // Событие на узле «Событие» — дневник у всех (Мастер); просмотр события без последствий
        // Новый забег: окно Мастера; startRun — без окна ({ mode, length, anchor })
        newRun: () => NewRunWindow.open(),
        startRun: options => startRun(options),
        openEvent: () => EventWindow.open(),
        previewEvent: id => EventWindow.preview(id)
    });
});

Hooks.on('getSceneControlButtons', (controls) => {
    addTokenTools(controls, [{
        name: 'gachadnd-map',
        title: 'Карта Этажа (Туман)',
        icon: 'fas fa-map-marked-alt',
        visible: true,
        button: true,
        // Паутина — слой: кнопка открывает и закрывает его
        onClick: () => (isWeb(mapScene()?.getFlag('gachadnd', 'floorMap')) ? WebOverlay.toggle() : game.gachadnd.openMapTerminal())
    }, ...(hasResidentSafe('broker') ? [{
        name: 'gachadnd-cells',
        title: 'Ячейки Ростовщика',
        icon: 'fas fa-vault',
        visible: true,
        button: true,
        onClick: () => ResidentsWindow.open('broker')
    }] : []), ...(game.user?.isGM ? [{
        name: 'gachadnd-new-run',
        title: 'Новый забег (Мастер)',
        icon: 'fas fa-flag-checkered',
        visible: true,
        button: true,
        onClick: () => NewRunWindow.open()
    }, {
        name: 'gachadnd-anchor',
        title: 'Якорь: открыть или закрыть хаб (Мастер)',
        icon: 'fas fa-anchor',
        visible: true,
        button: true,
        onClick: () => setAnchor(!isAnchorOpen())
    }] : [])]);
});

// Кнопка ячеек — пока Ростовщик живёт в Якоре (до готовности настроек его нет)
function hasResidentSafe(id) {
    try { return hasResident(id); } catch (error) { return false; }
}
