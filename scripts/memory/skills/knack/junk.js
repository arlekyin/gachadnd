/**
 * Gacha Roguelike dnd5e — Рандомная хрень, вперёд! (фиолетовый навык стали и аномалии)
 *
 * Бонусным действием персонаж швыряет до [бонус мастерства] предметов оружия из инвентаря — не
 * экипированных — в свои цели (T) в пределах 60 футов. Окно у игрока: какое оружие в кого. Каждый
 * предмет — дальнобойная атака: к20 + бонус мастерства + больший из модификаторов Силы и Ловкости
 * против КД цели (20 — критическое попадание, кости урона удваиваются; 1 — промах); урон — костями
 * оружия + тот же модификатор, тип — первый тип урона оружия. Применяет урон Мастер (защиты цели
 * считает dnd5e).
 *
 * Брошенное оружие уходит из инвентаря и лежит у цели — плитка с картинкой предмета. Кнопка «Подобрать»
 * в карточке возвращает его владельцу. Что не подобрали до конца боя — пропадает.
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { isKnack, ref, actorFrom, tokenOf, esc, quiet, targetsWithin, card, refund, centerOf } from "./common.js";

const RANGE = 60;
const TYPE = { slashing: 'рубящего', piercing: 'колющего', bludgeoning: 'дробящего', fire: 'огнём', cold: 'холодом', lightning: 'электричеством', acid: 'кислотой', poison: 'ядом', force: 'силовым полем', radiant: 'излучением', necrotic: 'некротического', psychic: 'психического', thunder: 'звуком' };

/** Оружие, которое можно швырнуть: в инвентаре, не экипированное */
export const throwable = actor => actor.items.filter(i => i.type === 'weapon' && !i.system.equipped && (Number(i.system.quantity) || 1) > 0);
const prof = actor => Number(actor.system.attributes?.prof) || 2;
const mod = actor => Math.max(Number(actor.system.abilities?.str?.mod) || 0, Number(actor.system.abilities?.dex?.mod) || 0);

Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'junk') || !actor) return;
    quiet(usage, message);
    const token = tokenOf(actor)?.document;
    if (!token) { ui.notifications.warn('Рандомная хрень: токена персонажа нет на сцене.'); return false; }
    if (!throwable(actor).length) { ui.notifications.warn('Рандомная хрень: в инвентаре нет неэкипированного оружия — швырять нечего.'); return false; }
    if (!targetsWithin(token, RANGE).length) { ui.notifications.warn(`Рандомная хрень: выберите цели (T) в пределах ${RANGE} футов.`); return false; }
});

Hooks.on('dnd5e.postUseActivity', (activity) => {
    const item = activity?.item, actor = item?.actor;
    if (!isKnack(item, 'junk') || !actor) return;
    choose(actor, item).catch(error => console.error(`${MODULE_ID} | Рандомная хрень`, error));
});

/** Окно у игрока: до [бонус мастерства] предметов, у каждого — цель */
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
    requestGM('knackJunk', { ...ref(actor), throws: picked });
}

onSocket('knackJunk', ({ payload }) => {
    if (isActiveGM()) hurl(payload).catch(error => console.error(`${MODULE_ID} | Рандомная хрень`, error));
});

/** Формула урона оружия: кости основы + модификатор; без урона — 1d4 дробящего */
function damageFormula(weapon, bonus, crit) {
    const base = weapon.system.damage?.base;
    const number = Number(base?.number) || (base?.custom?.enabled ? 0 : 1);
    const faces = Number(base?.denomination) || 4;
    const type = [...(base?.types ?? [])][0] ?? 'bludgeoning';
    const dice = base?.custom?.enabled && base.custom.formula ? base.custom.formula : `${number * (crit ? 2 : 1)}d${faces}`;
    return { formula: `${dice} + ${bonus}`, type };
}

export async function hurl({ actorId, tokenId, sceneId, throws }) {
    const scene = game.scenes.get(sceneId);
    const actor = actorFrom({ actorId, tokenId, sceneId });
    if (!scene || !actor) return;
    const bonus = mod(actor), toHit = prof(actor) + bonus;
    const size = scene.grid.size;
    const lines = [], tiles = [];
    for (const { itemId, tokenId: targetId } of throws) {
        const weapon = actor.items.get(itemId);
        const target = scene.tokens.get(targetId);
        if (!weapon || !target?.actor) continue;
        const attack = await new Roll(`1d20 + ${toHit}`).evaluate();
        game.dice3d?.showForRoll?.(attack, game.user, true);
        const d20 = attack.dice[0]?.total ?? 0;
        const ac = Number(target.actor.system.attributes?.ac?.value) || 10;
        const crit = d20 === 20, hit = crit || (d20 !== 1 && attack.total >= ac);
        let text = `${esc(weapon.name)} → ${esc(target.name)}: ${attack.total} против КД ${ac} — `;
        if (hit) {
            const { formula, type } = damageFormula(weapon, bonus, crit);
            const damage = await new Roll(formula).evaluate();
            game.dice3d?.showForRoll?.(damage, game.user, true);
            const before = (Number(target.actor.system.attributes.hp.value) || 0) + (Number(target.actor.system.attributes.hp.temp) || 0);
            await target.actor.applyDamage([{ value: damage.total, type }], { gachadndSource: actor.id });
            const after = (Number(target.actor.system.attributes.hp.value) || 0) + (Number(target.actor.system.attributes.hp.temp) || 0);
            text += `${crit ? '<strong>критическое попадание</strong>' : 'попадание'}, ${damage.total} ${TYPE[type] ?? type} (−${before - after})`;
        } else text += d20 === 1 ? 'мимо (1)' : 'мимо';
        lines.push(`<li>${text}</li>`);

        // Оружие уходит из инвентаря и ложится у цели
        const data = weapon.toObject();
        delete data._id;
        const quantity = Number(weapon.system.quantity) || 1;
        if (quantity > 1) {
            await weapon.update({ 'system.quantity': quantity - 1 });
            data.system.quantity = 1;
        } else await weapon.delete();
        const c = centerOf(target);
        const spread = tiles.filter(t => t.target === target.id).length;
        tiles.push({
            target: target.id,
            data: {
                texture: { src: data.img }, width: size * 0.45, height: size * 0.45,
                x: c.x - size * 0.22 + spread * size * 0.18, y: c.y + size * 0.1, rotation: Math.floor(Math.random() * 90) - 45,
                flags: { [MODULE_ID]: { junk: { actorId: actor.id, name: data.name, item: data } } }
            }
        });
    }
    const created = tiles.length ? await scene.createEmbeddedDocuments('Tile', tiles.map(t => t.data)) : [];
    const pick = created.map(t => `<button type="button" class="gd-knack-btn" data-gd-junk="${t.id}"><i class="fas fa-hand"></i> ${esc(t.flags[MODULE_ID].junk.name)}</button>`).join('');
    return card(actor, 'Рандомная хрень, вперёд!', `<ul class="gd-blast-list">${lines.join('')}</ul>`
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
    await actor.createEmbeddedDocuments('Item', [junk.item]);
    await tile.delete();
    // Карточка перерисуется: кнопка подобранного погаснет
    await game.messages.get(messageId)?.update({ [`flags.${MODULE_ID}.junk.picked`]: [...(game.messages.get(messageId)?.flags?.[MODULE_ID]?.junk?.picked ?? []), tileId] });
}

// Конец боя: брошенное и не подобранное пропадает
Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM()) return;
    const scene = combat.scene ?? canvas?.scene;
    const left = scene?.tiles.filter(t => t.flags?.[MODULE_ID]?.junk) ?? [];
    if (!left.length) return;
    await scene.deleteEmbeddedDocuments('Tile', left.map(t => t.id));
    const byActor = new Map();
    for (const t of left) byActor.set(t.flags[MODULE_ID].junk.actorId, [...(byActor.get(t.flags[MODULE_ID].junk.actorId) ?? []), t.flags[MODULE_ID].junk.name]);
    for (const [actorId, names] of byActor) {
        const actor = game.actors.get(actorId);
        if (actor) await card(actor, 'Рандомная хрень, вперёд!', `<p>Не подобрали — пропало навсегда: ${esc(names.join(', '))}.</p>`, { icon: 'fa-dumpster-fire' });
    }
});
