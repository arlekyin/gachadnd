/**
 * Gacha Roguelike dnd5e — Кот Шрёдингера (фиолетовый навык)
 *
 * Использование — вторая копия токена персонажа в свободной клетке в пределах дальности навыка.
 * До начала следующего хода персонаж в суперпозиции: оба токена полупрозрачны, двигать можно любой.
 *
 * Схлопывание:
 *   - урон по персонажу — монетка: «настоящий» — урон проходит, исчезает второй токен;
 *     «пустышка» — урон отменяется, исчезает тот, по кому попали. По кому — по цели или
 *     выделению у того, кто применяет урон; не ясно — спрашивается;
 *   - действие персонажа (любое использование, кроме самого навыка) — из выделенного токена:
 *     он настоящий, второй исчезает;
 *   - начало хода персонажа — владелец выбирает, где он на самом деле.
 * Настоящим всегда остаётся исходный токен (он в трекере боя): если «победила» копия, исходный
 * встаёт на её место, а копия удаляется.
 */

import { MODULE_ID } from "../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { key, occupied } from "./grid.js";
import { pickCell, placeToken } from "./pick.js";

const ALPHA = 0.6;
const isCat = item => !!item?.flags?.[MODULE_ID]?.cat;

/** Суперпозиция персонажа на текущей сцене: { original, copy } (документы токенов) или null */
export function superposition(actor) {
    const scene = canvas?.scene;
    if (!actor || !scene) return null;
    for (const token of scene.tokens) {
        const flag = token.flags?.[MODULE_ID]?.cat;
        if (!flag?.copyId || token.actor?.id !== actor.id) continue;
        const copy = scene.tokens.get(flag.copyId);
        if (copy) return { original: token, copy };
    }
    return null;
}

// ==========================================
// РАЗДВОЕНИЕ
// ==========================================

Hooks.on('dnd5e.preUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!actor) return;
    if (isCat(item)) {
        if (!canvas?.ready || !canvas.grid?.isSquare) {
            ui.notifications.warn('Кот Шрёдингера работает только на сцене с квадратной сеткой.');
            return false;
        }
        if (!actor.getActiveTokens?.()[0]) {
            ui.notifications.warn('Токена персонажа нет на сцене.');
            return false;
        }
        if (superposition(actor)) {
            ui.notifications.warn('Персонаж уже в суперпозиции.');
            return false;
        }
        return;
    }
    // Любое другое действие — наблюдение: настоящий тот, из которого действуют
    const pair = superposition(actor);
    if (!pair) return;
    const controlled = canvas.tokens?.controlled.map(t => t.document) ?? [];
    const keep = controlled.some(t => t.id === pair.copy.id) ? 'copy' : 'original';
    requestGM('catCollapse', { sceneId: canvas.scene.id, originalId: pair.original.id, keep, reason: `действие: ${item.name}` });
});

Hooks.on('dnd5e.postUseActivity', async (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isCat(item) || !actor) return;
    const caster = actor.getActiveTokens()[0];
    const range = Number(activity.range?.value ?? item.system.range?.value) || 30;
    const scene = canvas.scene, size = canvas.grid.size;
    const taken = occupied(scene, size);
    const doc = caster.document;
    const fits = cell => {
        for (let dx = 0; dx < (doc.width || 1); dx++) for (let dy = 0; dy < (doc.height || 1); dy++) {
            if (taken.has(key(cell[0] + dx, cell[1] + dy))) return false;
        }
        return true;
    };
    const cell = await pickCell({
        caster, range, allowed: fits,
        hint: 'Кот Шрёдингера: клик — где появится вторая копия, правая кнопка или Esc — отмена.',
        draw: (g, [x, y], ok, s) => {
            const w = (doc.width || 1) * s, h = (doc.height || 1) * s;
            const tint = ok ? 0xb58cff : 0xff4d4d;
            g.lineStyle(3, tint, 0.95).beginFill(tint, 0.2).drawEllipse(x * s + w / 2, y * s + h / 2, w * 0.45, h * 0.45).endFill();
            g.lineStyle(2, 0xffffff, 0.35).moveTo(caster.center.x, caster.center.y).lineTo(x * s + w / 2, y * s + h / 2);
        }
    });
    if (!cell) {
        const spent = Number(item.system.uses?.spent ?? 0);
        if (item.system.uses?.max && spent > 0) await item.update({ 'system.uses.spent': spent - 1 });
        return ui.notifications.info('Кот Шрёдингера отменён.');
    }
    requestGM('catSplit', { sceneId: scene.id, tokenId: doc.id, x: cell[0] * size, y: cell[1] * size });
});

onSocket('catSplit', ({ payload }) => {
    if (!isActiveGM()) return;
    split(payload).catch(error => console.error(`${MODULE_ID} | Кот Шрёдингера`, error));
});

async function split({ sceneId, tokenId, x, y }) {
    const scene = game.scenes.get(sceneId);
    const original = scene?.tokens.get(tokenId);
    if (!original) return;
    const data = original.toObject();
    delete data._id;
    Object.assign(data, { x, y, alpha: ALPHA });
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.cat`, { originalId: original.id });
    const [copy] = await scene.createEmbeddedDocuments('Token', [data]);
    await original.update({ alpha: ALPHA, [`flags.${MODULE_ID}.cat`]: { copyId: copy.id, alpha: original.alpha ?? 1 } });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token: original }),
        content: `<div class="gd-cat-card"><strong>Кот Шрёдингера</strong> — ${foundry.utils.escapeHTML?.(original.name) ?? original.name} теперь в двух местах сразу. Где он на самом деле, не знает никто.</div>`
    });
}

// ==========================================
// СХЛОПЫВАНИЕ
// ==========================================

onSocket('catCollapse', ({ payload }) => {
    if (!isActiveGM()) return;
    collapse(payload).catch(error => console.error(`${MODULE_ID} | Кот Шрёдингера`, error));
});

/** keep: 'original' | 'copy' — какой из токенов настоящий */
async function collapse({ sceneId, originalId, keep, reason = '' }) {
    const scene = game.scenes.get(sceneId);
    const original = scene?.tokens.get(originalId);
    const copyId = original?.flags?.[MODULE_ID]?.cat?.copyId;
    if (!original || !copyId) return;
    const copy = scene.tokens.get(copyId);
    const alpha = original.flags[MODULE_ID].cat.alpha ?? 1;
    await original.update({ alpha, [`flags.${MODULE_ID}.-=cat`]: null });
    if (copy && keep === 'copy') await placeToken(original, copy.x, copy.y);
    if (copy) await scene.deleteEmbeddedDocuments('Token', [copy.id]);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token: original }),
        content: `<div class="gd-cat-card"><strong>Кот Шрёдингера</strong> — суперпозиция схлопнулась${reason ? ` (${foundry.utils.escapeHTML?.(reason) ?? reason})` : ''}: настоящий — ${keep === 'copy' ? 'вторая копия' : 'исходный'}.</div>`
    });
}

// Урон, уже решённый монеткой (после вопроса «по кому»), проходит без новой монетки
const decided = new Set();

// Урон по персонажу в суперпозиции: монетка. Решается сразу — отменить урон можно только здесь
Hooks.on('dnd5e.preApplyDamage', (actor, amount) => {
    if (!(amount > 0)) return;
    if (decided.delete(actor.id)) return;
    const pair = superposition(actor);
    if (!pair) return;
    const ids = [pair.original.id, pair.copy.id];
    // По кому попали: цель или выделение у того, кто применяет урон
    const pointed = [...(game.user.targets ?? [])].map(t => t.document.id).find(id => ids.includes(id))
        ?? (canvas.tokens?.controlled ?? []).map(t => t.document.id).find(id => ids.includes(id));
    const real = Math.random() < 0.5;
    if (pointed) {
        // Настоящий — попали по нему, он остаётся; пустышка — исчезает он
        const hitCopy = pointed === pair.copy.id;
        const keep = real === hitCopy ? 'copy' : 'original';
        coin(actor, real, amount);
        requestGM('catCollapse', { sceneId: canvas.scene.id, originalId: pair.original.id, keep, reason: real ? 'попали по настоящему' : 'попали по пустышке' });
        return real ? undefined : false;
    }
    // Не ясно, по кому: урон ждёт ответа
    askHit(actor, pair, amount, real);
    return false;
});

function coin(actor, real, amount) {
    ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-cat-card gd-cat-coin ${real ? 'real' : 'empty'}"><strong>Монетка</strong> — ${real ? `настоящий! Урон ${amount} проходит.` : 'пустышка! Урон уходит в никуда.'}</div>`
    });
}

async function askHit(actor, pair, amount, real) {
    const DialogV2 = foundry.applications.api.DialogV2;
    const choice = await DialogV2.wait({
        window: { title: 'Кот Шрёдингера' },
        content: `<p>По какому токену ${foundry.utils.escapeHTML?.(actor.name) ?? actor.name} пришёлся урон ${amount}?</p>`,
        buttons: [
            { action: 'original', label: 'Исходный', default: true },
            { action: 'copy', label: 'Копия' }
        ],
        rejectClose: false
    }).catch(() => null);
    if (!choice) return;
    const hitCopy = choice === 'copy';
    coin(actor, real, amount);
    requestGM('catCollapse', { sceneId: canvas.scene.id, originalId: pair.original.id, keep: real === hitCopy ? 'copy' : 'original', reason: real ? 'попали по настоящему' : 'попали по пустышке' });
    if (!real) return;
    decided.add(actor.id);
    await actor.applyDamage(amount, { ignore: true });
}

// Начало хода персонажа: владелец выбирает, где он на самом деле
Hooks.on('updateCombat', async (combat, changed) => {
    if (!('turn' in changed || 'round' in changed) || !combat.started) return;
    const actor = combat.combatant?.actor;
    if (!actor) return;
    const pair = superposition(actor);
    if (!pair) return;
    // Решает игрок-владелец; без него — Мастер
    const owner = game.users.find(u => !u.isGM && u.active && actor.testUserPermission(u, 'OWNER'));
    if (owner ? owner.id !== game.user.id : !isActiveGM()) return;
    const DialogV2 = foundry.applications.api.DialogV2;
    canvas.animatePan?.({ x: pair.copy.x, y: pair.copy.y, duration: 400 });
    const choice = await DialogV2.wait({
        window: { title: 'Кот Шрёдингера' },
        content: `<p>Ход ${foundry.utils.escapeHTML?.(actor.name) ?? actor.name}. Где вы на самом деле?</p>`,
        buttons: [
            { action: 'original', label: 'Исходный токен', default: true },
            { action: 'copy', label: 'Копия' }
        ],
        rejectClose: false
    }).catch(() => null);
    requestGM('catCollapse', { sceneId: canvas.scene.id, originalId: pair.original.id, keep: choice === 'copy' ? 'copy' : 'original', reason: 'начало хода' });
});

// Конец боя — суперпозиция схлопывается в исходный
Hooks.on('deleteCombat', combat => {
    if (!isActiveGM()) return;
    const scene = combat.scene ?? canvas?.scene;
    for (const token of scene?.tokens ?? []) {
        if (token.flags?.[MODULE_ID]?.cat?.copyId) collapse({ sceneId: scene.id, originalId: token.id, keep: 'original', reason: 'конец боя' });
    }
});

