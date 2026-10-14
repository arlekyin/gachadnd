/**
 * Gacha Roguelike dnd5e — QTE (фиолетовый навык)
 *
 * Атака попадает по персонажу с экипированным QTE (и зарядом) — у владельца персонажа на экране
 * на 2,5 секунды (в спокойном режиме — 5) появляются 3–4 стрелки. Нажал все по порядку — успел:
 * атака считается брошенной с помехой (второй d20, берётся меньший); промахнулась — урона нет,
 * попала и так — урон вдвое меньше. Ошибся или не успел — атака как была. Заряд тратится в любом
 * случае.
 *
 * Бросок атаки ловится у того, кто атакует (dnd5e.rollAttackV2): попадание считается по КД цели.
 * QTE показывается владельцу (игроку; без него — Мастеру). Итог записывается во флаг персонажа,
 * и ближайший урон по нему (у того, кто применяет урон) отменяется или делится пополам.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket } from "../../core/socket.js";
import { registerCues, playCue, tone, noise } from "../../cutscene/audio.js";

const KEYS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const TIME_MS = 2500;
// Итог QTE действует на урон этой атаки — не дольше этого
const PENDING_MS = 120000;
const isQte = item => !!item?.flags?.[MODULE_ID]?.qte;

const setting = (key, fallback) => { try { return game.settings.get(MODULE_ID, key); } catch (error) { return fallback; } };
const sound = (name, options = {}) => {
    if (!setting('soundsEnabled', false)) return;
    playCue(name, { volume: setting('soundsVolume', 0.5), ...options });
};

registerCues({
    qteStart(ctx, bus, t0) { tone(ctx, bus, t0, { type: 'square', freq: [880, 880], gain: [[0, 0.12], [0.08, 0.0001]], duration: 0.1, send: 0.1 }); },
    qteKey(ctx, bus, t0, { step = 0 } = {}) { tone(ctx, bus, t0, { type: 'triangle', freq: [660 + step * 110, 660 + step * 110], gain: [[0, 0.25], [0.09, 0.0001]], duration: 0.1, send: 0.15 }); },
    qteWin(ctx, bus, t0) { for (const [n, f] of [523, 784, 1047].entries()) tone(ctx, bus, t0 + n * 0.06, { type: 'triangle', freq: [f, f], gain: [[0, 0.25], [0.25, 0.0001]], duration: 0.3, send: 0.4 }); },
    qteFail(ctx, bus, t0) {
        tone(ctx, bus, t0, { type: 'sawtooth', freq: [220, 110], gain: [[0, 0.22], [0.35, 0.0001]], duration: 0.4, send: 0.2 });
        noise(ctx, bus, t0, { type: 'lowpass', freq: [800, 200], gain: [[0, 0.15], [0.2, 0.0001]], duration: 0.25 });
    }
});

/** Навык QTE персонажа, экипированный и с зарядом */
function qteSkill(actor) {
    const item = actor?.items?.find(i => isQte(i) && i.flags[MODULE_ID].is_active);
    if (!item) return null;
    const uses = item.system?.uses;
    return !uses?.max || Number(uses.value ?? 0) > 0 ? item : null;
}

/** Кто проходит QTE: игрок-владелец в игре, иначе активный Мастер */
function qteUser(actor) {
    const player = game.users.find(u => !u.isGM && u.active && actor.testUserPermission?.(u, 'OWNER'));
    return player ?? game.users.activeGM ?? null;
}

// ==========================================
// АТАКА: ПОПАЛА ЛИ ПО ПЕРСОНАЖУ С QTE
// ==========================================

Hooks.on('dnd5e.rollAttackV2', (rolls, { subject } = {}) => {
    const roll = rolls?.[0];
    if (!roll || !subject) return;
    const d20 = roll.d20?.total ?? roll.dice?.[0]?.total;
    if (!Number.isFinite(d20)) return;
    const attacker = subject.actor ?? subject.item?.actor;
    for (const target of game.user.targets ?? []) {
        const actor = target.actor;
        if (!actor || actor === attacker || !qteSkill(actor)) continue;
        const ac = actor.system?.attributes?.ac?.value ?? 10;
        // Промах и так — QTE не нужен
        if (roll.isFumble || (!roll.isCritical && roll.total < ac)) continue;
        const user = qteUser(actor);
        if (!user) continue;
        const data = {
            userId: user.id, actorId: actor.id, tokenId: target.document?.id ?? null, sceneId: canvas.scene?.id ?? null,
            attacker: attacker?.name ?? subject.item?.name ?? 'Атака', total: roll.total, d20, ac, critical: !!roll.isCritical
        };
        if (user.id === game.user.id) runQte(data);
        else emit('qteStart', data);
    }
});

onSocket('qteStart', data => { if (data.userId === game.user.id) runQte(data); });

function actorOf({ actorId, tokenId, sceneId }) {
    const token = tokenId ? game.scenes.get(sceneId)?.tokens.get(tokenId) : null;
    return token?.actor ?? game.actors.get(actorId);
}

let running = false;

/** QTE у этого клиента: оверлей, итог — во флаг персонажа и в чат */
export async function runQte(data) {
    const actor = actorOf(data);
    const item = qteSkill(actor);
    if (!actor || !item || running) return;
    running = true;
    try {
        const uses = item.system.uses;
        if (uses?.max) await item.update({ 'system.uses.spent': Number(uses.spent ?? 0) + 1 });
        const success = await playQte({ attacker: data.attacker });
        let mode = null, text;
        if (!success) text = 'не успел — атака как была.';
        else {
            // Помеха задним числом: второй d20, берётся меньший
            const second = Math.ceil(Math.random() * 20);
            const kept = Math.min(data.d20, second);
            const total = data.total - data.d20 + kept;
            const hit = kept !== 1 && (kept === 20 || total >= data.ac);
            mode = hit ? 'half' : 'cancel';
            text = `успел! Второй d20: ${second}, итог атаки ${total} против КД ${data.ac} — ${hit ? 'всё равно попала, урон вдвое меньше' : 'промах, урона нет'}.`;
        }
        if (mode) await actor.setFlag(MODULE_ID, 'qte', { mode, at: Date.now() });
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div class="gd-qte-card ${success ? 'win' : 'fail'}"><strong>QTE</strong> — ${foundry.utils.escapeHTML?.(data.attacker) ?? data.attacker}: ${text}</div>`
        });
    } finally {
        running = false;
    }
}

// ==========================================
// УРОН ПОСЛЕ QTE
// ==========================================

// Урон, уже уменьшенный по итогу QTE, проходит без повторной проверки
const passing = new Set();

Hooks.on('dnd5e.preApplyDamage', (actor, amount) => {
    if (!(amount > 0)) return;
    if (passing.delete(actor.uuid ?? actor.id)) return;
    const pending = actor.getFlag?.(MODULE_ID, 'qte');
    if (!pending || Date.now() - pending.at > PENDING_MS) return;
    actor.unsetFlag(MODULE_ID, 'qte');
    if (pending.mode === 'cancel') {
        ui.notifications.info(`QTE: ${actor.name} увернулся — урон ${amount} не прошёл.`);
        return false;
    }
    const half = Math.floor(amount / 2);
    ui.notifications.info(`QTE: урон по ${actor.name} вдвое меньше — ${half} вместо ${amount}.`);
    passing.add(actor.uuid ?? actor.id);
    actor.applyDamage(half, { ignore: true });
    return false;
});

// ==========================================
// ОВЕРЛЕЙ
// ==========================================

/**
 * Стрелки на время: нажать все по порядку. Стрелки можно и кликать.
 * @returns {Promise<boolean>} успел ли
 */
export function playQte({ attacker = '', length = 3 + Math.floor(Math.random() * 2), time = null } = {}) {
    const keys = Object.keys(KEYS);
    const sequence = Array.from({ length }, () => keys[Math.floor(Math.random() * keys.length)]);
    const total = time ?? TIME_MS * (setting('impactCalm', false) ? 2 : 1);
    const el = document.createElement('div');
    el.className = 'gd-qte';
    el.innerHTML = `<div class="gd-qte-panel">
        <div class="gd-qte-title">QTE<small>${foundry.utils.escapeHTML?.(attacker) ?? attacker}</small></div>
        <div class="gd-qte-keys">${sequence.map((k, i) => `<button type="button" class="gd-qte-key" data-key="${k}" data-index="${i}">${KEYS[k]}</button>`).join('')}</div>
        <div class="gd-qte-timer"><i></i></div>
    </div>`;
    document.body.append(el);
    const bar = el.querySelector('.gd-qte-timer i');
    bar.style.transitionDuration = `${total}ms`;
    requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('run')));
    sound('qteStart');
    let step = 0;
    return new Promise(resolve => {
        let timer = null;
        const finish = ok => {
            clearTimeout(timer);
            document.removeEventListener('keydown', onKey, true);
            el.classList.add(ok ? 'win' : 'fail');
            sound(ok ? 'qteWin' : 'qteFail');
            setTimeout(() => el.remove(), 700);
            resolve(ok);
        };
        const press = key => {
            if (el.classList.contains('win') || el.classList.contains('fail')) return;
            if (key !== sequence[step]) return finish(false);
            el.querySelector(`.gd-qte-key[data-index="${step}"]`)?.classList.add('done');
            sound('qteKey', { step });
            if (++step === sequence.length) finish(true);
        };
        const onKey = event => {
            if (!(event.key in KEYS)) return;
            event.preventDefault();
            event.stopPropagation();
            press(event.key);
        };
        document.addEventListener('keydown', onKey, true);
        el.addEventListener('click', event => {
            const key = event.target.closest?.('.gd-qte-key')?.dataset.key;
            if (key) press(key);
        });
        timer = setTimeout(() => finish(false), total);
    });
}

