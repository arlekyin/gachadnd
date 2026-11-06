/**
 * Gacha Roguelike dnd5e — Эхо разума: враг-фантом
 *
 * В бою у игрока с Видением разума среди врагов стоит лишний: один, с 70% силы Видения — два. Это настоящий
 * токен Foundry — имя, полоска ПЗ, рамка, выбор целью, — но его нет в мире: он нарисован только у этого игрока
 * и у Мастера. Остальные игроки его не видят. Копия самого многочисленного врага (все разные — самого
 * потрёпанного); Босса с легендарными действиями не копирует, один враг в бою — фантома нет. Номер — следующий.
 * У фантома своя строка в трекере боя и свой ход: очередь доходит до него — он подсвечен и идёт к ближайшему
 * герою. Рассеивается, когда подошёл ударить или когда по нему ударили: действие потрачено, урона нет.
 *
 * Мастер видит фантомы всех героев — миражом (а смотря экран игрока — как игрок): голубоватые, полупрозрачные, дышат, в имени — чей это мираж.
 * Мастер может перетащить фантом и рассеять его (правый щелчок). Без Мастера всё идёт само: ход фантома
 * ведёт клиент игрока, а нет игрока в игре — Мастер.
 * Фантомы не лежат в canvas.tokens.placeables — остальные системы модуля их не видят и не трогают.
 * Где они стоят — во флаге персонажа echoPhantoms: переживают перезагрузку, заканчиваются с боем.
 */

import { MODULE_ID } from "../../core/constants.js";
import { voiceOf, voiceWhisper } from "./echo.js";
import { visionActor, visionPower, visionMode, peekActor } from "./vision.js";
import { t } from "../../core/i18n.js";

const FLAG = 'echoPhantoms';
const MIRAGE = 0x9cc4ff;  // так Мастер видит фантом: цвет голоса разума
const live = new Map();   // id → { token, entry, actor }
let layer = null;
let turn = null;          // id фантома, чей ход сейчас идёт на этом экране
let pending = null;       // ударили по фантому: { actor, ids, attack } — рассеять после броска
let queue = Promise.resolve();
const run = fn => (queue = queue.then(fn).catch(e => console.error(`gachadnd | фантом`, e)));
const wait = ms => new Promise(r => setTimeout(r, ms));

const gs = () => canvas.grid.size;
const activeCombat = () => { const c = game.combat; return c?.started && c.scene?.id === canvas.scene?.id ? c : null; };
/** Мастер видит фантом миражом — кроме экрана игрока, который он сейчас смотрит: там как у игрока */
const isMirage = actor => game.user.isGM && peekActor() !== actor;
const hearsMind = actor => actor?.type === 'character' && voiceOf(actor) === 'разум' && visionPower(actor) > 0;
/** Чьи фантомы рисовать на этом экране: у игрока — свой персонаж с Видением разума; у Мастера — все такие в бою */
function watched(combat) {
    if (!game.user.isGM) { const a = visionActor(); return hearsMind(a) && visionMode() !== 'off' ? [a] : []; }
    return [...new Set(combat.combatants.map(c => c.actor))].filter(hearsMind);
}
/** Кто ведёт фантомы персонажа (создаёт, ходит ими): игрок-владелец в игре, а нет его — Мастер */
function drives(actor) {
    const player = game.users.find(u => u.active && !u.isGM && actor.testUserPermission(u, 'OWNER'));
    return player ? player.isSelf : game.user.isActiveGM;
}
const stateOf = (actor, combat) => { const s = actor?.getFlag(MODULE_ID, FLAG); return s?.combat === combat?.id ? foundry.utils.deepClone(s) : { combat: combat?.id, list: [] }; };
const save = (actor, st) => (actor?.isOwner ? actor.update({ [`flags.${MODULE_ID}.${FLAG}`]: st }) : null);
/** Записать в флаг одну запись фантома */
async function patch(actor, id, change) {
    const combat = activeCombat();
    if (!actor?.isOwner || !combat) return;
    const st = stateOf(actor, combat), e = st.list.find(x => x.id === id);
    if (e) { Object.assign(e, change); await save(actor, st); }
}

// ---------- Клетки
const rectOf = d => ({ x: Math.round(d.x / gs()), y: Math.round(d.y / gs()), w: d.width ?? 1, h: d.height ?? 1 });
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Сколько пустых клеток между прямоугольниками (0 — вплотную) */
const gap = (a, b) => Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const centerOf = r => ({ x: (r.x + r.w / 2) * gs(), y: (r.y + r.h / 2) * gs() });
const blocked = (a, b) => !!CONFIG.Canvas.polygonBackends.move.testCollision(centerOf(a), centerOf(b), { type: 'move', mode: 'any' });
function inScene(r) {
    const d = canvas.dimensions;
    return r.x * gs() >= d.sceneX && r.y * gs() >= d.sceneY && (r.x + r.w) * gs() <= d.sceneX + d.sceneWidth && (r.y + r.h) * gs() <= d.sceneY + d.sceneHeight;
}
function occupied(r, except = null, extra = []) {
    return canvas.tokens.placeables.some(t => overlap(r, rectOf(t.document)))
        || [...live.values()].some(p => p.entry.id !== except && overlap(r, rectOf(p.token.document)))
        || extra.some(e => overlap(r, e));
}
/** Свободная клетка в 1–3 клетках от прямоугольника, без стены между */
function cellNear(around, size, except = null, extra = []) {
    const out = [];
    for (let x = around.x - size - 3; x <= around.x + around.w + 3; x++) for (let y = around.y - size - 3; y <= around.y + around.h + 3; y++) {
        const r = { x, y, w: size, h: size };
        if (overlap(r, around) || gap(r, around) > 2 || !inScene(r) || occupied(r, except, extra) || blocked(around, r)) continue;
        out.push(r);
    }
    return out.length ? out[Math.floor(Math.random() * out.length)] : null;
}

// ---------- Кого копировать
const alive = c => !c.isDefeated && (c.actor?.system?.attributes?.hp?.value ?? 1) > 0;
const hpOf = c => c.actor?.system?.attributes?.hp?.value ?? Infinity;
function pickSource(combat) {
    const foes = combat.combatants.filter(c => c.token && !c.token.hidden && c.token.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE && alive(c));
    if (foes.length < 2) return null;
    const pool = foes.filter(c => !(c.actor?.system?.resources?.legact?.max > 0));
    if (!pool.length) return null;
    const groups = Object.values(Object.groupBy(pool, c => c.actorId ?? c.id));
    const most = Math.max(...groups.map(g => g.length));
    if (most === 1) return pool.reduce((a, b) => (hpOf(b) < hpOf(a) ? b : a));
    const top = groups.filter(g => g.length === most).sort((a, b) => Math.min(...a.map(hpOf)) - Math.min(...b.map(hpOf)))[0];
    return top[Math.floor(Math.random() * top.length)];
}
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function nameFor(src, taken) {
    const base = src.name.replace(/\s+\d+$/, ''), re = new RegExp(`^${escape(base)}\\s+(\\d+)$`);
    const nums = [...canvas.scene.tokens.map(t => t.name), ...taken].map(n => n.match(re)?.[1]).filter(Boolean).map(Number);
    return nums.length ? `${base} ${Math.max(...nums) + 1}` : src.name;
}
function addEntries(st, combat, want) {
    let added = false;
    // Имена фантомов других героев тоже заняты
    const others = [...live.values()].map(p => p.entry.name);
    while (st.list.length < want) {
        const src = pickSource(combat);
        const extra = st.list.map(e => ({ x: Math.round(e.x / gs()), y: Math.round(e.y / gs()), w: e.size, h: e.size }));
        const size = src?.token.width ?? 1, cell = src && cellNear(rectOf(src.token), size, null, extra);
        if (!cell) break;
        const dex = src.actor?.system?.abilities?.dex?.mod ?? 0;
        st.list.push({
            id: foundry.utils.randomID(), source: src.tokenId, combatant: src.id, name: nameFor(src.token, [...others, ...st.list.map(e => e.name)]),
            init: Math.max(1, Math.ceil(Math.random() * 20) + dex) + 0.5, x: cell.x * gs(), y: cell.y * gs(), size, gone: false
        });
        added = true;
    }
    return added;
}

// ---------- Токен, которого нет в мире
function ensureLayer() {
    if (layer && !layer.destroyed && layer.parent === canvas.tokens) return layer;
    layer = canvas.tokens.addChild(new PIXI.Container());
    layer.name = 'gdPhantoms'; layer.sortableChildren = true;
    return layer;
}
async function draw(entry, actor) {
    const src = canvas.scene.tokens.get(entry.source);
    if (!src) return null;
    const data = src.toObject();
    // Свой, не связанный актёр: полоска ПЗ не повторяет раны оригинала. Свежий враг: ПЗ полные, эффектов нет
    Object.assign(data, { _id: entry.id, name: entry.name, x: entry.x, y: entry.y, hidden: false, actorLink: false });
    const max = src.actor?.system?.attributes?.hp?.max;
    data.delta = { ...(src.actorLink ? {} : data.delta), effects: [] };
    if (max) foundry.utils.setProperty(data, 'delta.system.attributes.hp.value', max);
    const mirage = isMirage(actor);
    if (mirage) foundry.utils.setProperty(data, 'texture.tint', `#${MIRAGE.toString(16)}`);
    const doc = new CONFIG.Token.documentClass(data, { parent: canvas.scene });
    const token = new CONFIG.Token.objectClass(doc);
    token.gdPhantom = entry.id;
    // Список размещённого на сцене (v14) о нём не знает — иначе Foundry считает его отфильтрованным и прячет
    Object.defineProperty(token, 'isFilteredOut', { get: () => false });
    // Выделять, открывать HUD и настраивать его нельзя: документа в мире нет
    token._canControl = () => false;
    token._canConfigure = () => false;
    // Маркер хода — в его ход на этом экране, как у настоящих
    token._refreshTurnMarker = function () {
        const on = CONFIG.Combat.settings.turnMarker?.enabled && this.document.turnMarker?.mode !== CONST.TOKEN_TURN_MARKER_MODES.DISABLED && turn === this.id;
        if (on) {
            if (!this.turnMarker) this.turnMarker = this.addChildAt(new foundry.canvas.placeables.tokens.TokenTurnMarker(this), 0);
            canvas.tokens.turnMarkers.add(this);
            this.turnMarker.draw();
        } else if (this.turnMarker) {
            canvas.tokens.turnMarkers.delete(this);
            this.turnMarker.destroy(); this.turnMarker = null;
        }
    };
    // Двойной щелчок — лист оригинала, как у настоящего врага (у игрока обычно ограниченный)
    token._onClickLeft2 = event => { if (src.testUserPermission(game.user, 'LIMITED')) src.actor?.sheet?.render({ force: true }); event?.stopPropagation?.(); };
    if (mirage) {
        // Мастеру: в имени — чей это мираж; правый щелчок — рассеять; перетащить — мышью
        const refreshName = token._refreshNameplate;
        token._refreshNameplate = function () { refreshName.call(this); this.nameplate.text = t('{name}\\n· мираж: {name2} ·', { name: this.document.name, name2: actor.name }); };
        token._canHUD = user => user.isGM;
        token._onClickRight = event => { event?.stopPropagation?.(); menu(entry.id); };
    } else token._canHUD = () => false;
    ensureLayer().addChild(token);
    await token.draw();
    token.renderFlags.set({ refreshVisibility: true });
    if (mirage) {
        token.mirage = true;
        token.on('pointerdown', event => dragStart(token, event));
    }
    return token;
}
// Мираж дышит: прозрачность медленно ходит волной
let breath = 0;
function breathe() {
    if (!game.user.isGM || !canvas.ready) return;
    breath += canvas.app.ticker.deltaMS / 1000;
    for (const { token } of live.values()) {
        if (!token.mirage || token.destroyed || !token.mesh || token.fading) continue;
        token.mesh.alpha = 0.5 + 0.18 * Math.sin(breath * 2.1 + token.x / 300);
    }
}
function fade(token, ms = 650) {
    token.fading = true;
    const from = token.mesh?.alpha ?? 1;
    return new Promise(resolve => {
        let t = 0;
        const tick = () => {
            t += canvas.app.ticker.deltaMS;
            const a = Math.max(0, 1 - t / ms);
            token.alpha = a; if (token.mesh) token.mesh.alpha = from * a;
            if (t >= ms) { canvas.app.ticker.remove(tick); resolve(); }
        };
        canvas.app.ticker.add(tick);
    });
}
async function remove(id, { soft = false } = {}) {
    const p = live.get(id);
    if (!p) return;
    live.delete(id);
    const t = p.token;
    if (game.user.targets.has(t)) canvas.tokens.setTargets([...game.user.targets].filter(x => x !== t).map(x => x.id));
    canvas.tokens.turnMarkers?.delete(t);
    if (soft && !t.destroyed) await fade(t);
    if (!t.destroyed) t.destroy({ children: true });
}
/** Фантом рассеялся: тает, во флаге — ушёл, голос шепчет игроку */
async function vanish(id, { whisper = true } = {}) {
    const actor = live.get(id)?.actor;
    await remove(id, { soft: true });
    rows();
    if (!actor?.isOwner) return;
    await patch(actor, id, { gone: true });
    if (whisper) await voiceWhisper(actor, 'phantom', { force: true });
}

// ---------- Мастер: рассеять, перетащить
async function menu(id) {
    const p = live.get(id);
    if (!p || !game.user.isGM) return;
    const choice = await foundry.applications.api.DialogV2.wait({
        window: { title: t('Мираж: {name}', { name: p.entry.name }) },
        content: `<p>${t('Этого врага видит только')} <strong>${foundry.utils.escapeHTML(p.actor.name)}</strong> ${t('— его рисует Эхо разума. Для игрока он неотличим от настоящего.')}</p>`,
        buttons: [
            { action: 'whisper', label: t('Рассеять (голос шепнёт)'), icon: 'fas fa-wind', default: true },
            { action: 'quiet', label: t('Рассеять молча'), icon: 'fas fa-eye-slash' },
            { action: 'cancel', label: t('Оставить'), icon: 'fas fa-xmark' }
        ],
        rejectClose: false
    });
    if (choice === 'whisper' || choice === 'quiet') run(() => vanish(id, { whisper: choice === 'whisper' }));
}
let drag = null;
function dragStart(token, event) {
    if (!game.user.isGM || event.button !== 0 || !live.has(token.gdPhantom)) return;
    event.stopPropagation();
    const at = event.getLocalPosition(canvas.tokens);
    drag = { token, dx: at.x - token.document.x, dy: at.y - token.document.y };
    canvas.stage.on('globalpointermove', dragMove);
    canvas.stage.once('pointerup', dragEnd);
    canvas.stage.once('pointerupoutside', dragEnd);
}
function dragMove(event) {
    if (!drag || drag.token.destroyed) return;
    const at = event.getLocalPosition(canvas.tokens);
    drag.token.animate({ x: at.x - drag.dx, y: at.y - drag.dy }, { duration: 0 });
}
async function dragEnd(event) {
    canvas.stage.off('globalpointermove', dragMove);
    const d = drag; drag = null;
    if (!d || d.token.destroyed) return;
    const at = event.getLocalPosition(canvas.tokens), p = live.get(d.token.gdPhantom);
    const r = { x: Math.round((at.x - d.dx) / gs()), y: Math.round((at.y - d.dy) / gs()), w: p.entry.size ?? 1, h: p.entry.size ?? 1 };
    if (!inScene(r)) return d.token.animate({ x: p.entry.x, y: p.entry.y }, { duration: 200 });
    run(() => moveTo(p, [r], { save: true }));
}

// ---------- Сверка: флаги → токены на экране
async function sync() {
    const combat = activeCombat();
    const actors = combat && canvas.ready ? watched(combat) : [];
    const want = new Map();
    for (const actor of actors) {
        const st = stateOf(actor, combat);
        if (drives(actor) && addEntries(st, combat, visionPower(actor) >= 0.7 ? 2 : 1)) await save(actor, st);
        for (const e of st.list) if (!e.gone) want.set(e.id, { entry: e, actor });
    }
    for (const id of [...live.keys()]) if (!want.has(id)) await remove(id, { soft: true });
    for (const [id, { entry, actor }] of want) {
        const p = live.get(id);
        if (!p) { const token = await draw(entry, actor); if (token) live.set(id, { token, entry, actor }); continue; }
        // Мастер начал или перестал смотреть экран игрока — мираж стал фантомом или наоборот
        if (!!p.token.mirage !== isMirage(actor)) {
            await remove(id);
            const token = await draw(entry, actor);
            if (token) live.set(id, { token, entry, actor });
            continue;
        }
        p.entry = entry;
        // Фантом сдвинул тот, кто его ведёт, или Мастер — дойти туда же
        if (p.token.document.x !== entry.x || p.token.document.y !== entry.y) await moveTo(p, [rectOf({ ...entry, width: entry.size, height: entry.size })]);
    }
    rows();
}
let timer = null;
const later = () => { clearTimeout(timer); timer = setTimeout(() => run(sync), 150); };
for (const hook of ['gachadnd.visionRebuilt', 'canvasReady', 'controlToken', 'combatStart', 'createCombatant', 'deleteCombatant', 'userConnected']) Hooks.on(hook, later);
Hooks.on('updateCombat', (combat, changes) => { if ('started' in changes || 'scene' in changes) later(); });
Hooks.on('updateActor', (actor, changes) => {
    const f = changes?.flags?.[MODULE_ID];
    if (f && (FLAG in f || `-=${FLAG}` in f || 'echo' in f) && actor.type === 'character') later();
});
Hooks.on('canvasTearDown', () => { live.clear(); layer = null; turn = null; drag = null; });
Hooks.on('canvasReady', () => { canvas.app.ticker.remove(breathe); canvas.app.ticker.add(breathe); });
Hooks.on('sightRefresh', () => { for (const { token } of live.values()) token.renderFlags.set({ refreshVisibility: true }); });
// Конец боя: фантомы уходят вместе с ним
Hooks.on('deleteCombat', combat => {
    for (const actor of new Set(combat.combatants.map(c => c.actor))) {
        if (actor?.type === 'character' && actor.getFlag(MODULE_ID, FLAG) && drives(actor)) actor.unsetFlag(MODULE_ID, FLAG);
    }
    later();
});
// Настоящий токен встал на клетку фантома — фантом отходит на свободную рядом
Hooks.on('updateToken', (doc, changes) => {
    if (!('x' in changes || 'y' in changes) || doc.parent !== canvas.scene || !live.size) return;
    run(async () => {
        await wait(400);
        const r = rectOf(doc);
        for (const p of live.values()) {
            const pr = rectOf(p.token.document);
            if (!drives(p.actor) || !overlap(r, pr)) continue;
            const cell = cellNear(pr, p.entry.size ?? 1, p.entry.id);
            if (cell) await moveTo(p, [cell], { save: true });
        }
    });
});

/** Цели и canvas.tokens.get находят фантом по id: так его можно выбрать целью, как настоящего */
const TokenLayer = foundry.canvas.layers.TokenLayer;
if (!TokenLayer.prototype.gachadndPhantom) {
    const original = TokenLayer.prototype.get;
    TokenLayer.prototype.get = function (id) { return original.call(this, id) ?? live.get(id)?.token; };
    TokenLayer.prototype.gachadndPhantom = true;
}

// ---------- Строка в трекере боя
Hooks.on('renderCombatTracker', () => rows());
function rows() {
    const el = ui.combat?.element;
    if (!el) return;
    el.querySelectorAll('[data-gd-phantom]').forEach(n => n.remove());
    const combat = activeCombat();
    if (!combat || ui.combat.viewed !== combat) return;
    const real = [...el.querySelectorAll('li.combatant[data-combatant-id]')];
    for (const { entry, token, actor } of [...live.values()].sort((a, b) => b.entry.init - a.entry.init)) {
        const from = el.querySelector(`li.combatant[data-combatant-id="${entry.combatant}"]`) ?? real.find(r => combat.combatants.get(r.dataset.combatantId)?.token?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE);
        if (!from) continue;
        const row = from.cloneNode(true);
        row.removeAttribute('data-combatant-id'); row.removeAttribute('data-action');
        row.dataset.gdPhantom = entry.id;
        row.classList.remove('active', 'hover', 'defeated', 'hide');
        row.querySelectorAll('[data-action]').forEach(b => b.removeAttribute('data-action'));
        row.querySelectorAll('.combatant-control.active').forEach(b => b.classList.remove('active'));
        const name = row.querySelector('.name'); if (name) name.textContent = entry.name;
        if (token.mirage) {
            row.classList.add('gd-phantom-mirage');
            row.dataset.tooltip = t('Мираж Эха разума: этого врага видит только {name}. Правый щелчок по токену — рассеять, токен можно перетащить.', { name: actor.name });
            name?.insertAdjacentHTML('beforeend', ` <span class="gd-phantom-tag">${t('мираж: {v}', { v: foundry.utils.escapeHTML(actor.name) })}</span>`);
        }
        const fx = row.querySelector('.token-effects'); if (fx) fx.replaceChildren();
        const init = Math.floor(entry.init), input = row.querySelector('.token-initiative input');
        if (input) { input.value = init; input.readOnly = true; }
        else { const span = row.querySelector('.token-initiative .initiative'); if (span) span.textContent = init; }
        // Наведение и щелчок — как у настоящего: подсветить, показать на сцене
        row.addEventListener('pointerenter', () => { try { token._onHoverIn(new PointerEvent('pointerover'), { hoverOutOthers: true }); } catch (e) {} });
        row.addEventListener('pointerleave', () => { try { token._onHoverOut(new PointerEvent('pointerout')); } catch (e) {} });
        row.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); canvas.animatePan(token.center); });
        if (turn === entry.id) {
            row.classList.add('active');
            el.querySelectorAll('li.combatant.active').forEach(r => r.classList.remove('active'));
        }
        const after = real.find(r => (combat.combatants.get(r.dataset.combatantId)?.initiative ?? -Infinity) < entry.init);
        if (after) after.before(row);
        else (real.at(-1) ?? from).after(row);
    }
}

// ---------- Ход фантома
Hooks.on('combatTurnChange', (combat, prev, cur) => {
    if (combat !== activeCombat() || !live.size) return;
    run(() => turns(combat, prev, cur));
});
async function turns(combat, prev, cur) {
    if (!prev?.combatantId || !cur?.combatantId) return;
    const pi = combat.combatants.get(prev.combatantId)?.initiative, ci = combat.combatants.get(cur.combatantId)?.initiative;
    if (pi == null || ci == null) return;
    const wrap = cur.round > prev.round;
    if (!wrap && !(cur.round === prev.round && cur.turn > prev.turn)) return;
    // Между прошлым и нынешним бойцом по инициативе; на смене раунда — хвост прошлого и голова нового
    const acting = [...live.values()].filter(({ entry: e }) => (wrap ? e.init < pi || e.init > ci : e.init < pi && e.init > ci))
        .sort((a, b) => (wrap ? (a.entry.init < pi) - (b.entry.init < pi) : 0) || b.entry.init - a.entry.init)
        .map(p => p.entry.id);
    for (const id of acting) { const p = live.get(id); if (p) await act(p, combat); }
}
async function act(p, combat) {
    const realMarker = canvas.tokens.get(combat.combatant?.tokenId)?.turnMarker;
    turn = p.entry.id;
    if (realMarker) realMarker.visible = false;
    p.token.renderFlags.set({ refreshTurnMarker: true });
    rows();
    await wait(600);
    // Ходит тот, кто ведёт фантом; у остальных он лишь подсвечен, шаги придут через флаг
    if (drives(p.actor)) {
        const reached = await walk(p, combat);
        await wait(450);
        if (reached && live.has(p.entry.id)) await vanish(p.entry.id); // подошёл ударить — и рассеялся
    } else await wait(1600);
    turn = null;
    if (realMarker && !realMarker.destroyed) realMarker.visible = true;
    if (!p.token.destroyed) p.token.renderFlags.set({ refreshTurnMarker: true });
    ui.combat?.render();
}
/** Идёт к ближайшему герою со скоростью оригинала; true — встал вплотную */
async function walk(p, combat) {
    const heroes = combat.combatants.filter(c => c.token?.object && c.token.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY && alive(c)).map(c => rectOf(c.token));
    if (!heroes.length) return false;
    let r = rectOf(p.token.document);
    const target = heroes.reduce((a, b) => (gap(r, b) < gap(r, a) ? b : a));
    if (gap(r, target) === 0) return true;
    const src = canvas.scene.tokens.get(p.entry.source)?.actor;
    const steps = Math.max(1, Math.floor((src?.system?.attributes?.movement?.walk || 30) / (canvas.scene.grid.distance || 5)));
    const path = [], aim = centerOf(target);
    for (let i = 0; i < steps; i++) {
        let best = null, bestGap = gap(r, target), bestDist = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const n = { ...r, x: r.x + dx, y: r.y + dy };
            if (overlap(n, target) || !inScene(n) || occupied(n, p.entry.id) || blocked(r, n)) continue;
            const g = gap(n, target), c = centerOf(n), dist = Math.hypot(c.x - aim.x, c.y - aim.y);
            if (g < bestGap || (g === bestGap && best && dist < bestDist)) { best = n; bestGap = g; bestDist = dist; }
        }
        if (!best) break;
        r = best; path.push(r);
        if (bestGap === 0) break;
    }
    if (path.length) await moveTo(p, path, { save: true });
    return gap(r, target) === 0;
}
/** Провести фантом по клеткам; save — записать, где он встал (тот, кто ведёт, или Мастер) */
async function moveTo(p, path, { save: write = false } = {}) {
    for (const r of path) {
        if (p.token.destroyed) return;
        const from = rectOf(p.token.document), cells = Math.max(1, Math.abs(r.x - from.x), Math.abs(r.y - from.y));
        await p.token.animate({ x: r.x * gs(), y: r.y * gs() }, { duration: 240 * Math.min(cells, 4) });
        p.token.document.updateSource({ x: r.x * gs(), y: r.y * gs() });
    }
    const end = path.at(-1);
    p.entry.x = end.x * gs(); p.entry.y = end.y * gs();
    if (write) await patch(p.actor, p.entry.id, { x: p.entry.x, y: p.entry.y });
}

// ---------- Удар по фантому: действие потрачено, урона нет, фантом рассеивается
Hooks.on('dnd5e.preUseActivity', (activity, usage, dialog, message) => {
    const hit = [...game.user.targets].filter(t => t.gdPhantom);
    if (!hit.length) return;
    // Из целей и из карточки: в чате у всех атака без цели
    const uuids = new Set(hit.map(t => t.document.uuid));
    const recorded = message?.data?.system;
    if (Array.isArray(recorded?.targets)) recorded.targets = recorded.targets.filter(d => !uuids.has(d.token));
    canvas.tokens.setTargets([...game.user.targets].filter(t => !t.gdPhantom).map(t => t.id));
    pending = { actor: activity.actor, ids: hit.map(t => t.gdPhantom), attack: activity.type === 'attack' };
});
const strike = () => { const ids = pending.ids; pending = null; for (const id of ids) run(() => vanish(id)); };
Hooks.on('dnd5e.postUseActivity', activity => { if (pending && !pending.attack && activity.actor === pending.actor) strike(); });
Hooks.on('dnd5e.rollAttackV2', (rolls, data) => {
    const actor = data?.subject?.actor ?? data?.subject?.item?.actor;
    if (pending?.attack && actor === pending.actor) strike();
});

/** Для проверок: фантомы на этом экране */
export const phantomState = () => [...live.values()].map(({ token, entry, actor }) => ({
    id: entry.id, name: token.document.name, init: entry.init, x: token.document.x, y: token.document.y, visible: token.visible,
    bars: !!token.bars, source: entry.source, turn: turn === entry.id, targeted: game.user.targets.has(token),
    of: actor.name, mirage: !!token.mirage, tint: token.mesh?.tint, alpha: token.mesh?.alpha, plate: token.nameplate?.text
}));
/** Для проверок: Мастер рассеивает и переносит фантом, как правым щелчком и мышью */
export const phantomControl = {
    vanish: (id, opts) => run(() => vanish(id, opts)),
    move: (id, x, y) => { const p = live.get(id); return p && run(() => moveTo(p, [{ x, y, w: p.entry.size ?? 1, h: p.entry.size ?? 1 }], { save: true })); }
};
Hooks.once('ready', () => { if (game.gachadnd?.echo) Object.assign(game.gachadnd.echo, { phantoms: phantomState, phantomControl }); });
