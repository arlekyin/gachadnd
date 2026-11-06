/**
 * Gacha Roguelike dnd5e — Эхо: учёт, голос, ступени, шёпоты и наплыв
 *
 * Навык Памяти — оболочка чужой сущности; от использования навыков в персонаже копится эхо прежних владельцев.
 * Эхо заменяет перегрузку и не прибавляет чисел: оно звучит (шёпот), меняет экран одного игрока (Видение,
 * vision.js) и на пороге даёт сцену наплыва — воспоминание прежнего владельца и выбор «сыграть или заглушить».
 * Всё срабатывает само; у Мастера есть кнопки вмешаться, но без них эхо живёт так же.
 *
 *   +1 — использовали навык Памяти или связку; +1 за слот сверх естественного лимита — в начале боя;
 *   +3 — навык сгорел от перегрева; −3 — долгий отдых; в ноль — Знахарь.
 *   Ступени: 4 — шёпот, 8 — Видение, 12 — наплыв.
 *
 * Флаг персонажа echo: { value, tags: {тег: эхо}, story: {голос: прочитано воспоминаний}, surge, full, foresee }.
 * Флаг меняет владелец (использование, отдых, выбор) или Мастер (бой, ПЗ, кнопки Мастера).
 */

import { MODULE_ID } from "../../core/constants.js";
import { hint } from "../../core/prefs.js";
import { isActiveGM } from "../../core/socket.js";
import { naturalSlotCap, occupiesSlot } from "../synergy/synergy.js";
import { VOICES, VOICE_TAGS } from "./voices.js";
import { t } from "../../core/i18n.js";

export const STAGE = { whisper: 4, vision: 8, surge: 12 };
export const MAX = STAGE.surge;
const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '');

// ---------- Состояние

export function echoOf(actor) {
    const e = actor?.flags?.[MODULE_ID]?.echo ?? {};
    return { value: Number(e.value) || 0, tags: { ...(e.tags ?? {}) }, story: { ...(e.story ?? {}) }, surge: e.surge ?? null, full: !!e.full, foresee: e.foresee ?? null };
}
/** Голос — тег с содержимым, давший больше всего эха; равенство — по порядку голосов */
export function voiceOf(actor) {
    const { tags } = echoOf(actor);
    let best = null;
    for (const tag of VOICE_TAGS) if ((tags[tag] ?? 0) > 0 && (!best || tags[tag] > tags[best])) best = tag;
    return best;
}
export const stageOf = value => (value >= STAGE.surge ? 'surge' : value >= STAGE.vision ? 'vision' : value >= STAGE.whisper ? 'whisper' : 'quiet');
/** Слоты сверх естественного лимита — источник эха в начале боя и Сл заглушить наплыв */
export function overloadOf(actor) {
    const slotted = actor.items.filter(i => i.flags?.[MODULE_ID]?.is_active && i.flags[MODULE_ID].skill_name && !i.flags[MODULE_ID].is_crystal_item && !i.flags[MODULE_ID].is_synergy_item && occupiesSlot(i)).length;
    return Math.max(0, slotted - naturalSlotCap(actor));
}
const isCharacter = actor => actor?.type === 'character';

/** Добавить эхо (n может быть отрицательным); tags — теги источника: от них зависит голос */
export async function addEcho(actor, n, tags = []) {
    if (!isCharacter(actor) || !actor.isOwner || !n) return;
    const e = echoOf(actor);
    e.value = Math.max(0, Math.min(MAX, e.value + n));
    if (n > 0) for (const t of tags) { const tag = String(t).toLowerCase().trim(); e.tags[tag] = (e.tags[tag] ?? 0) + n; }
    await actor.update({ [`flags.${MODULE_ID}.echo`]: e });
}
export async function setEcho(actor, patch) {
    await actor.update({ [`flags.${MODULE_ID}.echo`]: { ...echoOf(actor), ...patch } });
}

// ---------- Шёпот: строка голоса только игроку (нет игрока — Мастеру)

/** Кому идут шёпоты голоса: игроки-владельцы; нет их — Мастер (проверка, игра без игроков) */
export function echoListeners(actor) {
    const players = game.users.filter(u => !u.isGM && actor.testUserPermission(u, 'OWNER'));
    return (players.length ? players : game.users.filter(u => u.isGM)).map(u => u.id);
}
const recent = new Map();
const pick = list => list[Math.floor(Math.random() * list.length)];

/** Строка голоса по поводу: start, crit, low, use. Не чаще раза в 40 с на персонажа, без повтора подряд */
export async function voiceWhisper(actor, reason, { chance = 1, force = false } = {}) {
    if (!isCharacter(actor)) return;
    const voice = voiceOf(actor), e = echoOf(actor);
    if (!voice || (!force && e.value < STAGE.whisper) || Math.random() > chance) return;
    const now = Date.now(), last = recent.get(actor.id);
    if (!force && last && now - last.at < 40000) return;
    const lines = VOICES[voice].whispers[reason] ?? [];
    const options = lines.filter(l => l !== last?.line);
    if (!options.length) return;
    const line = pick(options);
    recent.set(actor.id, { at: now, line });
    return sendVoice(actor, voice, `<p class="gd-echo-line">«${esc(line)}»</p>`);
}
function sendVoice(actor, voice, html, extra = {}) {
    const v = VOICES[voice];
    return ChatMessage.create({
        speaker: { alias: v.title },
        whisper: echoListeners(actor),
        content: `<div class="gd-echo-card" style="--echo:${v.color}"><div class="gd-echo-title"><i class="fas ${v.icon}"></i> ${v.title} — ${esc(actor.name)}</div>${html}</div>`,
        flags: { [MODULE_ID]: { echo: { actorId: actor.id, voice, ...extra } } }
    });
}
/** Мастер шепчет игроку голосом — тем же оформлением, игрок не отличит */
export async function gmWhisper(actor, text) {
    const voice = voiceOf(actor) ?? VOICE_TAGS[0];
    return sendVoice(actor, voice, `<p class="gd-echo-line">«${esc(text)}»</p>`);
}

// ---------- Наплыв: воспоминание прежнего владельца и выбор

export async function startSurge(actor) {
    const voice = voiceOf(actor), e = echoOf(actor);
    if (!voice) return setEcho(actor, { value: STAGE.surge - 1 });
    const memories = VOICES[voice].memories, read = e.story[voice] ?? 0;
    const idx = read < memories.length ? read : Math.floor(Math.random() * memories.length);
    const surge = { voice, idx, desire: memories[idx].desire, at: Date.now() };
    await setEcho(actor, { surge });
    const dc = 10 + overloadOf(actor);
    const memory = memories[idx], last = idx === memories.length - 1 && read < memories.length;
    const players = game.users.filter(u => !u.isGM && actor.testUserPermission(u, 'OWNER'));
    const body = `<p class="gd-echo-memory">${esc(memory.text)}</p><p class="gd-echo-desire"><b>${t('Желание:')}</b> <span>${esc(surge.desire)}</span></p>`;
    const playerButtons = `<div class="gd-echo-buttons"><button type="button" data-echo="play"><i class="fas fa-masks-theater"></i> ${t('Сыграть — Вдохновение')}</button><button type="button" data-echo="mute"><i class="fas fa-hand"></i> ${t('Заглушить — спасбросок Мдр, Сл {dc}', { dc })}</button></div>`;
    const gmButtons = `<div class="gd-echo-buttons gm"><button type="button" data-echo="postpone"><i class="fas fa-clock"></i> ${t('Отложить')}</button><button type="button" data-echo="replace"><i class="fas fa-pen"></i> ${t('Заменить желание')}</button></div>`;
    const head = `<p class="gd-echo-note">${t('Наплыв: голос берёт верх на эту сцену.{v}', { v: last ? t(' Это последнее воспоминание.') : '' })}</p>`;
    const flags = { surgeAt: surge.at, last };
    if (players.length) {
        await sendVoice(actor, voice, head + body + playerButtons, flags).then(m => m?.update({ whisper: players.map(u => u.id) }));
        await ChatMessage.create({
            speaker: { alias: VOICES[voice].title },
            whisper: game.users.filter(u => u.isGM).map(u => u.id),
            content: `<div class="gd-echo-card gm" style="--echo:${VOICES[voice].color}"><div class="gd-echo-title"><i class="fas ${VOICES[voice].icon}"></i> ${t('Наплыв у {v} — {v2}', { v: esc(actor.name), v2: VOICES[voice].title.toLowerCase() })}</div>${body}<p class="gd-echo-note">${t('Игрок выбирает: сыграть или заглушить. Можно ничего не трогать.')}</p>${gmButtons}</div>`,
            flags: { [MODULE_ID]: { echo: { actorId: actor.id, voice, ...flags, gm: true } } }
        });
    } else await sendVoice(actor, voice, head + body + playerButtons + gmButtons, flags);
}

async function resolve(actor, action, message) {
    const e = echoOf(actor), s = e.surge;
    if (!s || s.at !== message.flags[MODULE_ID].echo.surgeAt) return ui.notifications.info(t('Этот наплыв уже прошёл.'));
    const story = { ...e.story, [s.voice]: Math.max(e.story[s.voice] ?? 0, s.idx + 1) };
    const v = VOICES[s.voice];
    const note = html => ChatMessage.create({ speaker: { alias: v.title }, whisper: [...new Set([...echoListeners(actor), ...game.users.filter(u => u.isGM).map(u => u.id)])], content: `<div class="gd-echo-card result" style="--echo:${v.color}">${html}</div>`, flags: { [MODULE_ID]: { echo: { actorId: actor.id, voice: s.voice } } } });
    if (action === 'play') {
        await setEcho(actor, { value: STAGE.whisper, story, surge: null });
        await actor.update({ 'system.attributes.inspiration': true });
        return note(`<p><b>${esc(actor.name)}</b> ${t('играет голос до конца сцены:')} <i>${esc(s.desire)}</i></p><p>${t('Вдохновение получено. Голос выговорился — эхо стихло до шёпота.')}</p>`);
    }
    if (action === 'mute') {
        const dc = 10 + overloadOf(actor);
        const [roll] = await actor.rollSavingThrow({ ability: 'wis', target: dc }, { configure: false }) ?? [];
        const ok = (roll?.total ?? 0) >= dc;
        await setEcho(actor, ok ? { value: STAGE.vision, story, surge: null } : { value: STAGE.surge - 1, story, surge: null, full: true });
        return note(ok ? `<p><b>${esc(actor.name)}</b> ${t('глушит голос ({total} против Сл {dc}). Голос замолкает, но Видение остаётся.', { total: roll?.total, dc })}</p>` : `<p><b>${esc(actor.name)}</b> ${t('не смог заглушить голос ({total} против Сл {dc}). Видение на полную силу до долгого отдыха.', { total: roll?.total, dc })}</p>`);
    }
    if (action === 'postpone' && game.user.isGM) {
        await setEcho(actor, { value: STAGE.surge - 1, surge: null });
        return note(`<p>${t('Наплыв у')} <b>${esc(actor.name)}</b> ${t('отложен. Голос вернётся, когда эхо снова поднимется.')}</p>`);
    }
    if (action === 'replace' && game.user.isGM) {
        const desire = await foundry.applications.api.DialogV2.prompt({
            window: { title: t('Желание голоса') }, content: `<input type="text" name="desire" value="${esc(s.desire)}" style="width:100%">`,
            ok: { label: t('Заменить'), callback: (event, button) => button.form.elements.desire.value }
        }).catch(() => null);
        if (!desire) return;
        await setEcho(actor, { surge: { ...s, desire } });
        return sendVoice(actor, s.voice, `<p class="gd-echo-desire"><b>${t('Желание изменилось:')}</b> <span>${esc(desire)}</span></p>`);
    }
}

// Кнопки карточек: работают у владельца (сыграть, заглушить) и у Мастера (отложить, заменить)
Hooks.on('renderChatMessageHTML', (message, html) => {
    const flag = message.flags?.[MODULE_ID]?.echo;
    if (!flag?.surgeAt) return;
    const actor = game.actors.get(flag.actorId);
    const live = actor && echoOf(actor).surge?.at === flag.surgeAt;
    html.querySelectorAll('[data-echo]').forEach(button => {
        const gmOnly = ['postpone', 'replace'].includes(button.dataset.echo);
        button.disabled = !live || (gmOnly ? !game.user.isGM : !actor?.isOwner);
        button.addEventListener('click', event => { event.preventDefault(); button.disabled = true; resolve(actor, button.dataset.echo, message).catch(err => console.error(`${MODULE_ID} | Эхо`, err)); });
    });
    if (!live) html.querySelector('.gd-echo-buttons')?.classList.add('done');
});
// Решение принято — карточки перерисовываются, кнопки гаснут
Hooks.on('updateActor', (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.echo`)) return;
    for (const m of game.messages.contents.slice(-30)) if (m.flags?.[MODULE_ID]?.echo?.surgeAt && m.flags[MODULE_ID].echo.actorId === actor.id) ui.chat?.updateMessage?.(m);
});

// ---------- Источники эха

// Использование навыка Памяти или связки: +1, голос — по тегам навыка
Hooks.on('dnd5e.postUseActivity', activity => {
    const item = activity?.item, flags = item?.flags?.[MODULE_ID], actor = item?.actor;
    // Хук срабатывает только у того, кто использовал навык, — эхо пишет он
    if (!flags || !actor?.isOwner || !isCharacter(actor)) return;
    if (!(flags.skill_name || flags.is_synergy_item) || flags.is_crystal_item) return;
    addEcho(actor, 1, flags.tags ?? []).then(() => voiceWhisper(actor, 'use', { chance: 0.25 }));
});
// Сгорел от перегрева: +3
Hooks.on('gachadnd.skillBurned', (actor, item) => { if (actor?.isOwner) addEcho(actor, 3, item?.flags?.[MODULE_ID]?.tags ?? []); });
// Долгий отдых: −3 и Видение снова по эху
Hooks.on('dnd5e.restCompleted', (actor, result, config) => {
    if (!actor?.isOwner || !isCharacter(actor) || !(result?.longRest ?? config?.type === 'long')) return;
    const e = echoOf(actor);
    if (e.value || e.full) setEcho(actor, { value: Math.max(0, e.value - 3), full: false });
});

// Мастер: начало боя — эхо за лишние слоты и строка голоса; ПЗ ниже половины — строка; наплыв
Hooks.on('combatStart', combat => {
    if (!isActiveGM()) return;
    for (const c of combat.combatants) {
        const actor = c.actor;
        if (!isCharacter(actor)) continue;
        const over = overloadOf(actor);
        (over ? addEcho(actor, over) : Promise.resolve()).then(() => voiceWhisper(actor, 'start', { chance: 0.6 }));
    }
});
Hooks.on('preUpdateActor', (actor, changes, options) => {
    const hp = foundry.utils.getProperty(changes, 'system.attributes.hp.value');
    if (hp !== undefined) options.gachadndHpBefore = actor.system.attributes.hp.value;
});
Hooks.on('updateActor', (actor, changes, options) => {
    if (!isActiveGM() || !isCharacter(actor)) return;
    const hp = foundry.utils.getProperty(changes, 'system.attributes.hp.value'), max = actor.system.attributes.hp.max;
    if (hp !== undefined && options.gachadndHpBefore > max / 2 && hp <= max / 2 && hp > 0) voiceWhisper(actor, 'low', { chance: 0.8 });
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.echo`)) checkSurge(actor);
});
// Крит по врагу — строка (у того, кто бросал)
Hooks.on('dnd5e.rollAttackV2', (rolls, data) => {
    const actor = data?.subject?.actor ?? data?.subject?.item?.actor;
    if (actor?.isOwner && isCharacter(actor) && rolls?.[0]?.isCritical) voiceWhisper(actor, 'crit', { chance: 0.7 });
});

// Наплыв: на пороге — сразу; в бою в ход персонажа — после его хода
const waiting = new Set();
function checkSurge(actor) {
    const e = echoOf(actor);
    if (e.value < STAGE.surge || e.surge || waiting.has(actor.id)) return;
    if (game.combat?.started && game.combat.combatant?.actor?.id === actor.id) { waiting.add(actor.id); return; }
    startSurge(actor).catch(err => console.error(`${MODULE_ID} | Наплыв`, err));
}
Hooks.on('updateCombat', combat => {
    if (!isActiveGM()) return;
    for (const id of [...waiting]) {
        if (combat.combatant?.actor?.id === id) continue;
        waiting.delete(id);
        const actor = game.actors.get(id);
        if (actor) checkSurge(actor);
    }
});
Hooks.on('deleteCombat', () => { if (!isActiveGM()) return; for (const id of [...waiting]) { waiting.delete(id); const a = game.actors.get(id); if (a) checkSurge(a); } });

// ---------- Для Терминала и подсказок

export function echoInfo(actor) {
    if (!isCharacter(actor)) return null;
    const e = echoOf(actor), voice = voiceOf(actor), v = voice ? VOICES[voice] : null, stage = stageOf(e.value);
    const label = { quiet: t('тихо'), whisper: t('шёпот'), vision: e.full ? t('Видение — на полную') : t('Видение'), surge: t('наплыв') }[stage];
    const read = voice ? Math.min(e.story[voice] ?? 0, v.memories.length) : 0;
    const tip = [t('Эхо {value} из {MAX} — {label}', { value: e.value, MAX, label }), v ? t('{title}: {read} из {length} воспоминаний', { title: v.title, read, length: v.memories.length }) : t('Голос ещё не проступил'),
        t('Шёпот — с 4, Видение — с 8, наплыв — на 12. Долгий отдых −3')].join(' · ');
    return { value: e.value, max: MAX, pct: Math.round(e.value / MAX * 100), stage, label, voice, title: v?.title ?? '', icon: v?.icon ?? 'fa-wave-square', color: v?.color ?? '#9aa', tip, full: e.full };
}

// API
Hooks.once('ready', () => {
    game.gachadnd = Object.assign(game.gachadnd ?? {}, {
        echo: { state: echoOf, voice: voiceOf, add: addEcho, set: setEcho, whisper: gmWhisper, voiceLine: voiceWhisper, surge: startSurge, info: echoInfo }
    });
});
