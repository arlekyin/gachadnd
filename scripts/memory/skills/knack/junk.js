/**
 * Gacha Roguelike dnd5e — Рандомная хрень, вперёд! (фиолетовый навык стали и аномалии)
 *
 * Бонусным действием персонаж швыряет до [бонус мастерства] предметов оружия из сумки — не
 * экипированных и не брошенных — в свои цели (T) в пределах 60 футов. Окно у игрока: какое оружие в кого.
 * Как у способностей dnd5e: каждое оружие делает обычную атаку dnd5e по своей цели (бросок с костями и
 * модификаторами в чате, попадание считает dnd5e), урон — кнопкой на карточке атаки, применяет Мастер
 * лотком. Карточка навыка dnd5e — в чате.
 *
 * Брошенное оружие остаётся в сумке с пометкой thrown (иначе кнопка урона на карточке атаки сломается)
 * и лежит у цели плиткой с картинкой предмета. «Подобрать» в карточке снимает пометку и плитку; что не
 * подобрали до конца боя — пропадает из сумки.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { isKnack, ref, actorFrom, tokenOf, esc, noTemplate, targetsWithin, card, refund, centerOf } from "./common.js";

const RANGE = 60;
const thrownOf = item => item?.flags?.[MODULE_ID]?.thrown ?? null;

/** Оружие, которое можно швырнуть: в сумке, не экипированное, не брошенное, с атакой */
export const throwable = actor => actor.items.filter(i => i.type === 'weapon' && !i.system.equipped && !thrownOf(i)
    && i.system.activities?.some(a => a.type === 'attack'));
const prof = actor => Number(actor.system.attributes?.prof) || 2;

Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'junk') || !actor) return;
    noTemplate(usage);
    const token = tokenOf(actor)?.document;
    if (!token) { ui.notifications.warn('Рандомная хрень: токена персонажа нет на сцене.'); return false; }
    if (!throwable(actor).length) { ui.notifications.warn('Рандомная хрень: в сумке нет неэкипированного оружия — швырять нечего.'); return false; }
    if (!targetsWithin(token, RANGE).length) { ui.notifications.warn(`Рандомная хрень: выберите цели (T) в пределах ${RANGE} футов.`); return false; }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'junk') || !actor) return;
    choose(actor, item).catch(error => console.error(`${MODULE_ID} | Рандомная хрень`, error));
});

/** Окно у игрока: до [бонус мастерства] предметов, у каждого — цель; затем атаки dnd5e у него же */
async function choose(actor, item) {
    const token = tokenOf(actor).document;
    const targets = targetsWithin(token, RANGE);
    const weapons = throwable(actor);
    const limit = prof(actor);
    const options = targets.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    const rows = weapons.map((w, i) => `<label class="gd-junk-row" style="display:flex;align-items:center;gap:8px;margin:4px 0">
        <input type="checkbox" name="w${i}" ${i < limit ? 'checked' : ''}>
        <img src="${esc(w.img)}" width="28" height="28" style="border:0">
        <span style="flex:1">${esc(w.name)}</span>
        <select name="t${i}">${options}</select></label>`).join('');
    const picked = await foundry.applications.api.DialogV2.prompt({
        window: { title: 'Рандомная хрень, вперёд!' },
        content: `<p>Швырните до <strong>${limit}</strong> предметов — что в кого:</p>${rows}`,
        ok: {
            label: 'Вперёд!',
            callback: (event, button) => {
                const f = button.form.elements;
                return weapons.map((w, i) => f[`w${i}`].checked ? { itemId: w.id, tokenId: f[`t${i}`].value } : null).filter(Boolean);
            }
        },
        rejectClose: false
    });
    if (!picked?.length) { await refund(item); return ui.notifications.info('Рандомная хрень: бросок отменён, заряд вернулся.'); }
    if (picked.length > limit) { await refund(item); return ui.notifications.warn(`Рандомная хрень: не больше ${limit} предметов за раз — заряд вернулся.`); }

    // Атаки — штатные dnd5e: цель на время броска — та, в которую летит предмет
    const before = [...game.user.targets].map(t => t.id);
    for (const { itemId, tokenId } of picked) {
        const attack = actor.items.get(itemId)?.system.activities.find(a => a.type === 'attack');
        if (!attack) continue;
        canvas.tokens.setTargets([tokenId]);
        await attack.rollAttack({}, { configure: false }, {});
    }
    canvas.tokens.setTargets(before);
    requestGM('knackJunk', { ...ref(actor), throws: picked });
}

onSocket('knackJunk', ({ payload }) => {
    if (isActiveGM()) hurl(payload).catch(error => console.error(`${MODULE_ID} | Рандомная хрень`, error));
});

/** Мастер: брошенное помечается и ложится у цели плиткой; карточка с «Подобрать» */
export async function hurl({ actorId, tokenId, sceneId, throws }) {
    const scene = game.scenes.get(sceneId);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!scene || !actor) return;
    const size = scene.grid.size;
    const tiles = [];
    for (const { itemId, tokenId: targetId } of throws) {
        const weapon = actor.items.get(itemId);
        const target = scene.tokens.get(targetId);
        if (!weapon || !target) continue;
        const c = centerOf(target);
        const spread = tiles.filter(t => t.target === target.id).length;
        tiles.push({
            target: target.id, weapon,
            data: {
                texture: { src: weapon.img }, width: size * 0.45, height: size * 0.45,
                x: c.x - size * 0.22 + spread * size * 0.18, y: c.y + size * 0.1, rotation: Math.floor(Math.random() * 90) - 45,
                flags: { [MODULE_ID]: { junk: { actorId: actor.id, itemId: weapon.id, name: weapon.name } } }
            }
        });
    }
    const created = tiles.length ? await scene.createEmbeddedDocuments('Tile', tiles.map(t => t.data)) : [];
    for (const [i, tile] of created.entries()) await tiles[i].weapon.setFlag(MODULE_ID, 'thrown', { sceneId, tileId: tile.id });
    const pick = created.map(t => `<button type="button" class="gd-knack-btn" data-gd-junk="${t.id}"><i class="fas fa-hand"></i> ${esc(t.flags[MODULE_ID].junk.name)}</button>`).join('');
    return card(actor, 'Рандомная хрень, вперёд!', `<p>Брошено: ${esc(tiles.map(t => `${t.weapon.name} → ${scene.tokens.get(t.target)?.name}`).join(', '))}. Урон — кнопкой на карточке каждой атаки.</p>`
        + (created.length ? `<p>Подобрать до конца боя:</p><div class="gd-knack-buttons">${pick}</div>` : ''),
        { icon: 'fa-dumpster-fire', flags: { junk: { sceneId, actorId: actor.id } } });
}

// «Подобрать»: владельцу и Мастеру; подобранное — кнопка гаснет
onRenderChatMessage((message, html) => {
    const data = message.flags?.[MODULE_ID]?.junk;
    if (!data || !html) return;
    const may = game.user.isGM || game.actors.get(data.actorId)?.isOwner;
    const scene = game.scenes.get(data.sceneId);
    for (const button of html.querySelectorAll('[data-gd-junk]')) {
        if (!may || !scene?.tiles.get(button.dataset.gdJunk)) { button.disabled = true; continue; }
        button.addEventListener('click', event => {
            event.preventDefault();
            button.disabled = true;
            requestGM('knackJunkPick', { sceneId: data.sceneId, tileId: button.dataset.gdJunk, messageId: message.id });
        });
    }
});

onSocket('knackJunkPick', ({ payload }) => {
    if (isActiveGM()) pickUp(payload).catch(error => console.error(`${MODULE_ID} | Рандомная хрень`, error));
});

export async function pickUp({ sceneId, tileId, messageId }) {
    const tile = game.scenes.get(sceneId)?.tiles.get(tileId);
    const junk = tile?.flags?.[MODULE_ID]?.junk;
    const actor = game.actors.get(junk?.actorId);
    if (!junk || !actor) return;
    await actor.items.get(junk.itemId)?.unsetFlag(MODULE_ID, 'thrown');
    await tile.delete();
    // Карточка перерисуется: кнопка подобранного погаснет
    const message = game.messages.get(messageId);
    await message?.update({ [`flags.${MODULE_ID}.junk.picked`]: [...(message.flags?.[MODULE_ID]?.junk?.picked ?? []), tileId] });
}

// Конец боя: брошенное и не подобранное пропадает из сумки
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    const scene = combat.scene ?? canvas?.scene;
    const left = scene?.tiles.filter(t => t.flags?.[MODULE_ID]?.junk) ?? [];
    if (!left.length) return;
    await scene.deleteEmbeddedDocuments('Tile', left.map(t => t.id));
    const byActor = new Map();
    for (const t of left) {
        const { actorId, itemId, name } = t.flags[MODULE_ID].junk;
        byActor.set(actorId, [...(byActor.get(actorId) ?? []), { itemId, name }]);
    }
    for (const [actorId, lost] of byActor) {
        const actor = game.actors.get(actorId);
        if (!actor) continue;
        const ids = lost.map(l => l.itemId).filter(id => actor.items.has(id));
        if (ids.length) await actor.deleteEmbeddedDocuments('Item', ids);
        await card(actor, 'Рандомная хрень, вперёд!', `<p>Не подобрали — пропало навсегда: ${esc(lost.map(l => l.name).join(', '))}.</p>`, { icon: 'fa-dumpster-fire' });
    }
});
