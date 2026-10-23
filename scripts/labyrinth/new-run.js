/**
 * Gacha Roguelike dnd5e — Новый забег: одно окно Мастера (docs/quickstart.md)
 *
 * Отряд — персонажи с игроками (как везде в модуле, partyActors): уровень каждого; не 1 — предупреждение,
 * решает Мастер. Карта — ряды или паутина, длина рядов. Якорь — без сцены, простая сцена или своя.
 * «Начать»: сцена «Лабиринт: этаж 1» — тёмная подложка, этаж 1 начерчен на ней, Якорь открыт (у игроков —
 * Алтарь), у Мастера — «Как вести забег», в чат всем — карточка со ссылкой на правила «Забег».
 * Старая карта остаётся на своей сцене.
 *
 * При первом запуске модуля в мире Мастеру — шёпот с кнопкой «Новый забег» (подсказка hintWelcome).
 */

import { MODULE_ID } from "../core/constants.js";
import { hint } from "../core/prefs.js";
import { onRenderChatMessage } from "../core/chat-hooks.js";
import { partyActors } from "./horsemen.js";
import { drawFloor } from "./map.js";
import { setAnchor, isAnchorOpen } from "./anchor.js";
import { anchorScene, mapScene } from "./scene-travel.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const WINDOW_ID = 'gachadnd-new-run';
// Подложки новых сцен: тёмная бирюза Тумана; у Якоря — светлее, под куполом
const FLOOR_COLOR = '#0c1416', ANCHOR_COLOR = '#132a2b';
// Главы правил: Мастеру — «Как вести забег», игрокам — «Забег»
const GUIDES = { gm: ['gacha-gm', 'Как вести забег'], player: ['gacha-rules', 'Забег'] };

const levelOf = actor => Number(actor?.system?.details?.level) || 0;

/** UUID страницы правил по названию: id в компендиуме сборка не обещает сохранять */
async function guideUuid([pack, page]) {
    const compendium = game.packs.get(`${MODULE_ID}.${pack}`);
    if (!compendium) return null;
    for (const entry of await compendium.getDocuments()) {
        const found = entry.pages.find(p => p.name === page);
        if (found) return found.uuid;
    }
    return null;
}

export class NewRunWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: WINDOW_ID,
        classes: ['gachadnd-new-run'],
        tag: 'form',
        window: { title: 'Новый забег', icon: 'fas fa-flag-checkered' },
        position: { width: 520 },
        form: { handler: NewRunWindow.#onStart, closeOnSubmit: true }
    };

    static PARTS = { body: { template: 'modules/gachadnd/templates/new-run/body.hbs' } };

    static open() {
        if (!game.user.isGM) return ui.notifications.warn('Начинать забег может только Мастер.');
        const existing = foundry.applications.instances?.get(WINDOW_ID);
        if (existing) return existing.render({ force: true });
        return new NewRunWindow().render({ force: true });
    }

    async _prepareContext() {
        const party = partyActors().filter(a => a.hasPlayerOwner).map(a => ({ name: a.name, img: a.img, level: levelOf(a), warn: levelOf(a) !== 1 }));
        const old = mapScene()?.getFlag(MODULE_ID, 'floorMap');
        const anchor = anchorScene();
        return {
            party,
            noParty: !party.length,
            mode: game.settings.get(MODULE_ID, 'mapMode') === 'web' ? 'web' : 'rows',
            length: 11,
            oldMap: !!old?.visitedNodes?.length,
            anchorScene: anchor?.id ?? '',
            scenes: [...game.scenes].filter(s => !s.getFlag(MODULE_ID, 'floorMap')).sort((a, b) => a.name.localeCompare(b.name, 'ru')).map(s => ({ id: s.id, name: s.name }))
        };
    }

    static async #onStart(event, form, formData) {
        const data = formData.object;
        return startRun({
            mode: data.mode === 'web' ? 'web' : 'rows',
            length: Math.min(15, Math.max(6, Number(data.length) || 11)),
            anchor: data.anchor || 'none'
        });
    }
}

/**
 * Начать забег (Мастер).
 * @param {{ mode?: 'rows'|'web', length?: number, anchor?: 'none'|'create'|string }} options  anchor — id своей сцены
 * @returns {Promise<{ floor: Scene, anchor: Scene|null }>}
 */
export async function startRun({ mode = 'rows', length = 11, anchor = 'none' } = {}) {
    if (!game.user.isGM) return ui.notifications.warn('Начинать забег может только Мастер.');
    // Якорь закрывается: новый забег начинается заново
    if (isAnchorOpen()) await game.settings.set(MODULE_ID, 'anchorOpen', false);

    const floor = await Scene.create({
        name: 'Лабиринт: этаж 1', backgroundColor: FLOOR_COLOR, width: 3000, height: 2000, padding: 0,
        grid: { type: 1, size: 100, distance: 5, units: 'ft' }, tokenVision: false,
        environment: { darknessLevel: 0.35, globalLight: { enabled: true } },
        flags: { [MODULE_ID]: { newRun: 'floor' } }
    });
    await drawFloor({ length, mode, floor: 1, scene: floor, fresh: true });

    let anchorDoc = null;
    if (anchor === 'create') {
        anchorDoc = await Scene.create({
            name: 'Якорь', backgroundColor: ANCHOR_COLOR, width: 2000, height: 1400, padding: 0,
            grid: { type: 1, size: 100, distance: 5, units: 'ft' }, tokenVision: false,
            environment: { darknessLevel: 0.15, globalLight: { enabled: true } },
            flags: { [MODULE_ID]: { newRun: 'anchor' } }
        });
    } else if (anchor !== 'none') anchorDoc = game.scenes.get(anchor) ?? null;
    await setAnchorScene(anchorDoc);
    // Без сцены Якоря все — на сцене этажа; со сценой — Якорь сам переносит туда отряд
    if (!anchorDoc) { await floor.activate(); await floor.view(); }
    // Каждая сессия начинается в Якоре: у игроков открывается Алтарь
    await setAnchor(true);

    const [gmGuide, playerGuide] = await Promise.all([guideUuid(GUIDES.gm), guideUuid(GUIDES.player)]);
    if (gmGuide) (await fromUuid(gmGuide))?.parent?.sheet?.render(true, { pageId: gmGuide.split('.').pop() });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Лабиринт' }),
        content: `<div class="gd-scent-chat gd-new-run-card"><i class="fas fa-flag-checkered"></i> <strong>Забег начинается.</strong>
            Отряд под куполом Якоря; за его границей — первый этаж Лабиринта.
            ${playerGuide ? `<p>Как устроен забег: @UUID[${playerGuide}]{Забег}</p>` : ''}</div>`
    });
    Hooks.callAll('gachadnd.runStarted', { floor, anchor: anchorDoc });
    return { floor, anchor: anchorDoc };
}

/** Сцена Якоря в настройке. Список выбора строится при загрузке мира — новая сцена дописывается в него */
async function setAnchorScene(scene) {
    const config = game.settings.settings.get(`${MODULE_ID}.anchorSceneId`);
    if (scene && config?.choices && !(scene.id in config.choices)) config.choices[scene.id] = scene.name;
    await game.settings.set(MODULE_ID, 'anchorSceneId', scene?.id ?? '');
}

// ==========================================
// ПЕРВЫЙ ЗАПУСК: шёпот Мастеру с кнопкой
// ==========================================

Hooks.once('init', () => {
    game.settings.register(MODULE_ID, 'welcomeShown', { scope: 'world', config: false, type: Boolean, default: false });
});

/** Шёпот Мастеру: модуль готов, «Новый забег» — кнопкой. Один раз на мир */
export async function showWelcome({ force = false } = {}) {
    if (!game.user.isGM || (game.users.activeGM && game.users.activeGM.id !== game.user.id)) return;
    if (!force && (game.settings.get(MODULE_ID, 'welcomeShown') || !hint('hintWelcome'))) return;
    await game.settings.set(MODULE_ID, 'welcomeShown', true);
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Лабиринт' }),
        whisper: game.users.filter(u => u.isGM).map(u => u.id),
        content: `<div class="gd-scent-chat gd-new-run-card"><i class="fas fa-flag-checkered"></i> <strong>Gacha Roguelike готов.</strong>
            Окно «Новый забег» начертит первый этаж и откроет Якорь. Оно же — кнопкой с флажком на панели токенов.
            <p><button type="button" data-gd-new-run><i class="fas fa-flag-checkered"></i> Новый забег</button></p></div>`,
        flags: { [MODULE_ID]: { welcome: true } }
    });
}
Hooks.once('ready', () => { setTimeout(() => showWelcome().catch(error => console.error(`${MODULE_ID} | приветствие`, error)), 2000); });

onRenderChatMessage((message, html) => {
    if (!message.getFlag?.(MODULE_ID, 'welcome') || !html?.querySelector) return;
    html.querySelector('[data-gd-new-run]')?.addEventListener('click', event => { event.preventDefault(); NewRunWindow.open(); });
});
