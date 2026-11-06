/**
 * Gacha Roguelike dnd5e — Правка паутины Мастером и история с отменой
 *
 * Правки (вкладка «Карта» панели Мастера): связать и разорвать нить, переставить отряд без шага, съесть и очистить
 * узел, сдвинуть часы этажа. История: перед каждым изменением карты на этом клиенте (правка, шаг отряда, ход
 * Пожирателя) запоминается прежняя карта с подписью; «Отменить» возвращает её. Хранится в памяти клиента Мастера,
 * до перезагрузки; новый этаж историю сбрасывает.
 */

import { MODULE_ID } from "../core/constants.js";
import { mapScene } from "./scene-travel.js";
import { MAP_DATA } from "./map.js";
import { isWeb, nodeOf, sealed } from "./web-map.js";
import { t } from "../core/i18n.js";

const LIMIT = 20;
const history = [];
let pending = null;      // подпись следующего изменения (правка Мастера)
let restoring = false;   // отмена сама в историю не пишется

const label = n => MAP_DATA.LABELS[n?.type] ?? n?.label ?? '?';

/** Последние записи истории (новые сверху) */
export const editHistory = () => history.slice().reverse().map(h => h.label);

/** Записать прежнюю карту перед изменением флага на этом клиенте */
Hooks.on('preUpdateScene', (scene, changes) => {
    if (!game.user.isGM || restoring) return;
    const next = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.floorMap`);
    if (!next) return;
    const old = scene.getFlag(MODULE_ID, 'floorMap');
    if (!isWeb(old)) { if (!old) history.length = 0; return; }
    // Новый этаж — история с чистого листа
    if (next.nodes && old.nodes && next.nodes.length && next.nodes[0]?.x !== old.nodes[0]?.x) { history.length = 0; pending = null; return; }
    let text = pending;
    if (!text && next.currentNodeId && next.currentNodeId !== old.currentNodeId) text = t('отряд шагнул: «{v}»', { v: label(nodeOf(old, next.currentNodeId)) });
    if (!text && next.web?.devourer !== undefined && next.web.devourer !== old.web?.devourer) text = t('Пожиратель шагнул');
    pending = null;
    history.push({ label: text ?? t('правка карты'), map: foundry.utils.deepClone(old), scene: scene.id });
    if (history.length > LIMIT) history.shift();
});

async function save(map, text) {
    const scene = mapScene();
    if (!scene) return;
    pending = text;
    await scene.setFlag(MODULE_ID, 'floorMap', map);
}

function current() {
    const map = mapScene()?.getFlag(MODULE_ID, 'floorMap');
    if (!game.user.isGM || !isWeb(map)) return null;
    return foundry.utils.deepClone(map);
}

/** Отменить последнее изменение карты */
export async function undoEdit() {
    const last = history.pop();
    if (!last) return ui.notifications.info(t('Отменять нечего.'));
    const scene = game.scenes.get(last.scene) ?? mapScene();
    restoring = true;
    try {
        await scene.unsetFlag(MODULE_ID, 'floorMap');
        await scene.setFlag(MODULE_ID, 'floorMap', last.map);
    } finally { restoring = false; }
    ui.notifications.info(t('Отменено: {label}.', { label: last.label }));
}

/** Связать два узла нитью (Босс — только с внутренней зоной; край — только через Заставы) */
export async function linkNodes(a, b) {
    const map = current();
    if (!map || a === b) return;
    const na = nodeOf(map, a), nb = nodeOf(map, b);
    if (!na || !nb) return;
    if (na.next.includes(b)) return ui.notifications.info(t('Эти узлы уже связаны.'));
    const zones = [na.ring, nb.ring].sort().join('|');
    if (zones === 'boss|outer' || zones === 'inner|outer') return ui.notifications.warn(t('Внешнюю зону с внутренней связывают только Заставы.'));
    na.next.push(b); nb.next.push(a);
    await save(map, t('нить «{v} — {v2}»', { v: label(na), v2: label(nb) }));
}

/** Разорвать нить; если сеть распадётся — отказ */
export async function unlinkNodes(a, b) {
    const map = current();
    if (!map) return;
    const na = nodeOf(map, a), nb = nodeOf(map, b);
    if (!na?.next.includes(b)) return ui.notifications.info(t('Между этими узлами нити нет.'));
    na.next = na.next.filter(id => id !== b); nb.next = nb.next.filter(id => id !== a);
    const seen = new Set(['boss']), queue = ['boss'];
    while (queue.length) for (const id of nodeOf(map, queue.shift()).next) if (!seen.has(id)) { seen.add(id); queue.push(id); }
    if (seen.size !== map.nodes.length) return ui.notifications.warn(t('Без этой нити часть паутины отрежется — не разрываю.'));
    await save(map, t('разорвана нить «{v} — {v2}»', { v: label(na), v2: label(nb) }));
}

/** Переставить отряд на узел без шага (тайный ход, ошибка): часы не идут, окна узла не открываются */
export async function moveParty(id) {
    const map = current();
    const node = map && nodeOf(map, id);
    if (!node) return;
    map.currentNodeId = id;
    if (!map.visitedNodes.includes(id)) map.visitedNodes.push(id);
    await save(map, t('отряд переставлен: «{v}»', { v: label(node) }));
}

/** Съесть узел (как Пожиратель) — Босса и запечатанные Заставы нельзя */
export async function eatNode(id) {
    const map = current();
    const node = map && nodeOf(map, id);
    if (!node) return;
    if (sealed(map, id)) return ui.notifications.warn(t('Босса и непройденную Заставу съесть нельзя.'));
    map.web.eaten = [...new Set([...(map.web.eaten ?? []), id])];
    map.web.touched = (map.web.touched ?? []).filter(([t]) => t !== id);
    await save(map, t('съеден «{v}»', { v: label(node) }));
}

/** Очистить узел: снять поедание и метку */
export async function cleanNode(id) {
    const map = current();
    const node = map && nodeOf(map, id);
    if (!node) return;
    map.web.eaten = (map.web.eaten ?? []).filter(e => e !== id);
    map.web.touched = (map.web.touched ?? []).filter(([t]) => t !== id);
    await save(map, t('очищен «{v}»', { v: label(node) }));
}

/** Сдвинуть часы этажа (награда или наказание события) */
export async function shiftClock(delta) {
    const map = current();
    if (!map) return;
    map.web.ticks = Math.max(0, (map.web.ticks ?? 0) + delta);
    await save(map, t('часы этажа {v}{delta}', { v: delta > 0 ? '+' : '', delta }));
}
