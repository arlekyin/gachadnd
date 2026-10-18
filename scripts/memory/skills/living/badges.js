/**
 * Gacha Roguelike dnd5e — Значки счётчиков на токенах
 *
 * Счётчики живых навыков персонажа (зарубки, провалы, убитые огнём) — у его токена, видят владелец и
 * Мастер. Обратный отсчёт — над носителем, видят все: угроза, которую видно заранее. Ничего на сцене не
 * создаётся — у каждого клиента рисуется своё.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { isAwake } from "../../synergy/synergy.js";
import { counterOf, counterMax } from "./common.js";
import { countdownsOf } from "./countdown.js";

const NAME = 'gdLivingBadge';
const SHOWN = {
    hone: item => `⚒ ${counterOf(item)}/${counterMax(item, 4)}`,
    third: item => (counterOf(item) ? `☯ ${counterOf(item)}/2` : null),
    ember: item => `🔥 ${counterOf(item)}`
};

function labels(token) {
    const out = [];
    const actor = token.actor;
    if (actor && (game.user.isGM || actor.isOwner)) {
        for (const item of actor.items) {
            const show = SHOWN[item.flags?.[MODULE_ID]?.living];
            const text = show && isAwake(item) ? show(item) : null;
            if (text) out.push({ text, color: 0xf3e3c0 });
        }
    }
    for (const c of countdownsOf(game.combat)) {
        if (c.tokenId === token.document.id) out.push({ text: `⏱ ${c.value}`, color: 0xff6a3d, big: true });
    }
    return out;
}

function draw(token) {
    token.children?.find(c => c.name === NAME)?.destroy({ children: true });
    const list = labels(token);
    if (!list.length) return;
    const box = new PIXI.Container();
    box.name = NAME;
    box.eventMode = 'none';
    let y = 0;
    for (const { text, color, big } of list) {
        const label = new PIXI.Text(text, {
            fontFamily: 'Signika, sans-serif', fontSize: Math.max(13, token.w * (big ? 0.2 : 0.14)), fontWeight: '700',
            fill: color, stroke: 0x141210, strokeThickness: 4
        });
        label.position.set(0, y);
        y += label.height - 2;
        box.addChild(label);
    }
    box.position.set(-box.width * 0.15, -y * 0.55);
    token.addChild(box);
}

function refreshAll() {
    if (!canvas?.ready) return;
    for (const token of canvas.tokens.placeables) draw(token);
}

let timer = null;
const later = () => { clearTimeout(timer); timer = setTimeout(refreshAll, 80); };
Hooks.on('refreshToken', token => { if (!token.children?.some(c => c.name === NAME) && labels(token).length) draw(token); });
for (const hook of ['canvasReady', 'updateCombat', 'deleteCombat', 'updateItem', 'createItem', 'deleteItem', 'createToken', 'controlToken']) Hooks.on(hook, later);
