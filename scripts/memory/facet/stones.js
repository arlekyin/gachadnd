/**
 * Gacha Roguelike dnd5e — Огранка: как срабатывают камни (docs/ogranka.md, «Камни»)
 *
 * Камень не добавляет своего эффекта — переносит то, что способность уже сделала. Поэтому всё
 * начинается с броска урона или лечения способности (dnd5e.rollDamageV2): итог броска и цели уходят
 * Мастеру, а он выкладывает карточки — кому ещё достаётся тот же эффект:
 *   Разлёт      — всем той же стороны в 5 футах от единственной цели, столько же;
 *   Перекидка   — одному той же стороны в 10 футах от цели, половина (кандидатов несколько — выбирает игрок);
 *   Переливание — обратной стороне рядом с первой целью: урон лечит союзника, лечение ранит врага;
 *   Раскат      — в начале следующего хода героя те же цели получают половину;
 *   Мина        — эффект не применяется сразу: игрок закладывает его в точку в 30 футах (или применяет сразу);
 *                 сработает, когда туда войдут, или в начале хода героя.
 * Охват не множится: перескочившее не разлетается и наоборот; Раскат не повторяет сам себя.
 * Цена: В долг — способность без ячейки и заряда, ПЗ уходят в начале следующего хода (вне боя — сразу);
 * Плата кровью — кнопка в карточке способности: бонусным действием за ПЗ, раз за ход.
 * Сквозь и Выброс разрешают то, чего Foundry и так не запрещает, — только строка в карточке.
 *
 * Карточки — как у навыков (blast/common.js): модуль не бросает и не применяет урон сам, кнопки dnd5e,
 * применяет Мастер лотком. Мины — флаг сцены facetMines, видны всем значком в точке.
 */

import { MODULE_ID } from "../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { onRenderChatMessage, messageItem, messageActivity } from "../../core/chat-hooks.js";
import { blast, around, inCircle, tokenOf, esc, boom, centerOf, isDead } from "../skills/blast/common.js";
import { STONES, TAG_COLORS, isFacetable, stonesFor } from "./facet.js";

const CARRY = ['hop', 'spread', 'transfuse', 'echo', 'mine'];
const uuidOf = token => token?.document?.uuid ?? token?.uuid ?? null;
const levelOf = actor => Number(actor?.system?.details?.level) || 1;
const tokenFrom = async uuid => { const doc = uuid ? await fromUuid(uuid) : null; return doc?.documentName === 'Token' ? doc : doc?.token ?? tokenOf(doc) ?? null; };
const distance = (a, b) => { const p = centerOf(a), q = centerOf(b); return Math.hypot(p.x - q.x, p.y - q.y); };
const enrich = (html, actor) => (foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor).enrichHTML(html, { rollData: actor?.getRollData?.() ?? {} });
const gem = id => `<span class="gd-stone-gem" style="--r: ${TAG_COLORS[STONES[id].tag]}"></span>`;

// ==========================================
// КАРТОЧКИ
// ==========================================

/** Тот же эффект ещё кому-то: урон — карточка взрыва без спасброска, лечение — кнопка лечения */
async function effectCard(actor, { title, victims, amount, type, heal, note = '' }) {
    if (!victims.length || !(amount > 0)) return;
    if (!heal) return blast({ actor, title, icon: 'fa-gem', victims, formula: String(amount), type, note });
    const content = await enrich(`<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-gem"></i> ${esc(title)}</div>
        ${note ? `<p>${note}</p>` : ''}<ul class="gd-blast-list"><li>${type === 'temphp' ? 'Временные ПЗ' : 'Лечение'}: ${esc(victims.map(t => t.name).join(', '))}</li></ul>
        <p class="gd-blast-rolls">[[/heal ${amount}${type === 'temphp' ? ' temphp' : ''}]]</p></div>`, actor);
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
}
function noteCard(actor, title, text) {
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-gem"></i> ${esc(title)}</div><p>${text}</p></div>` });
}

/** Плата своими ПЗ: модуль снимает сам и пишет строку в чат */
async function payHp(actor, amount, why) {
    if (!actor || !(amount > 0)) return;
    const hp = actor.system.attributes.hp;
    await actor.update({ 'system.attributes.hp.value': Math.max(0, hp.value - amount) });
    await noteCard(actor, why, `${esc(actor.name)} теряет ${amount} ПЗ.`);
}

// ==========================================
// БРОСОК УРОНА ИЛИ ЛЕЧЕНИЯ: что камни переносят
// ==========================================

Hooks.on('dnd5e.rollDamageV2', (rolls, data) => {
    const activity = data?.subject, item = activity?.item, actor = item?.actor;
    if (!actor || !isFacetable(item)) return;
    const stones = stonesFor(activity).filter(id => CARRY.includes(id));
    if (!stones.length) return;
    const list = (Array.isArray(rolls) ? rolls : [rolls]).filter(Boolean);
    const heal = activity.type === 'heal' || (list.length > 0 && list.every(r => ['healing', 'temphp'].includes(r.options?.type)));
    const amount = list.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
    const type = list[0]?.options?.type ?? (heal ? 'healing' : 'force');
    const caster = tokenOf(actor);
    let targets = [...game.user.targets].map(uuidOf).filter(Boolean);
    if (!targets.length && heal && caster) targets = [uuidOf(caster)];
    const payload = { actorId: actor.id, casterUuid: uuidOf(caster), name: item.name, stones, amount, type, heal, targets };
    if (stones.includes('mine')) return mineCard(actor, payload);
    requestGM('facetCast', payload);
});

onSocket('facetCast', ({ payload }) => { if (isActiveGM()) facetCast(payload).catch(error => console.error(`${MODULE_ID} | огранка: камни`, error)); });
/** Мастер: разложить перенесённый эффект по камням (Мина сюда приходит уже сработавшей) */
export async function facetCast({ actorId, casterUuid, name, stones, amount, type, heal, targets }) {
    const actor = game.actors.get(actorId), caster = await tokenFrom(casterUuid);
    const primary = (await Promise.all((targets ?? []).map(tokenFrom))).filter(t => t?.actor);
    if (!actor || !primary.length || !(amount > 0)) return;
    const first = primary[0];
    const taken = new Set(primary.map(t => t.id));
    const alive = t => !isDead(t.actor);
    let spread = [];
    if (stones.includes('spread') && primary.length === 1) {
        spread = around(first, 5).filter(t => t.disposition === first.disposition && !taken.has(t.id) && alive(t));
        spread.forEach(t => taken.add(t.id));
        await effectCard(actor, { title: `Разлёт — ${name}`, victims: spread, amount, type, heal });
    }
    if (stones.includes('hop')) {
        const pool = around(first, 10).filter(t => t.disposition === first.disposition && !taken.has(t.id) && alive(t));
        const half = Math.floor(amount / 2);
        if (pool.length === 1) await effectCard(actor, { title: `Перекидка — ${name}`, victims: pool, amount: half, type, heal });
        else if (pool.length > 1) await hopCard(actor, { name, pool, amount: half, type, heal });
    }
    if (stones.includes('transfuse')) {
        // Обратная сторона: урон по врагу лечит союзника героя, лечение — ранит врага вылеченного
        const want = heal ? -first.disposition : (caster?.disposition ?? -first.disposition);
        const near = around(first, 5).filter(t => t.disposition === want && t.disposition !== 0 && !taken.has(t.id) && alive(t))
            .sort((a, b) => distance(a, first) - distance(b, first))[0];
        if (near) await effectCard(actor, { title: `Переливание — ${name}`, victims: [near], amount, type: heal ? 'necrotic' : 'healing', heal: !heal });
    }
    if (stones.includes('echo') && game.combat?.started) {
        const echo = actor.getFlag(MODULE_ID, 'facetEcho') ?? [];
        echo.push({ name, targets: [...primary, ...spread].map(uuidOf), amount: Math.floor(amount / 2), type, heal });
        await actor.setFlag(MODULE_ID, 'facetEcho', echo);
    }
}

/** Перекидка — кандидатов несколько: выбирает игрок кнопкой в карточке */
async function hopCard(actor, { name, pool, amount, type, heal }) {
    const buttons = pool.map(t => `<button type="button" data-gd-hop="${uuidOf(t)}">${esc(t.name)}</button>`).join('');
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-blast-card gd-stone-card"><div class="gd-blast-title"><i class="fas fa-gem"></i> Перекидка — ${esc(name)}</div>
            <p>Куда перескочит ${heal ? 'лечение' : 'урон'} (${amount}):</p><div class="gd-stone-buttons">${buttons}</div></div>`,
        flags: { [MODULE_ID]: { facetHop: { actorId: actor.id, name, amount, type, heal, used: null } } }
    });
}
onSocket('facetHopPick', ({ payload }) => { if (isActiveGM()) hopPick(payload).catch(error => console.error(`${MODULE_ID} | огранка: перекидка`, error)); });
async function hopPick({ messageId, uuid }) {
    const message = game.messages.get(messageId), hop = message?.getFlag(MODULE_ID, 'facetHop');
    if (!hop || hop.used) return;
    const token = await tokenFrom(uuid);
    if (!token) return;
    await message.setFlag(MODULE_ID, 'facetHop', { ...hop, used: uuid });
    await effectCard(game.actors.get(hop.actorId), { title: `Перекидка — ${hop.name}`, victims: [token], amount: hop.amount, type: hop.type, heal: hop.heal });
}

// ==========================================
// МИНА
// ==========================================

function mineCard(actor, payload) {
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="gd-blast-card gd-stone-card"><div class="gd-blast-title"><i class="fas fa-gem"></i> Мина — ${esc(payload.name)}</div>
            <p>${payload.heal ? 'Лечение' : 'Урон'} ${payload.amount}: заложить в точку в 30 футах или применить сразу.</p>
            <div class="gd-stone-buttons"><button type="button" data-gd-mine="place"><i class="fas fa-location-crosshairs"></i> Заложить</button><button type="button" data-gd-mine="now">Сразу</button></div></div>`,
        flags: { [MODULE_ID]: { facetMine: { payload, state: 'wait' } } }
    });
}

/** Игрок щёлкает точку на сцене; дальше 30 футов от героя — нельзя */
function pickPoint(actor, messageId) {
    const caster = tokenOf(actor);
    if (!canvas?.ready || !caster || caster.parent?.id !== canvas.scene.id) return ui.notifications.warn('Герой не на этой сцене.');
    ui.notifications.info('Щёлкните точку на сцене — в 30 футах от героя.');
    canvas.stage.once('pointerdown', event => {
        const point = event.getLocalPosition?.(canvas.stage) ?? event.data?.getLocalPosition?.(canvas.stage) ?? canvas.mousePosition;
        const c = centerOf(caster), grid = canvas.scene.grid;
        const feet = Math.hypot(point.x - c.x, point.y - c.y) / grid.size * grid.distance;
        if (feet > 30 + grid.distance / 2) return ui.notifications.warn('Дальше 30 футов — мину туда не заложить.');
        requestGM('facetMinePlace', { messageId, sceneId: canvas.scene.id, x: Math.round(point.x), y: Math.round(point.y) });
    });
}

onSocket('facetMinePlace', ({ payload }) => { if (isActiveGM()) minePlace(payload).catch(error => console.error(`${MODULE_ID} | огранка: мина`, error)); });
async function minePlace({ messageId, sceneId, x, y }) {
    const message = game.messages.get(messageId), card = message?.getFlag(MODULE_ID, 'facetMine'), scene = game.scenes.get(sceneId);
    if (!card || card.state !== 'wait' || !scene) return;
    await message.setFlag(MODULE_ID, 'facetMine', { ...card, state: 'placed' });
    const caster = await tokenFrom(card.payload.casterUuid);
    const mines = scene.getFlag(MODULE_ID, 'facetMines') ?? [];
    mines.push({ id: foundry.utils.randomID(), x, y, side: caster?.disposition ?? 1, payload: { ...card.payload, stones: card.payload.stones.filter(s => s !== 'mine') } });
    await scene.setFlag(MODULE_ID, 'facetMines', mines);
}
onSocket('facetMineNow', ({ payload }) => { if (isActiveGM()) mineNow(payload).catch(error => console.error(`${MODULE_ID} | огранка: мина`, error)); });
async function mineNow({ messageId }) {
    const message = game.messages.get(messageId), card = message?.getFlag(MODULE_ID, 'facetMine');
    if (!card || card.state !== 'wait') return;
    await message.setFlag(MODULE_ID, 'facetMine', { ...card, state: 'now' });
    await facetCast({ ...card.payload, stones: card.payload.stones.filter(s => s !== 'mine') });
}

/** Кого задевает мина: урон — не своих, лечение — своих; в 5 футах от точки */
const mineVictims = (scene, mine) => inCircle(scene, mine, scene.grid.size * 1.2)
    .filter(t => !isDead(t.actor) && (mine.payload.heal ? t.disposition === mine.side : t.disposition !== mine.side));

/** Мина срабатывает: основной эффект — карточкой, остальные камни — как при обычном применении. entering —
 * кто вошёл (в v14 в хуке перемещения документ токена ещё на старом месте) */
export async function detonateMine(scene, mineId, entering = null) {
    const mines = scene.getFlag(MODULE_ID, 'facetMines') ?? [];
    const mine = mines.find(m => m.id === mineId);
    if (!mine) return;
    await scene.setFlag(MODULE_ID, 'facetMines', mines.filter(m => m.id !== mineId));
    const victims = mineVictims(scene, mine);
    if (entering && !victims.some(t => t.id === entering.id)) victims.push(entering);
    const actor = game.actors.get(mine.payload.actorId);
    boom({ sceneId: scene.id, x: mine.x, y: mine.y, radius: scene.grid.size * 1.2, color: mine.payload.heal ? 0x7dd87a : 0xff7a1a });
    if (!victims.length) return noteCard(actor, `Мина — ${mine.payload.name}`, 'Сработала впустую.');
    await effectCard(actor, { title: `Мина — ${mine.payload.name}`, victims, amount: mine.payload.amount, type: mine.payload.type, heal: mine.payload.heal });
    await facetCast({ ...mine.payload, targets: victims.map(uuidOf) });
}

// Кто-то вошёл в точку мины: куда пришёл — по изменениям (документ в хуке ещё на старом месте)
Hooks.on('updateToken', (token, changes) => {
    if (!isActiveGM() || !('x' in changes || 'y' in changes) || !token.actor || isDead(token.actor)) return;
    const scene = token.parent, size = scene.grid.size;
    const at = { x: (changes.x ?? token.x) + (token.width || 1) * size / 2, y: (changes.y ?? token.y) + (token.height || 1) * size / 2 };
    for (const mine of scene?.getFlag(MODULE_ID, 'facetMines') ?? []) {
        const side = mine.payload.heal ? token.disposition === mine.side : token.disposition !== mine.side;
        if (side && Math.hypot(at.x - mine.x, at.y - mine.y) <= size * 1.2) detonateMine(scene, mine.id, token).catch(error => console.error(`${MODULE_ID} | огранка: мина`, error));
    }
});

// Мины на сцене — значком в точке, у всех
const MINE_LAYER = 'gdFacetMines';
function drawMines() {
    if (!canvas?.ready) return;
    const parent = canvas.interface ?? canvas.controls;
    parent.getChildByName?.(MINE_LAYER)?.destroy({ children: true });
    const mines = canvas.scene.getFlag(MODULE_ID, 'facetMines') ?? [];
    if (!mines.length) return;
    const layer = new PIXI.Container();
    layer.name = MINE_LAYER;
    layer.eventMode = 'none';
    const r = canvas.grid.size * 0.22;
    for (const mine of mines) {
        const color = mine.payload.heal ? 0x7dd87a : 0xffc94a;
        const pts = Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + i * Math.PI / 3; return [mine.x + r * Math.cos(a), mine.y + r * Math.sin(a)]; }).flat();
        const g = new PIXI.Graphics();
        g.beginFill(0x1a1410, 0.75).lineStyle(2, color, 0.95).drawPolygon(pts).endFill();
        g.beginFill(color, 0.9).drawCircle(mine.x, mine.y, r * 0.32).endFill();
        layer.addChild(g);
    }
    parent.addChild(layer);
}
Hooks.on('canvasReady', drawMines);
Hooks.on('updateScene', (scene, changes) => { if (scene.id === canvas?.scene?.id && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) drawMines(); });

// ==========================================
// ЦЕНА: В долг, Плата кровью
// ==========================================

// В долг — ячейка и заряды не тратятся
Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    if (!stonesFor(activity).includes('debt') || !usage) return;
    if (usage.consume === false) return;
    usage.consume = { ...(typeof usage.consume === 'object' ? usage.consume : {}), resources: [], spellSlot: false };
});
Hooks.on('dnd5e.postUseActivity', (activity, usage) => {
    const actor = activity?.item?.actor;
    if (!actor || !stonesFor(activity).includes('debt')) return;
    const item = activity.item;
    let amount = 0;
    if (item.type === 'spell' && (item.system.level ?? 0) > 0) {
        const slot = usage?.spell?.slot ?? '';
        const level = slot === 'pact' ? Number(actor.system.spells?.pact?.level) : Number(String(slot).match(/\d+/)?.[0]);
        amount = 5 * (level || item.system.level);
    } else if (activity.consumption?.targets?.length || item.system.uses?.max) amount = levelOf(actor);
    if (amount) requestGM('facetDebt', { actorId: actor.id, amount, name: item.name });
});
onSocket('facetDebt', ({ payload }) => { if (isActiveGM()) takeDebt(payload).catch(error => console.error(`${MODULE_ID} | огранка: долг`, error)); });
async function takeDebt({ actorId, amount, name }) {
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const inCombat = game.combat?.started && game.combat.combatants.some(c => c.actorId === actorId);
    if (!inCombat) return payHp(actor, amount, `В долг — ${name}`);
    await actor.setFlag(MODULE_ID, 'facetDebt', (actor.getFlag(MODULE_ID, 'facetDebt') ?? 0) + amount);
    await noteCard(actor, `В долг — ${name}`, `Без ячейки и заряда. В начале следующего хода ${esc(actor.name)} потеряет ${amount} ПЗ.`);
}

// Плата кровью — игрок сам решает, что применил бонусным действием: кнопка в карточке, раз за ход
async function payBlood(message, actor) {
    const key = game.combat?.started ? `${game.combat.round}.${game.combat.turn}` : null;
    if (key && actor.getFlag(MODULE_ID, 'facetPaid') === key) return ui.notifications.warn('Плата кровью — раз за ход.');
    if (key) await actor.setFlag(MODULE_ID, 'facetPaid', key);
    await message.setFlag(MODULE_ID, 'facetPaidHere', true);
    await payHp(actor, levelOf(actor), `Плата кровью — ${messageItem(message)?.name ?? ''}`);
}

// ==========================================
// ХОДЫ: долг, Раскат и мины — в начале хода героя
// ==========================================

Hooks.on('combatTurnChange', (combat, prev, cur) => {
    if (!isActiveGM() || !combat?.started) return;
    startTurn(combat.combatants.get(cur?.combatantId)).catch(error => console.error(`${MODULE_ID} | огранка: ход`, error));
});
async function startTurn(combatant) {
    const actor = combatant?.actor;
    if (!actor) return;
    const debt = actor.getFlag(MODULE_ID, 'facetDebt');
    if (debt) { await actor.unsetFlag(MODULE_ID, 'facetDebt'); await payHp(actor, debt, 'В долг: расплата'); }
    const echo = actor.getFlag(MODULE_ID, 'facetEcho');
    if (echo?.length) {
        await actor.unsetFlag(MODULE_ID, 'facetEcho');
        for (const e of echo) {
            const victims = (await Promise.all(e.targets.map(tokenFrom))).filter(t => t?.actor && !isDead(t.actor));
            await effectCard(actor, { title: `Раскат — ${e.name}`, victims, amount: e.amount, type: e.type, heal: e.heal });
        }
    }
    const scene = combatant.token?.parent;
    for (const mine of (scene?.getFlag(MODULE_ID, 'facetMines') ?? []).filter(m => m.payload.actorId === actor.id)) await detonateMine(scene, mine.id);
}
// Конец боя: долг — сразу, Раскат и мины — уходят
Hooks.on('deleteCombat', combat => {
    if (!isActiveGM()) return;
    (async () => {
        for (const combatant of combat.combatants) {
            const actor = combatant.actor;
            if (!actor) continue;
            const debt = actor.getFlag(MODULE_ID, 'facetDebt');
            if (debt) { await actor.unsetFlag(MODULE_ID, 'facetDebt'); await payHp(actor, debt, 'В долг: расплата'); }
            if (actor.getFlag(MODULE_ID, 'facetEcho')) await actor.unsetFlag(MODULE_ID, 'facetEcho');
        }
        if (combat.scene?.getFlag(MODULE_ID, 'facetMines')?.length) await combat.scene.unsetFlag(MODULE_ID, 'facetMines');
    })().catch(error => console.error(`${MODULE_ID} | огранка: конец боя`, error));
});

// ==========================================
// ЧАТ: строка огранки в карточке способности, кнопки камней
// ==========================================

onRenderChatMessage((message, html) => {
    if (!html?.querySelector) return;
    bindStoneButtons(message, html);
    if (html.querySelector('.gd-facet-line') || (message.type !== 'usage' && message.getFlag?.('dnd5e', 'messageType') !== 'usage')) return;
    const activity = messageActivity(message);
    const stones = activity ? stonesFor(activity) : [];
    if (!stones.length) return;
    const actor = activity.item.actor;
    const line = document.createElement('div');
    line.className = 'gd-facet-line';
    line.innerHTML = `<i class="fas fa-gem"></i> Огранка: ${stones.map(id => `${gem(id)}<b>${STONES[id].name}</b>`).join(', ')}`
        + (stones.includes('pay') && actor?.isOwner && !message.getFlag(MODULE_ID, 'facetPaidHere')
            ? ` <button type="button" class="gd-stone-pay"><i class="fas fa-droplet"></i> Бонусным действием — ${levelOf(actor)} ПЗ</button>` : '');
    line.querySelector('.gd-stone-pay')?.addEventListener('click', event => { event.preventDefault(); event.currentTarget.disabled = true; payBlood(message, actor); });
    // Содержимое карточки dnd5e перерисовывает после хука — строка под шапкой сообщения
    const header = html.querySelector('.message-header');
    if (header) header.after(line); else html.prepend(line);
});

function bindStoneButtons(message, html) {
    const hop = message.getFlag?.(MODULE_ID, 'facetHop');
    if (hop) {
        const owner = game.user.isGM || game.actors.get(hop.actorId)?.isOwner;
        html.querySelectorAll('[data-gd-hop]').forEach(b => {
            b.disabled = !owner || !!hop.used;
            b.classList.toggle('on', hop.used === b.dataset.gdHop);
            b.addEventListener('click', event => { event.preventDefault(); requestGM('facetHopPick', { messageId: message.id, uuid: b.dataset.gdHop }); });
        });
    }
    const mine = message.getFlag?.(MODULE_ID, 'facetMine');
    if (mine) {
        const actor = game.actors.get(mine.payload.actorId);
        const owner = game.user.isGM || actor?.isOwner;
        html.querySelectorAll('[data-gd-mine]').forEach(b => {
            b.disabled = !owner || mine.state !== 'wait';
            b.classList.toggle('on', (mine.state === 'placed' && b.dataset.gdMine === 'place') || (mine.state === 'now' && b.dataset.gdMine === 'now'));
            b.addEventListener('click', event => {
                event.preventDefault();
                if (b.dataset.gdMine === 'now') requestGM('facetMineNow', { messageId: message.id });
                else pickPoint(actor, message.id);
            });
        });
    }
}
