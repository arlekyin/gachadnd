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
        // Сделка луны после Босса: окно с весами у всех (Мастер, отряд на узле Босса)
        openDeal: () => DealWindow.open(),
        // Дары луны в бою (Мастер, по просьбе отряда): Эхо Босса и натравленный Пожиратель
        callEcho: options => callEcho(options),
        callDevourer: options => callDevourer(options),
        // Жильцы Якоря: окно (focus — чей прилавок: smith, cartographer, broker, healer, lurer) и поселить (Мастер)
        openResidents: focus => ResidentsWindow.open(focus),
        settleResident: id => settleResident(id),
        // Летопись этажа у себя (показ, без рассылки): { oldMap, oldFloor, newMap, newFloor, marks }
        playChronicle: data => playChronicle(data),
        // Событие на узле «Событие» — дневник у всех (Мастер); просмотр события без последствий
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
        onClick: () => game.gachadnd.openMapTerminal()
    }, ...(hasResidentSafe('broker') ? [{
        name: 'gachadnd-cells',
        title: 'Ячейки Ростовщика',
        icon: 'fas fa-vault',
        visible: true,
        button: true,
        onClick: () => ResidentsWindow.open('broker')
    }] : []), ...(game.user?.isGM ? [{
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
