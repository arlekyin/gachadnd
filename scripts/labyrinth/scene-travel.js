/**
 * Gacha Roguelike dnd5e — Сцены Лабиринта: где лежит карта этажа и переход в Якорь
 *
 * Карта этажа — флаг floorMap сцены. Сцена, на которой её начертили, запоминается (floorSceneId):
 * Мастер может уйти на другую сцену — боевую карту или сцену Якоря, — а карта, портал, Магазин и
 * Риск по-прежнему читают её оттуда.
 *
 * Сцена Якоря — необязательная настройка. Не выбрана — Якорь остаётся состоянием без смены сцены.
 * Выбрана — портал переносит всех на неё сквозь туман Предела, выход из Якоря возвращает на сцену
 * этажа. Сцена заранее загружается у всех, а туман Предела держится у каждого, пока его сцена не дорисуется.
 */

import { MODULE_ID } from "../core/constants.js";
import { emit, onSocket } from "../core/socket.js";
import { fogLayer } from "../cutscene/fog.js";
import { clamp01, smooth } from "../cutscene/math.js";

export function registerSceneSettings() {
    game.settings.register(MODULE_ID, 'floorSceneId', { scope: 'world', config: false, type: String, default: '' });
}

// Список сцен для выбора известен только после загрузки мира
Hooks.once('setup', () => {
    const choices = { '': '— не переносить (Якорь без своей сцены) —' };
    for (const scene of [...game.scenes].sort((a, b) => a.name.localeCompare(b.name, 'ru'))) choices[scene.id] = scene.name;
    game.settings.register(MODULE_ID, 'anchorSceneId', {
        name: 'Сцена Якоря',
        hint: 'Портал переносит отряд на эту сцену, выход из Якоря возвращает на сцену этажа. Не выбрана — Якорь без смены сцены. Новые сцены появятся в списке после перезагрузки мира.',
        scope: 'world', config: true, type: String, default: '', choices
    });
});

/** Сцена Якоря или null */
export function anchorScene() {
    try {
        const id = game.settings.get(MODULE_ID, 'anchorSceneId');
        return (id && game.scenes.get(id)) || null;
    } catch (err) {
        return null;
    }
}

/**
 * Сцена с картой этажа: текущая, если карта на ней; иначе запомненная сцена этажа; иначе текущая
 * (на ней карту и начертят).
 */
export function mapScene() {
    const here = globalThis.canvas?.scene ?? null;
    if (here?.getFlag(MODULE_ID, 'floorMap')) return here;
    let id = '';
    try { id = game.settings.get(MODULE_ID, 'floorSceneId'); } catch (err) { id = ''; }
    const remembered = id ? game.scenes.get(id) : null;
    if (remembered?.getFlag(MODULE_ID, 'floorMap')) return remembered;
    return here;
}

/** Где чертить новую карту: на текущей сцене, если это не сцена Якоря; иначе на сцене этажа */
export function sceneForNewMap() {
    const here = globalThis.canvas?.scene ?? null;
    if (here && here.id !== anchorScene()?.id) return here;
    return mapScene() ?? here;
}

/** Мастер запоминает сцену с картой */
export async function rememberFloorScene(scene) {
    if (!game.user.isGM || !scene) return;
    if (game.settings.get(MODULE_ID, 'floorSceneId') !== scene.id) await game.settings.set(MODULE_ID, 'floorSceneId', scene.id);
}

/** Все клиенты заранее загружают картинки сцены */
export function preloadScene(scene) {
    if (!scene || !game.user.isGM) return;
    try {
        // v14 принимает настройки, до v13 — флаг «разослать всем»
        const broadcast = (game.release?.generation ?? 12) >= 14 ? { broadcast: true } : true;
        game.scenes.preload(scene.id, broadcast);
    } catch (error) {
        console.warn(`${MODULE_ID} | предзагрузка сцены`, error);
    }
}

/** Промис: эта сцена открыта и дорисована у этого клиента (или истекло timeout мс) */
export function arrival(sceneId, timeout = 8000) {
    if (!sceneId || (globalThis.canvas?.ready && canvas.scene?.id === sceneId)) return Promise.resolve(true);
    return new Promise(resolve => {
        const done = ok => { Hooks.off('canvasReady', hook); clearTimeout(timer); resolve(ok); };
        const hook = Hooks.on('canvasReady', c => { if ((c ?? canvas).scene?.id === sceneId) done(true); });
        const timer = setTimeout(() => done(false), timeout);
    });
}

/**
 * Переход на сцену под туманом Предела (без катсцены — кнопка Якоря, выход из Якоря). Мастер рассылает
 * его всем: у каждого туман наползает от краёв и закрывает экран, Мастер активирует сцену, туман
 * отступает, когда сцена дорисована.
 */
export async function travelTo(scene) {
    if (!game.user.isGM || !scene || canvas.scene?.id === scene.id) return;
    preloadScene(scene);
    emit('sceneTravel', { sceneId: scene.id });
    const shown = fogVeil(scene.id);
    await new Promise(r => setTimeout(r, VEIL.in + 60));
    await scene.activate();
    await shown;
}
onSocket('sceneTravel', ({ sceneId }) => fogVeil(sceneId));

const VEIL = { in: 900, out: 1100 };
let veiled = false;

/** Туман: наползает, держится до прибытия на сцену, отступает */
function fogVeil(sceneId) {
    if (veiled) return Promise.resolve(false);
    veiled = true;
    const fog = fogLayer();
    const t0 = performance.now();
    const fade = (from, to, ms) => new Promise(resolve => {
        const start = performance.now();
        const step = now => {
            const k = clamp01((now - start) / ms);
            fog.render(from + (to - from) * smooth(k), (now - t0) / 1000);
            if (k < 1) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
    });
    return (async () => {
        try {
            await fade(0, 1, VEIL.in);
            // Пока сцена грузится, клубы продолжают ползти
            let waiting = true;
            const drift = now => { if (!waiting) return; fog.render(1, (now - t0) / 1000); requestAnimationFrame(drift); };
            requestAnimationFrame(drift);
            await arrival(sceneId);
            waiting = false;
            await fade(1, 0, VEIL.out);
        } finally {
            fog.remove();
            veiled = false;
        }
        return true;
    })();
}
