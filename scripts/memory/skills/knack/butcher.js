/**
 * Gacha Roguelike dnd5e — Чутьё мясника (серый навык крови и казни)
 *
 * Пассивный: над существом в 30 футах от персонажа, у которого меньше половины максимума ПЗ, висит
 * капля крови. Её видит только тот, кто ведёт персонажа: игрок-владелец, а Мастер — пока выделил его
 * токен. Рисуется у каждого клиента своё: ничего на сцене не создаётся.
 */

import { knackSkill, feetBetween } from "./common.js";

const RANGE = 30;
const MARK = 'gdButcherDrop';

/** Токены, глазами которых смотрит этот клиент: свои персонажи с навыком (у Мастера — выделенные) */
function watchers(scene) {
    return scene.tokens.filter(t => {
        if (!t.actor || !knackSkill(t.actor, 'butcher')) return false;
        return game.user.isGM ? !!t.object?.controlled : t.actor.isOwner;
    });
}

/** Существа под каплей для этого клиента */
export function butcherMarks(scene = canvas?.scene) {
    if (!scene) return [];
    const eyes = watchers(scene);
    if (!eyes.length) return [];
    const reach = RANGE - (scene.grid.distance || 5);
    return scene.tokens.filter(t => {
        const hp = t.actor?.system?.attributes?.hp;
        if (!hp || !(hp.max > 0) || hp.value <= 0 || hp.value >= hp.max / 2) return false;
        return eyes.some(e => e.id !== t.id && feetBetween(e, t) <= reach);
    }).map(t => t.id);
}

function draw(token, marked) {
    let drop = token.children?.find(c => c.name === MARK);
    if (!marked) {
        if (drop) drop.destroy();
        return;
    }
    if (!drop) {
        drop = new PIXI.Graphics();
        drop.name = MARK;
        drop.eventMode = 'none';
        const s = Math.max(10, token.w * 0.12);
        drop.lineStyle(2, 0x2a0006, 0.9).beginFill(0xc8102e, 0.95)
            .moveTo(0, -s * 1.6).bezierCurveTo(s * 0.9, -s * 0.4, s, s * 0.2, 0, s)
            .bezierCurveTo(-s, s * 0.2, -s * 0.9, -s * 0.4, 0, -s * 1.6).endFill();
        drop.beginFill(0xffffff, 0.55).drawEllipse(-s * 0.3, -s * 0.1, s * 0.15, s * 0.28).endFill();
        token.addChild(drop);
    }
    drop.position.set(token.w / 2, -drop.height * 0.35);
}

// Капли пересчитываются по событиям (ПЗ, движение, выделение, экипировка), а не на каждой перерисовке токена
let marks = new Set();

function refreshAll() {
    if (!canvas?.ready) return;
    marks = new Set(butcherMarks());
    for (const token of canvas.tokens.placeables) draw(token, marks.has(token.document.id));
}

let timer = null;
const later = () => { clearTimeout(timer); timer = setTimeout(refreshAll, 60); };

// Токен перерисовался заново (новая текстура и т. п.) — вернуть каплю, если она ему положена
Hooks.on('refreshToken', token => {
    const has = !!token.children?.some(c => c.name === MARK);
    const marked = marks.has(token.document.id);
    if (has !== marked) draw(token, marked);
});
for (const hook of ['canvasReady', 'updateActor', 'updateToken', 'controlToken', 'createToken', 'deleteToken', 'updateItem', 'createItem', 'deleteItem']) Hooks.on(hook, later);
