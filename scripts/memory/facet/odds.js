/**
 * Gacha Roguelike dnd5e — Огранка: камни броска и цели (docs/ogranka-stones.md) — проклятье, казнь, разум, аномалия
 *
 * Модуль сам меняет бросок атаки героя (хуки dnd5e перед броском к20) и цену; спасбросок цели бросает её владелец —
 * «с помехой» и «провал» пишутся строкой в карточке способности, на честность. Добить — в stones.js (facetCast:
 * остаток силы, как Перекидка).
 *   Неотвратимо   — атака попадает всегда, спасбросок — провал (строкой), сила вдвое меньше (кости пополам);
 *   Сглаз         — атака с преимуществом (спасбросок цели с помехой — строкой); следующий к20 героя — с помехой;
 *   Возврат       — промах (или «все спаслись» кнопкой) — кнопка «Вернуть цену»: ячейка или заряд обратно;
 *                   следующий к20 героя — с помехой;
 *   Без пощады    — цель с половиной ПЗ и меньше: атака с преимуществом; союзнику под эффектом — преимущество на
 *                   его ближайший к20;
 *   Приговор      — способность на врага выше половины ПЗ не применяется, а объявляется; ПЗ врага впервые упали
 *                   до половины — карточка «Приговор» с кнопкой «Применить» (цена — тогда). Ждёт до конца
 *                   следующего хода героя;
 *   Перенаправить — промах: кнопки — существа в 5 футах от цели; выбор переводит прицел, тот же бросок атаки
 *                   против нового КД;
 *   Кубик судьбы  — при применении к6 в чат: 1 — половина силы, 6 — двойная (кости урона или лечения);
 *   Отложенный выбор — срабатывает в конце раунда: карточка-напоминание, цель и броски — на честность;
 *   Двойное эхо   — атака выпала 1 или 20 — кнопка «Ещё раз»: то же применение без цены, с новым броском
 *                   (повтор не повторяется);
 *   Избирательно — строкой.
 * Флаги актёра: facetJinx — следующий к20 с помехой; facetBoon — с преимуществом; facetFate — множитель силы;
 * facetVerdicts — объявленные приговоры; facetDeferred — способности, ждущие конца раунда.
 */

import { MODULE_ID } from "../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { onRenderChatMessage, messageActivity } from "../../core/chat-hooks.js";
import { around, tokenOf, esc, centerOf, isDead } from "../skills/blast/common.js";
import { STONES, stonesFor } from "./facet.js";
import { noteCard, tokenFrom, uuidOf, acOf, hits } from "./stones.js";
import { t } from "../../core/i18n.js";

const firstTarget = () => [...game.user.targets][0]?.document ?? null;
const hpOf = actor => actor?.system?.attributes?.hp ?? {};
const maxOf = hp => Number(hp.effectiveMax) || Number(hp.max) || 0;
/** Половина ПЗ и меньше */
const bloodied = actor => { const hp = hpOf(actor), max = maxOf(hp); return max > 0 && (Number(hp.value) || 0) <= max / 2; };
const casterOf = actor => tokenOf(actor)?.document ?? null;
const enemyOf = (a, b) => a && b && a.disposition !== b.disposition;
const setAdv = (config, key) => {
    config[key] = true;
    for (const roll of config.rolls ?? []) (roll.options ??= {})[key] = true;
};

// ==========================================
// БРОСОК АТАКИ: Сглаз, Без пощады
// ==========================================

Hooks.on('dnd5e.preRollAttackV2', config => {
    const activity = config?.subject, stones = stonesFor(activity);
    if (!stones.length) return;
    if (stones.includes('jinx')) setAdv(config, 'advantage');
    const target = firstTarget();
    if (stones.includes('mercy') && target?.actor && bloodied(target.actor)) setAdv(config, 'advantage');
});

// Любой к20 героя: расплата Сглаза и Возврата — помеха; дар Без пощады — преимущество. Тратится этим броском
Hooks.on('dnd5e.preRollD20TestV2', config => {
    const subject = config?.subject;
    const actor = subject?.documentName === 'Actor' ? subject : subject?.item?.actor ?? subject?.actor ?? null;
    if (!actor?.isOwner) return;
    const jinx = actor.getFlag(MODULE_ID, 'facetJinx'), boon = actor.getFlag(MODULE_ID, 'facetBoon');
    if (jinx) { setAdv(config, 'disadvantage'); actor.unsetFlag(MODULE_ID, 'facetJinx'); }
    if (boon) { setAdv(config, 'advantage'); actor.unsetFlag(MODULE_ID, 'facetBoon'); }
});

// ==========================================
// СИЛА: Неотвратимо (пополам), Кубик судьбы (×½ или ×2)
// ==========================================

const half = formula => `floor((${formula}) / 2)`;
const twice = formula => `(${formula}) * 2`;
Hooks.on('dnd5e.preRollDamageV2', config => {
    const activity = config?.subject, stones = stonesFor(activity), actor = activity?.item?.actor;
    if (!stones.length || !actor) return;
    const fate = stones.includes('fate') ? actor.getFlag(MODULE_ID, 'facetFate') : null;
    const fateHere = fate?.uuid === activity.uuid ? fate.factor : 1;
    for (const roll of config.rolls ?? []) {
        let parts = roll.parts ?? [];
        if (stones.includes('inevitable')) parts = parts.map(half);
        if (fateHere === 0.5) parts = parts.map(half);
        if (fateHere === 2) parts = parts.map(twice);
        roll.parts = parts;
    }
    if (fate?.uuid === activity.uuid) actor.unsetFlag(MODULE_ID, 'facetFate');
});

// ==========================================
// ПРИМЕНЕНИЕ: Приговор (вместо применения), Отложенный выбор, Кубик судьбы, Без пощады союзнику, цена для Возврата
// ==========================================

/** Применение, которое сейчас идёт само (приговор сработал, Двойное эхо) — без проверок камней */
let firing = null;
/** Цена последнего применения: активность → { slot, itemId, uses } — для Возврата */
const COSTS = new Map();

Hooks.on('dnd5e.preUseActivity', (activity, usage) => {
    const stones = stonesFor(activity), actor = activity?.item?.actor;
    if (!stones.length || !actor) return;
    if (firing === activity.uuid) {
        if (firing && usage && FREE.has(activity.uuid)) usage.consume = false;
        return;
    }
    // Новое применение: повтор Двойного эха, по которому не бросили атаку, больше не ждёт
    if (actor.getFlag(MODULE_ID, 'facetTwin')) actor.unsetFlag(MODULE_ID, 'facetTwin');
    // Приговор: враг ещё выше половины ПЗ — не применять, а объявить
    if (stones.includes('verdict')) {
        const target = firstTarget(), caster = casterOf(actor);
        if (target?.actor && enemyOf(caster, target) && !bloodied(target.actor)) {
            declareVerdict(activity, actor, target).catch(error => console.error(`${MODULE_ID} | огранка: приговор`, error));
            return false;
        }
    }
});
/** Применения без цены (Двойное эхо) */
const FREE = new Set();

Hooks.on('dnd5e.postUseActivity', (activity, usage, results) => {
    const stones = stonesFor(activity), actor = activity?.item?.actor, message = results?.message;
    if (!stones.length || !actor) return;
    const caster = casterOf(actor);
    // Цена для Возврата
    if (stones.includes('refund')) {
        const slot = usage?.spell?.slot ?? null;
        const item = activity.item, uses = item.system?.uses?.max && usage?.consume !== false ? 1 : 0;
        COSTS.set(activity.uuid, { slot: activity.item.type === 'spell' && (activity.item.system.level ?? 0) > 0 ? slot : null, itemId: item.id, uses });
        message?.setFlag?.(MODULE_ID, 'facetCost', COSTS.get(activity.uuid));
    }
    // Отложенный выбор: в конце раунда — напоминание в чат
    if (stones.includes('defer') && game.combat?.started) actor.setFlag(MODULE_ID, 'facetDeferred', [...(actor.getFlag(MODULE_ID, 'facetDeferred') ?? []), activity.item.name]);
    // Кубик судьбы — к6 в чат, сила следующего броска урона или лечения этой способности
    if (stones.includes('fate')) rollFate(activity, actor, message).catch(error => console.error(`${MODULE_ID} | огранка: кубик`, error));
    // Сглаз без броска атаки (спасбросок) — расплата сразу
    if (stones.includes('jinx') && activity.type !== 'attack') actor.setFlag(MODULE_ID, 'facetJinx', true);
    // Без пощады союзнику: преимущество на его ближайший к20
    const target = firstTarget();
    if (stones.includes('mercy') && target?.actor && caster && !enemyOf(caster, target) && target.actor.id !== actor.id) {
        requestGM('facetBoon', { actorId: target.actor.id });
        message?.setFlag?.(MODULE_ID, 'facetBoonTo', target.name);
    }
    if (stones.includes('mercy') && target?.actor && enemyOf(caster, target)) message?.setFlag?.(MODULE_ID, 'facetMercy', bloodied(target.actor));
});
onSocket('facetBoon', ({ payload }) => { if (isActiveGM()) game.actors.get(payload.actorId)?.setFlag(MODULE_ID, 'facetBoon', true); });

async function rollFate(activity, actor, message) {
    const roll = await new Roll('1d6').evaluate();
    const n = roll.total, factor = n === 1 ? 0.5 : n === 6 ? 2 : 1;
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: t('Кубик судьбы — {name}: {v}', { name: activity.item.name, v: factor === 0.5 ? t('половина силы') : factor === 2 ? t('двойная сила') : t('обычная сила') }) });
    // Новый бросок заменяет прежний: множитель, до которого урон не дошёл (промах), не переходит дальше
    if (factor !== 1) await actor.setFlag(MODULE_ID, 'facetFate', { uuid: activity.uuid, factor });
    else if (actor.getFlag(MODULE_ID, 'facetFate')) await actor.unsetFlag(MODULE_ID, 'facetFate');
    await message?.setFlag?.(MODULE_ID, 'facetFateRoll', n);
}

// ==========================================
// ПОСЛЕ АТАКИ: Сглаз (расплата), Возврат, Перенаправить, Двойное эхо
// ==========================================

Hooks.on('dnd5e.rollAttackV2', (rolls, data) => {
    const activity = data?.subject, stones = stonesFor(activity), actor = activity?.item?.actor;
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if (!stones.length || !actor || !roll) return;
    const total = Number(roll.total) || 0, nat = Number(roll.d20?.total ?? roll.dice?.[0]?.total) || 0;
    const target = firstTarget();
    const check = { kind: 'attack', total, nat, auto: stones.includes('inevitable') };
    const missed = target?.actor && !hits(check, target);
    if (stones.includes('jinx')) actor.setFlag(MODULE_ID, 'facetJinx', true);
    if (stones.includes('refund') && missed) refundCard(actor, activity, t('Промах по {v}: атака {total} против КД {ac}.', { v: esc(target.name), total, ac: acOf(target) }));
    if (stones.includes('redirect') && missed) redirectCard(actor, activity, target, check);
    // Двойное эхо: 1 или 20 — ещё раз; повтор не повторяется
    if (stones.includes('twin')) {
        // Первая атака после «Ещё раз» — это и есть повтор, что бы ни выпало
        if (actor.getFlag(MODULE_ID, 'facetTwin') === activity.uuid) actor.unsetFlag(MODULE_ID, 'facetTwin');
        else if (nat === 1 || nat === 20) twinCard(actor, activity, nat);
    }
});

/** Карточка камня с кнопками, по флагу сообщения — кнопки рисуются у всех, нажимает владелец героя */
function stoneCard(actor, { title, text, buttons = [], flag }) {
    const html = `<div class="gd-blast-card gd-stone-card"><div class="gd-blast-title"><i class="fas fa-gem"></i> ${esc(title)}</div><p class="gd-stone-why">${text}</p>
        ${buttons.length ? `<div class="gd-stone-buttons">${buttons.map(b => `<button type="button" data-gd-odds="${b.action}" data-value="${esc(b.value ?? '')}">${b.label}</button>`).join('')}</div>` : ''}</div>`;
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: html, flags: { [MODULE_ID]: { facetOdds: { actorId: actor.id, ...flag } } } });
}

function refundCard(actor, activity, why) {
    const cost = COSTS.get(activity.uuid) ?? {};
    const what = cost.slot ? t('ячейка заклинания') : cost.uses ? t('заряд') : null;
    if (!what) return noteCard(actor, t('Возврат — {name}', { name: activity.item.name }), t('{why} Цены не было — возвращать нечего.', { why }));
    return stoneCard(actor, { title: t('Возврат — {name}', { name: activity.item.name }), text: t('{why} Цена возвращается: {what}. Ваш следующий к20 — с помехой.', { why, what }),
        buttons: [{ action: 'refund', label: `<i class="fas fa-rotate-left"></i> ${t('Вернуть цену')}` }], flag: { cost, used: false } });
}

function redirectCard(actor, activity, target, check) {
    const caster = casterOf(actor);
    const pool = around(target, 5).filter(tok => tok.id !== target.id && tok.id !== caster?.id && tok.actor && !tok.hidden && !isDead(tok.actor));
    const title = t('Перенаправить — {name}', { name: activity.item.name });
    if (!pool.length) return noteCard(actor, title, t('Промах по {v} — рядом с ним никого.', { v: esc(target.name) }));
    return stoneCard(actor, { title, text: t('Промах по {v}. Перенести на другого в 5 футах от него — с тем же броском {total}:', { v: esc(target.name), total: check.total }),
        buttons: pool.map(tok => ({ action: 'redirect', value: uuidOf(tok), label: `${esc(tok.name)} <small>${t('КД {ac}{v}', { ac: acOf(tok), v: hits(check, tok) ? t(' — попадание') : t(' — мимо') })}</small>` })),
        flag: { check, used: false } });
}

function twinCard(actor, activity, nat) {
    return stoneCard(actor, { title: t('Двойное эхо — {name}', { name: activity.item.name }),
        text: t('На кости {nat} — способность срабатывает ещё раз по той же цели, без цены, с новым броском.', { nat }),
        buttons: [{ action: 'twin', label: `<i class="fas fa-repeat"></i> ${t('Ещё раз')}` }], flag: { uuid: activity.uuid, used: false } });
}

onRenderChatMessage((message, html) => {
    if (!html?.querySelectorAll) return;
    const card = message.getFlag?.(MODULE_ID, 'facetOdds');
    if (card) {
        const actor = game.actors.get(card.actorId), owner = game.user.isGM || actor?.isOwner;
        html.querySelectorAll('[data-gd-odds]').forEach(b => {
            b.disabled = !owner || card.used;
            b.classList.toggle('on', card.used === b.dataset.value || (card.used === true && !b.dataset.value));
            b.addEventListener('click', event => { event.preventDefault(); oddsButton(message, card, b.dataset.gdOdds, b.dataset.value).catch(error => console.error(`${MODULE_ID} | огранка`, error)); });
        });
    }
    lines(message, html);
});

async function oddsButton(message, card, action, value) {
    const actor = game.actors.get(card.actorId);
    if (!actor || card.used) return;
    if (action === 'refund') {
        const { slot, itemId, uses } = card.cost ?? {};
        if (slot && actor.system.spells?.[slot]) {
            const s = actor.system.spells[slot];
            await actor.update({ [`system.spells.${slot}.value`]: Math.min(Number(s.max) || 99, (Number(s.value) || 0) + 1) });
        } else if (uses) {
            const item = actor.items.get(itemId);
            if (item) await item.update({ 'system.uses.spent': Math.max(0, (Number(item.system.uses.spent) || 0) - 1) });
        }
        await actor.setFlag(MODULE_ID, 'facetJinx', true);
        return markUsed(message, card, true, t('Цена вернулась. Следующий к20 — с помехой.'));
    }
    if (action === 'redirect') {
        const token = await tokenFrom(value);
        if (!token) return;
        token.object?.setTarget(true, { releaseOthers: true });
        const hit = hits(card.check, token);
        return markUsed(message, card, value, hit ? t('Перенаправлено на {v}: попадание — бросайте урон.', { v: esc(token.name) }) : t('Перенаправлено на {v}: атака {total} против КД {ac} — тоже мимо.', { v: esc(token.name), total: card.check.total, ac: acOf(token) }));
    }
    if (action === 'twin') {
        const activity = await fromUuid(card.uuid);
        if (!activity) return;
        await markUsed(message, card, true, t('Срабатывает ещё раз.'));
        await actor.setFlag(MODULE_ID, 'facetTwin', activity.uuid);
        return freeUse(activity);
    }
    if (action === 'verdict') {
        const activity = await fromUuid(card.uuid), target = await tokenFrom(card.target);
        if (!activity || !target) return;
        target.object?.setTarget(true, { releaseOthers: true });
        await markUsed(message, card, true, t('Приговор исполнен — цена тратится сейчас.'));
        firing = activity.uuid;
        try { await activity.use(); } finally { firing = null; }
    }
}
async function freeUse(activity) {
    firing = activity.uuid; FREE.add(activity.uuid);
    try { await activity.use({ consume: false }); } finally { firing = null; FREE.delete(activity.uuid); }
}
/** Кнопка нажата — карточка запоминает выбор и строку итога (кнопки гаснут у всех) */
function markUsed(message, card, used, line) {
    const content = message.content.replace(/<div class="gd-stone-buttons">/, `<p><b>${line}</b></p><div class="gd-stone-buttons">`);
    if (message.isOwner) return message.update({ content, [`flags.${MODULE_ID}.facetOdds.used`]: used });
    return requestGM('facetOddsUsed', { messageId: message.id, used, content });
}
onSocket('facetOddsUsed', ({ payload }) => {
    if (!isActiveGM()) return;
    game.messages.get(payload.messageId)?.update({ content: payload.content, [`flags.${MODULE_ID}.facetOdds.used`]: payload.used });
});

// ==========================================
// ПРИГОВОР: объявить, сработать на половине ПЗ, истечь
// ==========================================

async function declareVerdict(activity, actor, target) {
    const list = actor.getFlag(MODULE_ID, 'facetVerdicts') ?? [];
    list.push({ uuid: activity.uuid, name: activity.item.name, target: target.uuid, actorUuid: target.actor.uuid, ends: 0 });
    await actor.setFlag(MODULE_ID, 'facetVerdicts', list);
    await noteCard(actor, t('Приговор — {name}', { name: activity.item.name }),
        t('Объявлен на {v}, ничего не потрачено. Как только его ПЗ впервые упадут до половины — от чьего угодно удара, — способность сработает по нему, и только тогда тратится цена. Ждёт до конца вашего следующего хода.', { v: esc(target.name) }));
}

// ПЗ врага упали до половины — у Мастера: карточка «Применить» владельцу приговора
Hooks.on('updateActor', (victim, changes) => {
    if (!isActiveGM() || changes?.system?.attributes?.hp?.value === undefined || !bloodied(victim)) return;
    for (const actor of game.actors.filter(a => (a.getFlag(MODULE_ID, 'facetVerdicts') ?? []).some(v => v.actorUuid === victim.uuid))) {
        const list = actor.getFlag(MODULE_ID, 'facetVerdicts');
        const due = list.filter(v => v.actorUuid === victim.uuid);
        actor.setFlag(MODULE_ID, 'facetVerdicts', list.filter(v => v.actorUuid !== victim.uuid));
        for (const v of due) stoneCard(actor, { title: t('Приговор — {name}', { name: v.name }), text: t('ПЗ {v} упали до половины — приговор исполняется.', { v: esc(victim.name) }),
            buttons: [{ action: 'verdict', label: `<i class="fas fa-gavel"></i> ${t('Применить')}` }], flag: { uuid: v.uuid, target: v.target, used: false } });
    }
});
// Ждёт до конца следующего хода героя: второй конец его хода — приговор снят
Hooks.on('combatTurnChange', (combat, prev) => {
    if (!isActiveGM() || !combat?.started) return;
    const actor = combat.combatants.get(prev?.combatantId)?.actor, list = actor?.getFlag(MODULE_ID, 'facetVerdicts');
    if (!list?.length) return;
    const left = list.map(v => ({ ...v, ends: v.ends + 1 }));
    const gone = left.filter(v => v.ends >= 2);
    actor.setFlag(MODULE_ID, 'facetVerdicts', left.filter(v => v.ends < 2));
    for (const v of gone) noteCard(actor, t('Приговор — {name}', { name: v.name }), t('Не дождался: ПЗ цели так и не упали до половины. Цена не потрачена.'));
});
Hooks.on('deleteCombat', combat => {
    if (!isActiveGM()) return;
    for (const c of combat.combatants) {
        if (c.actor?.getFlag(MODULE_ID, 'facetVerdicts')) c.actor.unsetFlag(MODULE_ID, 'facetVerdicts');
        if (c.actor?.getFlag(MODULE_ID, 'facetDeferred')) c.actor.unsetFlag(MODULE_ID, 'facetDeferred');
    }
});

// ==========================================
// ОТЛОЖЕННЫЙ ВЫБОР: конец раунда — способность срабатывает
// ==========================================

Hooks.on('combatTurnChange', (combat, prev, cur) => {
    if (!isActiveGM() || !combat?.started || !(cur?.round > prev?.round)) return;
    (async () => {
        for (const actor of new Set(combat.combatants.map(c => c.actor))) {
            const list = actor?.getFlag(MODULE_ID, 'facetDeferred');
            if (!list?.length) continue;
            await actor.unsetFlag(MODULE_ID, 'facetDeferred');
            for (const name of list) await noteCard(actor, t('Отложенный выбор — {name}', { name }), t('Раунд закончился: выберите цель и бросайте — способность срабатывает сейчас.'));
        }
    })().catch(error => console.error(`${MODULE_ID} | огранка: отложенный выбор`, error));
});

// ==========================================
// СТРОКИ В КАРТОЧКЕ СПОСОБНОСТИ — что камни меняют в спасброске и цели (на честность)
// ==========================================

function lines(message, html) {
    if (html.querySelector('.gd-facet-more') || (message.type !== 'usage' && message.getFlag?.('dnd5e', 'messageType') !== 'usage')) return;
    const activity = messageActivity(message), stones = activity ? stonesFor(activity) : [];
    if (!stones.length) return;
    const save = activity.type === 'save', out = [];
    if (stones.includes('inevitable')) out.push(save ? t('<b>Неотвратимо</b>: спасбросок цели — провал без броска; сила вдвое меньше') : t('<b>Неотвратимо</b>: атака попадает, сила вдвое меньше'));
    if (stones.includes('jinx')) out.push(save ? t('<b>Сглаз</b>: спасбросок цели с помехой; ваш следующий к20 — с помехой') : t('<b>Сглаз</b>: атака с преимуществом; ваш следующий к20 — с помехой'));
    if (stones.includes('mercy') && message.getFlag(MODULE_ID, 'facetMercy') && save) out.push(t('<b>Без пощады</b>: цель на половине ПЗ — её спасбросок с помехой'));
    if (message.getFlag(MODULE_ID, 'facetBoonTo')) out.push(t('<b>Без пощады</b>: у {v} преимущество на ближайший к20', { v: esc(message.getFlag(MODULE_ID, 'facetBoonTo')) }));
    if (stones.includes('select')) out.push(t('<b>Избирательно</b>: назовите, кого способность не заденет, — они не получают эффекта ни от неё, ни от камней'));
    if (stones.includes('defer')) out.push(t('<b>Отложенный выбор</b>: сработает в конце раунда — тогда и выберите цель'));
    if (stones.includes('redirect') && save) out.push(t('<b>Перенаправить</b>: цель спаслась — эффект можно перенести на другое существо в 5 футах от неё (оно совершает свой спасбросок)'));
    const fate = message.getFlag(MODULE_ID, 'facetFateRoll');
    if (fate) out.push(t('<b>Кубик судьбы</b>: {n} — {v}', { n: fate, v: fate === 1 ? t('половина силы') : fate === 6 ? t('двойная сила') : t('обычная сила') }));
    const actor = activity.item.actor;
    if (stones.includes('refund') && save && actor?.isOwner) out.push(`<button type="button" class="gd-stone-refund"><i class="fas fa-rotate-left"></i> ${t('Возврат: все спаслись — вернуть цену')}</button>`);
    if (!out.length) return;
    const div = document.createElement('div');
    div.className = 'gd-facet-line gd-facet-more';
    div.innerHTML = out.join(' · ');
    div.querySelector('.gd-stone-refund')?.addEventListener('click', event => {
        event.preventDefault(); event.currentTarget.disabled = true;
        COSTS.set(activity.uuid, message.getFlag(MODULE_ID, 'facetCost') ?? COSTS.get(activity.uuid));
        refundCard(actor, activity, t('Все спаслись.'));
    });
    const line = html.querySelector('.gd-facet-line');
    if (line) line.after(div); else (html.querySelector('.message-header')?.after(div) ?? html.prepend(div));
}

export const STONE_IDS = Object.keys(STONES);
