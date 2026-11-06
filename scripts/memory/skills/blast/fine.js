/**
 * Gacha Roguelike dnd5e — Это нормально (фиолетовый навык огня)
 *
 * Использование в бою — выбор свободной клетки в пределах дальности: она загорается. В начале
 * каждого раунда огонь перекидывается на соседние по стороне клетки — не сквозь стены движения и
 * не дальше 30 футов от первой клетки (по сетке). Пожар горит 10 раундов или до конца боя.
 *
 * Существо, которое начинает ход в горящей клетке или впервые за свой ход заходит в неё, получает
 * урон навыка (огонь, без спасброска). Владелец пожара урона не получает, а начиная ход в огне,
 * получает временные ПЗ, равные бонусу мастерства.
 *
 * Флаг боя fire { actorId, tokenId, origin, cells, until, formula, hit } — клетки [x, y], hit — кто уже
 * горел в этот ход. Огонь на сцене рисует каждый клиент по флагу.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { pickCell } from "../pick.js";
import { cellOf, occupied, key, wallBetween } from "../grid.js";
import { isBlast, ref, actorFrom, tokenOf, esc, quiet, damageOf, blast } from "./common.js";
import { t } from "../../../core/i18n.js";

const ROUNDS = 10, SPREAD_FT = 30;
const FLAG = 'fire';

const chosen = new Map();

Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isBlast(item, 'fine') || !actor) return;
    quiet(usage, message);
    if (chosen.has(item.id)) return;
    const combat = game.combat;
    const caster = tokenOf(actor);
    if (!combat?.started || !combat.combatants.some(c => c.actor?.id === actor.id) || !caster) {
        ui.notifications.warn(t('Это нормально — только в бою, в котором участвует персонаж с токеном на сцене.'));
        return false;
    }
    const size = canvas.grid.size;
    const taken = occupied(canvas.scene, size);
    pickCell({
        caster, range: Number(activity.range?.value) || 30,
        allowed: cell => !taken.has(key(...cell)),
        draw: (g, cell, ok, s) => g.lineStyle(3, ok ? 0xff7a1a : 0xff3030, 0.9).beginFill(0xff7a1a, ok ? 0.35 : 0.1).drawRect(cell[0] * s, cell[1] * s, s, s).endFill(),
        hint: t('Это нормально: выберите клетку для пожара. Правая кнопка или Esc — отмена.')
    }).then(cell => {
        if (!cell) return;
        chosen.set(item.id, cell);
        return Promise.resolve(activity.use()).finally(() => chosen.delete(item.id));
    }).catch(error => console.error(`${MODULE_ID} | Это нормально`, error));
    return false;
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item;
    const cell = chosen.get(item?.id);
    if (!cell) return;
    chosen.delete(item.id);
    const damage = damageOf(item, { formula: '2d6', type: 'fire' });
    requestGM('blastFine', { ...ref(item.actor), cell, formula: damage.formula });
});

onSocket('blastFine', ({ payload }) => {
    if (isActiveGM()) ignite(payload).catch(error => console.error(`${MODULE_ID} | Это нормально`, error));
});

/** Мастер: пожар в клетке */
export async function ignite({ actorId, tokenId, sceneId, cell, formula }) {
    const combat = game.combat;
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!combat || !actor) return;
    await combat.setFlag(MODULE_ID, FLAG, { actorId: actor.id, tokenId, origin: cell, cells: [cell], until: combat.round + ROUNDS, formula, hit: {} });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-fire"></i> ${t('Это нормально')}</div><p>${t('Загорелась клетка. Огонь расходится каждый раунд — до 30 футов. {v} спокойно пьёт кофе.', { v: esc(actor.name) })}</p></div>`
    });
}

const stateOf = combat => combat?.getFlag(MODULE_ID, FLAG) ?? null;

/** Новый раунд: огонь на соседние клетки */
export function spread(scene, state) {
    const size = scene.grid.size, reach = Math.floor(SPREAD_FT / (scene.grid.distance || 5));
    const w = Math.floor(scene.dimensions.sceneWidth / size), h = Math.floor(scene.dimensions.sceneHeight / size);
    const x0 = Math.floor(scene.dimensions.sceneX / size), y0 = Math.floor(scene.dimensions.sceneY / size);
    const burning = new Set(state.cells.map(c => key(...c)));
    const next = [...state.cells];
    const center = c => ({ x: c[0] * size + size / 2, y: c[1] * size + size / 2 });
    for (const c of state.cells) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = [c[0] + dx, c[1] + dy];
            if (burning.has(key(...n))) continue;
            if (n[0] < x0 || n[1] < y0 || n[0] >= x0 + w || n[1] >= y0 + h) continue;
            if (Math.max(Math.abs(n[0] - state.origin[0]), Math.abs(n[1] - state.origin[1])) > reach) continue;
            if (wallBetween(center(c), center(n))) continue;
            burning.add(key(...n));
            next.push(n);
        }
    }
    return next;
}

const tokenCells = (token, at = token) => {
    const size = token.parent.grid.size;
    const out = [];
    const [i0, j0] = cellOf(at, size);
    for (let i = 0; i < (token.width || 1); i++) for (let j = 0; j < (token.height || 1); j++) out.push(key(i0 + i, j0 + j));
    return out;
};

/** Существо в огне: урон (или временные ПЗ владельцу) — раз за ход */
async function scorch(combat, token, at = token) {
    const state = stateOf(combat);
    if (!state || !token.actor) return;
    const turnKey = `${combat.round}:${combat.turn}`;
    if (state.hit?.[token.id] === turnKey) return;
    const burning = new Set(state.cells.map(c => key(...c)));
    if (!tokenCells(token, at).some(k => burning.has(k))) return;
    await combat.update({ [`flags.${MODULE_ID}.${FLAG}.hit.${token.id}`]: turnKey });
    const owner = actorFrom({ actorId: state.actorId, tokenId: state.tokenId, sceneId: token.parent.id });
    if (token.actor.id === state.actorId) {
        const prof = Number(token.actor.system.attributes.prof) || 2;
        if ((token.actor.system.attributes.hp.temp ?? 0) < prof) await token.actor.update({ 'system.attributes.hp.temp': prof });
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: token.actor }), content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-mug-hot"></i> ${t('Это нормально')}</div><p>${t('{v} в огне — и всё нормально: временные ПЗ {prof}.', { v: esc(token.name), prof })}</p></div>` });
        return;
    }
    await blast({ actor: owner ?? token.actor, title: t('Это нормально — пожар'), icon: 'fa-fire', victims: [token], formula: state.formula, type: 'fire' });
}

Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !isActiveGM() || !combat.started) return;
    const state = stateOf(combat);
    if (!state) return;
    const scene = combat.scene ?? canvas.scene;
    if ('round' in changed) {
        if (combat.round >= state.until) {
            await combat.unsetFlag(MODULE_ID, FLAG);
            await ChatMessage.create({ content: t('<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-fire"></i> Это нормально</div><p>Пожар догорел.</p></div>') });
            return;
        }
        await combat.update({ [`flags.${MODULE_ID}.${FLAG}.cells`]: spread(scene, state) });
    }
    const token = combat.combatant?.token;
    if (token && (token.actor?.system?.attributes?.hp?.value ?? 1) > 0) await scorch(combat, token);
});

// Зашёл в огонь в свой ход: v13 — конец пути в moveToken, v12 — updateToken
function entered(token, at) {
    const combat = game.combat;
    if (!isActiveGM() || !combat?.started || combat.combatant?.tokenId !== token.id || !stateOf(combat)) return;
    scorch(combat, token, at).catch(error => console.error(`${MODULE_ID} | Это нормально`, error));
}
Hooks.on('moveToken', (token, movement) => {
    if (movement?.pending?.waypoints?.length) return;
    const end = movement?.destination ?? movement?.passed?.waypoints?.at(-1);
    if (end) entered(token, end);
});
Hooks.on('updateToken', (token, changes) => {
    if (typeof token.move === 'function' || !('x' in changes || 'y' in changes)) return;
    entered(token, token);
});

// ==========================================
// ОГОНЬ НА СЦЕНЕ (у каждого клиента по флагу боя)
// ==========================================

let layer = null, ticker = null;
function render() {
    const state = canvas?.ready ? stateOf(game.combat) : null;
    if (!state || game.combat.scene?.id !== canvas.scene?.id) {
        if (ticker) canvas.app?.ticker.remove(ticker);
        ticker = null;
        if (layer && !layer.destroyed) layer.destroy({ children: true });
        layer = null;
        return;
    }
    if (!layer || layer.destroyed) {
        layer = new PIXI.Container();
        layer.eventMode = 'none';
        (canvas.interface ?? canvas.controls).addChildAt(layer, 0);
    }
    layer.removeChildren().forEach(c => c.destroy());
    const size = canvas.grid.size;
    const g = new PIXI.Graphics();
    for (const [x, y] of state.cells) {
        g.beginFill(0xff5a00, 0.32).drawRect(x * size + 2, y * size + 2, size - 4, size - 4).endFill();
        g.beginFill(0xffc23c, 0.28).drawEllipse(x * size + size / 2, y * size + size * 0.62, size * 0.28, size * 0.22).endFill();
    }
    layer.addChild(g);
    if (!ticker) {
        ticker = () => { if (layer && !layer.destroyed) layer.alpha = 0.8 + 0.2 * Math.sin(performance.now() / 140); };
        canvas.app.ticker.add(ticker);
    }
}
for (const hook of ['canvasReady', 'updateCombat', 'deleteCombat', 'createCombat']) Hooks.on(hook, () => setTimeout(render, 0));
