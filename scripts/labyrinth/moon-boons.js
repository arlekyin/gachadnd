/**
 * Gacha Roguelike dnd5e — Дары луны в бою: Эхо Босса и Натравить Пожирателя
 *
 * Лоты Сделки луны, которые срабатывают на следующем этаже (отметки в настройке moonBoons: { type, floor,
 * used, boss }). Когда начинается бой на этом этаже, Мастер получает шёпот с кнопками — нажимает их,
 * когда отряд просит. Решает Мастер, модуль делает рутину:
 *   Эхо Босса — копия Босса встаёт рядом с позвавшим, ходит сразу после него и рассыпается, когда её ход
 *     закончится. Ведёт её Мастер. Копия своя: раны Босса на ней не сказываются и наоборот.
 *   Натравить Пожирателя — прорыв (та же катсцена), Пожиратель на стороне отряда два своих хода бьёт
 *     врагов и уходит. Из добычи этого боя он уносит один случайный кристалл (настройка moonTithe).
 * Конец боя убирает и Эхо, и Пожирателя.
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM } from "../core/socket.js";
import { onRenderChatMessage } from "../core/chat-hooks.js";
import { hint } from "../core/prefs.js";
import { HOOKS } from "../memory/memory-api.js";
import { getFloor } from "./economy.js";
import { startBreach } from "./breach.js";
import { logChronicle } from "./chronicle-log.js";

const esc = s => foundry.utils.escapeHTML(String(s ?? ''));
const FADE = 900;
const ECHO_TINT = '#c9d6ff';
const DEVOURER_TURNS = 2;

export function registerBoonSettings() {
    game.settings.register(MODULE_ID, 'moonTithe', { scope: 'world', config: false, type: Object, default: {} });
}

const allBoons = () => foundry.utils.deepClone(game.settings.get(MODULE_ID, 'moonBoons') ?? []);

/** Неиспользованный дар этого типа на текущем этаже: { boon, index } или null */
export function availableBoon(type, floor = getFloor()) {
    const boons = allBoons();
    const index = boons.findIndex(b => b.type === type && b.floor === floor && !b.used);
    return index < 0 ? null : { boon: boons[index], index };
}

async function spendBoon(index) {
    const boons = allBoons();
    if (!boons[index]) return;
    boons[index].used = true;
    await game.settings.set(MODULE_ID, 'moonBoons', boons);
}

/**
 * Босс боя для Эха — самый опасный враждебный НИП на сцене (не Пожиратель): { id, name, img } актёра мира.
 * Сделка запоминает его, а при вызове Мастер может выбрать другого.
 */
export function findBoss(scene = canvas?.scene) {
    const cr = actor => Number(actor?.system?.details?.cr) || 0;
    const tokens = (scene?.tokens ?? []).filter(t => t.actor?.type === 'npc' && t.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE
        && t.actor.getFlag(MODULE_ID, 'creature') !== 'devourer' && game.actors.get(t.actorId));
    const best = tokens.sort((a, b) => cr(b.actor) - cr(a.actor))[0];
    if (!best) return null;
    const actor = game.actors.get(best.actorId);
    return { id: actor.id, name: actor.name, img: actor.img };
}

function card(content, { whisper = false } = {}) {
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Луна' }),
        ...(whisper ? { whisper: ChatMessage.getWhisperRecipients('GM').map(u => u.id) } : {}),
        content: `<div class="gd-moon-boon">${content}</div>`
    });
}

const partyCombatants = combat => combat.combatants.filter(c => c.actor?.type === 'character' && c.token);

// ==========================================
// ЭХО БОССА
// ==========================================

/** Свободное место рядом с токеном для существа размера w×h клеток — по кольцу вокруг */
function placeNear(token, w, h) {
    const scene = token.parent;
    const size = scene.grid.size;
    const busy = scene.tokens.filter(t => t.id !== token.id && !t.hidden).map(t => ({ x: t.x, y: t.y, w: t.width * size, h: t.height * size }));
    busy.push({ x: token.x, y: token.y, w: token.width * size, h: token.height * size });
    const free = (x, y) => x >= 0 && y >= 0 && x + w * size <= scene.width && y + h * size <= scene.height
        && !busy.some(b => x < b.x + b.w && x + w * size > b.x && y < b.y + b.h && y + h * size > b.y);
    for (let ring = 1; ring <= 4; ring++) {
        const spots = [];
        for (let dx = -w - ring + 1; dx <= token.width + ring - 1; dx++) for (let dy = -h - ring + 1; dy <= token.height + ring - 1; dy++) spots.push([dx, dy]);
        // Ближе к середине позвавшего — раньше
        spots.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
        for (const [dx, dy] of spots) {
            const x = token.x + dx * size, y = token.y + dy * size;
            if (free(x, y)) return { x, y };
        }
    }
    return { x: token.x + token.width * size, y: token.y };
}

/** Окно Мастера: кто позвал и чьё Эхо */
async function askEcho(combat, boon) {
    const party = partyCombatants(combat);
    if (!party.length) return null;
    const cr = a => Number(a.system?.details?.cr) || 0;
    const bosses = game.actors.filter(a => a.type === 'npc' && a.getFlag(MODULE_ID, 'creature') !== 'devourer').sort((a, b) => cr(b) - cr(a) || a.name.localeCompare(b.name));
    if (!bosses.length) { ui.notifications.warn('Эхо Босса: в мире нет актёров-НИП.'); return null; }
    const current = party.some(c => c.id === combat.combatant?.id) ? combat.combatant.id : party[0].id;
    const bossId = bosses.some(a => a.id === boon.boss?.id) ? boon.boss.id : bosses[0].id;
    const options = (list, selected, label) => list.map(x => `<option value="${x.id}"${x.id === selected ? ' selected' : ''}>${esc(label(x))}</option>`).join('');
    return foundry.applications.api.DialogV2.prompt({
        window: { title: 'Эхо Босса', icon: 'fas fa-crown' },
        content: `<div class="form-group"><label>Кто зовёт</label><select name="caller">${options(party, current, c => c.name)}</select></div>
            <div class="form-group"><label>Чьё Эхо</label><select name="boss">${options(bosses, bossId, a => `${a.name} (ПО ${a.system?.details?.cr ?? '—'})`)}</select></div>
            <p class="hint">Эхо ходит сразу после позвавшего и рассыпается, когда его ход закончится.</p>`,
        ok: { label: 'Позвать', icon: 'fas fa-crown', callback: (event, button) => ({ callerId: button.form.elements.caller.value, bossId: button.form.elements.boss.value }) },
        rejectClose: false
    });
}

/**
 * Позвать Эхо Босса — Мастер, в идущем бою. Без параметров — окно выбора.
 * @param {object} [o]  callerId — участник боя (персонаж), bossId — актёр мира
 * @returns {Promise<TokenDocument|null>}
 */
export async function callEcho({ callerId = null, bossId = null } = {}) {
    if (!game.user.isGM) { ui.notifications.warn('Эхо Босса зовёт Мастер — по просьбе отряда.'); return null; }
    const combat = game.combat;
    if (!combat?.started) { ui.notifications.warn('Эхо Босса: бой не идёт.'); return null; }
    const found = availableBoon('echo');
    if (!found) { ui.notifications.warn('Эхо Босса: у отряда нет этого дара на этом этаже.'); return null; }
    if (!callerId || !bossId) {
        const choice = await askEcho(combat, found.boon);
        if (!choice) return null;
        ({ callerId, bossId } = choice);
    }
    const caller = combat.combatants.get(callerId);
    const boss = game.actors.get(bossId);
    if (!caller?.token || !boss) { ui.notifications.warn('Эхо Босса: нет позвавшего или Босса.'); return null; }

    const proto = boss.prototypeToken;
    const at = placeNear(caller.token, proto.width ?? 1, proto.height ?? 1);
    const data = (await boss.getTokenDocument(at)).toObject();
    Object.assign(data, {
        name: `Эхо: ${boss.name}`, actorLink: false, hidden: false, alpha: 0.85,
        disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY
    });
    data.texture = { ...data.texture, tint: ECHO_TINT };
    data.flags = foundry.utils.mergeObject(data.flags ?? {}, { [MODULE_ID]: { echo: { caller: caller.id } } });
    const [token] = await caller.token.parent.createEmbeddedDocuments('Token', [data]);
    if (!token) return null;
    // Сразу после позвавшего: на волосок ниже его инициативы
    const initiative = Number.isFinite(caller.initiative) ? Math.round((caller.initiative - 0.001) * 1000) / 1000 : null;
    await combat.createEmbeddedDocuments('Combatant', [{ tokenId: token.id, sceneId: token.parent.id, actorId: boss.id, initiative }]);
    await spendBoon(found.index);
    logChronicle('echo', `Эхо: ${boss.name}`);
    await card(`<i class="fas fa-crown"></i> <strong>Эхо Босса.</strong> Рядом с <strong>${esc(caller.name)}</strong> встаёт ${esc(boss.name)} — бледный, как отражение в воде. Один ход сразу после позвавшего, и он рассыпется.`);
    return token;
}

// ==========================================
// НАТРАВИТЬ ПОЖИРАТЕЛЯ
// ==========================================

/**
 * Натравить Пожирателя — Мастер, в идущем бою: прорыв в выбранной точке, Пожиратель на стороне отряда.
 * @param {object} [o]  point — точка без щелчка
 * @returns {Promise<TokenDocument|null>}
 */
export async function callDevourer({ point = null } = {}) {
    if (!game.user.isGM) { ui.notifications.warn('Пожирателя натравливает Мастер — по просьбе отряда.'); return null; }
    const combat = game.combat;
    if (!combat?.started) { ui.notifications.warn('Натравить Пожирателя: бой не идёт.'); return null; }
    if (combat.scene && combat.scene.id !== canvas.scene?.id) { ui.notifications.warn('Натравить Пожирателя: откройте сцену этого боя.'); return null; }
    const found = availableBoon('devour');
    if (!found) { ui.notifications.warn('Натравить Пожирателя: у отряда нет этого дара на этом этаже.'); return null; }
    const token = await startBreach({ ally: true, point });
    if (!token) return null;
    await token.update({ name: `${token.name} (на стороне отряда)`, [`flags.${MODULE_ID}.moonDevourer`]: { turns: 0 } });
    const [combatant] = await combat.createEmbeddedDocuments('Combatant', [{ tokenId: token.id, sceneId: token.parent.id, actorId: token.actorId }]);
    if (combatant) await combat.rollInitiative([combatant.id]);
    await spendBoon(found.index);
    await game.settings.set(MODULE_ID, 'moonTithe', { floor: getFloor(), combat: combat.id });
    logChronicle('devour', 'Пожиратель за отряд');
    await card(`<i class="fas fa-paw"></i> <strong>Натравить Пожирателя.</strong> Луна открыла ему дорогу — к врагам отряда. Два хода он рвёт их, потом уходит. Из добычи этого боя он заберёт свой кристалл.`);
    return token;
}

// Плата Пожирателю: случайный кристалл из первой добычи после его прихода (на этом этаже)
Hooks.on(HOOKS.lootRolled, roll => {
    if (!isActiveGM()) return;
    const tithe = game.settings.get(MODULE_ID, 'moonTithe') ?? {};
    if (tithe.floor !== getFloor()) return;
    game.settings.set(MODULE_ID, 'moonTithe', {}).catch(() => {});
    if (!roll.drops.length) return;
    const [taken] = roll.drops.splice(Math.floor(Math.random() * roll.drops.length), 1);
    roll.lines.push(`<div class="gd-moon-boon"><i class="fas fa-paw"></i> Пожиратель уносит свою плату: <strong>${esc(taken.crystal.name)}</strong>.</div>`);
});

// ==========================================
// УХОД: ЭХО ПОСЛЕ СВОЕГО ХОДА, ПОЖИРАТЕЛЬ ПОСЛЕ ДВУХ, ВСЕ — В КОНЦЕ БОЯ
// ==========================================

async function vanish(token, combat = null) {
    if (!token?.parent) return;
    await token.update({ alpha: 0 }, { animation: { duration: FADE } }).catch(() => {});
    await new Promise(r => setTimeout(r, FADE));
    const combatant = combat?.combatants.find(c => c.tokenId === token.id);
    if (combatant) await combatant.delete().catch(() => {});
    if (token.parent?.tokens.has(token.id)) await token.delete().catch(() => {});
}

Hooks.on('combatTurnChange', async (combat, prior, current) => {
    if (!isActiveGM() || !prior?.combatantId) return;
    // Только вперёд: шаг назад в трекере никого не прогоняет
    if (!(current.round > prior.round || (current.round === prior.round && current.turn > prior.turn))) return;
    const token = combat.combatants.get(prior.combatantId)?.token;
    const flags = token?.flags?.[MODULE_ID];
    if (flags?.echo) {
        await vanish(token, combat);
        await card(`<i class="fas fa-crown"></i> Эхо ${esc(token.actor?.name ?? 'Босса')} рассыпается лунной пылью.`);
    } else if (flags?.moonDevourer) {
        const turns = (flags.moonDevourer.turns ?? 0) + 1;
        if (turns < DEVOURER_TURNS) return token.update({ [`flags.${MODULE_ID}.moonDevourer.turns`]: turns });
        await vanish(token, combat);
        await card(`<i class="fas fa-paw"></i> Пожиратель сыт этим боем и уходит в разрыв. Шов затягивается.`);
    }
});

Hooks.on('deleteCombat', async combat => {
    if (!isActiveGM() || !combat.scene) return;
    for (const token of combat.scene.tokens.filter(t => t.flags?.[MODULE_ID]?.echo || t.flags?.[MODULE_ID]?.moonDevourer)) await vanish(token);
});

// ==========================================
// ШЁПОТ МАСТЕРУ В НАЧАЛЕ БОЯ
// ==========================================

Hooks.on('combatStart', async () => {
    if (!isActiveGM() || !hint('hintMoonBoons')) return;
    const echo = availableBoon('echo'), devour = availableBoon('devour');
    if (!echo && !devour) return;
    const buttons = [
        echo ? `<button type="button" data-gd-boon="echo"><i class="fas fa-crown"></i> Позвать Эхо Босса${echo.boon.boss ? ` (${esc(echo.boon.boss.name)})` : ''}</button>` : '',
        devour ? `<button type="button" data-gd-boon="devour"><i class="fas fa-paw"></i> Натравить Пожирателя</button>` : ''
    ].join('');
    await card(`<i class="fas fa-moon"></i> <strong>Дары луны</strong> на этом этаже — по одному разу. Нажмите, когда отряд попросит.<div class="gd-moon-boon-buttons">${buttons}</div>`, { whisper: true });
});

// Дар потрачен (кнопкой, макросом) — кнопки в уже показанных шёпотах гаснут
Hooks.on('updateSetting', setting => {
    if (setting.key !== `${MODULE_ID}.moonBoons`) return;
    for (const button of document.querySelectorAll('[data-gd-boon]')) if (!availableBoon(button.dataset.gdBoon)) button.disabled = true;
});

onRenderChatMessage((message, html) => {
    for (const button of html.querySelectorAll?.('[data-gd-boon]') ?? []) {
        const type = button.dataset.gdBoon;
        if (!game.user.isGM || !availableBoon(type)) { button.disabled = true; continue; }
        button.addEventListener('click', async () => {
            button.disabled = true;
            const done = await (type === 'echo' ? callEcho() : callDevourer()).catch(error => { console.error(`${MODULE_ID} | дар луны`, error); return null; });
            if (done) ui.chat?.updateMessage?.(message); else button.disabled = false;
        });
    }
});
