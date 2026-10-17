/**
 * Gacha Roguelike dnd5e — Навылет (зелёный навык казни и стали)
 *
 * Пассивный: атака или навык персонажа убивает существо — урон сверх его оставшихся ПЗ переходит на
 * другое существо вплотную к убитому, по выбору владельца. Выбор — кнопками в карточке (владельцу и
 * Мастеру); перешедший урон наносится без защит цели и дальше не переливается.
 *
 * Атакующий берётся из сообщения, к которому привязан лоток урона dnd5e (origin / originatingMessage),
 * или из навыка модуля (параметр gachadndSource у applyDamage).
 */

import { MODULE_ID } from "../../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../../core/socket.js";
import { onRenderChatMessage } from "../../../core/chat-hooks.js";
import { knackSkill, hpOf, alive, adjacent, sourceOf, card, esc } from "./common.js";

const pending = new WeakMap();

Hooks.on('dnd5e.preApplyDamage', (actor, amount, updates, options) => {
    if (options?.gachadndThrough || !(amount > 0) || !alive(actor)) return;
    const before = hpOf(actor);
    if (amount <= before || updates['system.attributes.hp.value'] > 0) return;
    const source = sourceOf(options);
    if (!source || source.id === actor.id || !knackSkill(source, 'through')) return;
    pending.set(options, { source, over: amount - before });
});

Hooks.on('dnd5e.applyDamage', (actor, amount, options) => {
    const found = pending.get(options);
    if (!found) return;
    pending.delete(options);
    offer(actor, found).catch(error => console.error(`${MODULE_ID} | Навылет`, error));
});

async function offer(victim, { source, over }) {
    const token = victim.token ?? victim.getActiveTokens()[0]?.document;
    const sourceToken = source.getActiveTokens()[0]?.document;
    const next = token ? adjacent(token).filter(t => alive(t.actor) && t.id !== sourceToken?.id) : [];
    const buttons = next.map(t => `<button type="button" class="gd-knack-btn" data-gd-through="${t.id}"><i class="fas fa-arrow-right"></i> ${esc(t.name)}</button>`).join('');
    return card(source, 'Навылет', `<p>${esc(victim.name)} пал — лишний урон: <strong>${over}</strong>.</p>`
        + (next.length ? `<p>Кому достанется остаток:</p><div class="gd-knack-buttons">${buttons}</div>` : '<p>Рядом с убитым никого — остаток ушёл в пустоту.</p>'),
        { icon: 'fa-arrows-to-dot', flags: { through: { over, sceneId: token?.parent?.id ?? null, sourceId: source.id, done: !next.length } } });
}

// Кнопки: видны владельцу и Мастеру, пока остаток не отдан
onRenderChatMessage((message, html) => {
    const data = message.flags?.[MODULE_ID]?.through;
    if (!data || !html) return;
    const buttons = html.querySelectorAll('[data-gd-through]');
    const may = game.user.isGM || game.actors.get(data.sourceId)?.isOwner;
    for (const button of buttons) {
        if (data.done || !may) { button.disabled = true; continue; }
        button.addEventListener('click', event => {
            event.preventDefault();
            buttons.forEach(b => { b.disabled = true; });
            requestGM('knackThrough', { messageId: message.id, tokenId: button.dataset.gdThrough });
        });
    }
});

onSocket('knackThrough', ({ payload }) => {
    if (isActiveGM()) pass(payload).catch(error => console.error(`${MODULE_ID} | Навылет`, error));
});

export async function pass({ messageId, tokenId }) {
    const message = game.messages.get(messageId);
    const data = message?.flags?.[MODULE_ID]?.through;
    if (!data || data.done) return;
    const target = game.scenes.get(data.sceneId)?.tokens.get(tokenId);
    if (!target?.actor) return;
    const before = hpOf(target.actor);
    await target.actor.applyDamage(data.over, { gachadndThrough: true });
    const lost = before - hpOf(target.actor);
    const content = message.content.replace(/<div class="gd-knack-buttons">[\s\S]*?<\/div>/, `<p>Остаток прошёл навылет: <strong>${esc(target.name)}</strong> −${lost}.</p>`);
    await message.update({ content, [`flags.${MODULE_ID}.through.done`]: true });
}
