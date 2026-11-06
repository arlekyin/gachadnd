/**
 * Gacha Roguelike dnd5e — Эхо: Видение (с 8 эха) — мир на экране одного игрока
 *
 * Всё рисуется только у этого клиента: остальные игроки и Мастер Видения не видят. Ничего не создаётся в мире,
 * Мастеру ничего не нужно ставить — модуль берёт всё со сцены сам. Видение не даёт и не отнимает бросков:
 * часть увиденного — правда, часть — обман.
 *   кровь    — красная виньетка в такт сердцу; за существами с ПЗ ½ и ниже капает кровь (правда);
 *   разум    — 1–2 врага-фантома среди настоящих (phantom.js), иногда что-то мелькает у края экрана (обман);
 *   аномалия — в помехах проступает число: результат следующего к20 этого игрока (правда — бросок выпадет таким).
 * Сила — от эха: на 8 едва заметно, к 12 — в полную силу; после проваленного «заглушить» — в полную до отдыха.
 * Настройка клиента «Видения Эха»: полные / приглушённые (без пульса, дрожи и мельканий) / выключены.
 */

import { MODULE_ID } from "../../core/constants.js";
import { echoOf, voiceOf, setEcho, STAGE } from "./echo.js";
import { t } from "../../core/i18n.js";

export const visionMode = () => { try { return game.settings.get(MODULE_ID, 'echoVision') ?? 'full'; } catch (e) { return 'full'; } };
const rnd = (a, b) => a + Math.random() * (b - a);

// Мастер смотрит экран игрока: Видение этого персонажа рисуется у Мастера, пока он не вернёт свой
let peek = null;
export const peekActor = () => (game.user.isGM && peek ? game.actors.get(peek) ?? null : null);
/** Посмотреть экран персонажа (повторно — вернуть свой); true — Мастер сейчас смотрит его экран */
export function setPeek(actor) {
    peek = actor && peek !== actor.id ? actor.id : null;
    const a = peekActor();
    if (a && !visionPower(a)) ui.notifications.info(t('У {name} сейчас нет Видения (эхо {value}, Видение — с {vision}): экран как у всех.', { name: a.name, value: echoOf(a).value, vision: STAGE.vision }));
    peekBanner();
    rebuild();
    Hooks.callAll('gachadnd.echoPeek', a);
    return !!a;
}
function peekBanner() {
    document.getElementById('gd-echo-peek')?.remove();
    const a = peekActor();
    if (!a) return;
    const el = document.createElement('div');
    el.id = 'gd-echo-peek';
    el.innerHTML = `<i class="fas fa-eye"></i> ${t('Экран:')} <b>${foundry.utils.escapeHTML(a.name)}</b> <button type="button"><i class="fas fa-rotate-left"></i> ${t('Вернуть свой')}</button>`;
    el.querySelector('button').addEventListener('click', () => setPeek(null));
    document.body.append(el);
}

/** Чьё Видение показывать у этого клиента: персонаж игрока; у Мастера — чей экран он смотрит, иначе выбранный токен без игрока-владельца */
export function visionActor() {
    const peeked = peekActor();
    if (peeked) return peeked;
    if (!game.user.isGM) return game.user.character ?? canvas?.tokens?.controlled?.[0]?.actor ?? null;
    const a = canvas?.tokens?.controlled?.[0]?.actor;
    return a?.type === 'character' && !game.users.some(u => !u.isGM && a.testUserPermission(u, 'OWNER')) ? a : null;
}
/** Сила Видения 0…1: с 8 эха — 0,35, к 12 — 1 */
export function visionPower(actor) {
    const e = echoOf(actor);
    if (e.full) return 1;
    return e.value < STAGE.vision ? 0 : Math.min(1, 0.35 + (e.value - STAGE.vision) / (STAGE.surge - STAGE.vision) * 0.65);
}

let cur = null;
function teardown() {
    if (!cur) return;
    canvas.app?.ticker?.remove(cur.tick);
    cur.layer?.destroy({ children: true });
    cur.dom?.forEach(el => el.remove());
    cur = null;
}

function rebuild() {
    teardown();
    Hooks.callAll('gachadnd.visionRebuilt');
    if (!canvas?.ready || visionMode() === 'off') return;
    const actor = visionActor(), voice = actor && voiceOf(actor), power = actor ? visionPower(actor) : 0;
    if (!voice || !power) { if (actor?.isOwner && echoOf(actor).foresee != null && !power) setEcho(actor, { foresee: null }); return; }
    const layer = new PIXI.Container(); layer.name = 'gdEchoVision'; layer.eventMode = 'none';
    canvas.interface.addChild(layer);
    cur = { actor, voice, power, layer, dom: [], calm: visionMode() === 'calm', t: 0 };
    ({ 'кровь': blood, 'разум': mind, 'аномалия': anomaly })[voice]?.(cur);
    cur.tick = () => { const dt = canvas.app.ticker.deltaMS / 1000; cur.t += dt; cur.step?.(dt); };
    canvas.app.ticker.add(cur.tick);
}
let timer = null;
const later = () => { clearTimeout(timer); timer = setTimeout(rebuild, 120); };
for (const hook of ['canvasReady', 'controlToken', 'createCombat', 'deleteCombat', 'combatStart']) Hooks.on(hook, later);
Hooks.on('updateActor', (actor, changes) => { if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.echo`) && (actor === cur?.actor || actor === visionActor())) later(); });
Hooks.on('canvasTearDown', teardown);

/** DOM-слой поверх доски (виньетка, полосы помех) */
function overlay(c, cls) {
    const el = document.createElement('div'); el.className = `gd-echo-overlay ${cls}`; el.style.setProperty('--echo-power', c.power);
    document.body.append(el); c.dom.push(el); return el;
}
const tokenOf = actor => actor?.getActiveTokens?.()[0] ?? null;

// ---------- Кровь: правда о слабых
function blood(c) {
    const v = overlay(c, 'blood');
    if (!c.calm) v.classList.add('beat');
    const drops = [];
    let next = 0;
    c.step = dt => {
        next -= dt;
        if (next <= 0) {
            next = rnd(0.45, 0.8) / (0.5 + c.power);
            for (const t of canvas.tokens.placeables) {
                const hp = t.actor?.system?.attributes?.hp;
                if (!t.visible || !hp?.max || hp.value <= 0 || hp.value > hp.max / 2) continue;
                const g = new PIXI.Graphics(), r = rnd(2, 4.5) * (t.w / 100 + 0.5);
                g.beginFill(0x8a0f12, 0.9).drawEllipse(0, 0, r * 1.3, r).endFill();
                g.position.set(t.center.x + rnd(-0.32, 0.32) * t.w, t.center.y + rnd(0.05, 0.45) * t.h);
                c.layer.addChild(g); drops.push({ g, age: 0 });
            }
        }
        for (const d of drops) { d.age += dt; d.g.alpha = Math.max(0, 1 - d.age / 9) * (0.4 + 0.6 * c.power); }
        while (drops.length && (drops[0].age > 9 || drops.length > 260)) drops.shift().g.destroy();
    };
}

// ---------- Разум: что-то мелькает у края экрана; сами враги-фантомы — настоящие токены (phantom.js)
function mind(c) {
    const hostiles = canvas.tokens.placeables.filter(t => t.visible && t.document.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE);
    let flick = rnd(15, 30), shade = null;
    c.step = dt => {
        if (c.calm || !hostiles.length) return;
        flick -= dt;
        if (flick <= 0 && !shade) {
            const src = hostiles[Math.floor(Math.random() * hostiles.length)], view = canvas.app.renderer.screen, inv = canvas.stage.worldTransform.clone().invert();
            const side = Math.random() < 0.5 ? 0.04 : 0.96, pt = inv.apply(new PIXI.Point(view.width * side, view.height * rnd(0.25, 0.75)));
            shade = new PIXI.Sprite(src.mesh?.texture ?? PIXI.Texture.EMPTY); shade.anchor.set(0.5); shade.width = src.w; shade.height = src.h; shade.tint = 0x000000; shade.alpha = 0;
            shade.position.copyFrom(pt); c.layer.addChild(shade); shade.age = 0;
        }
        if (shade) { shade.age += dt; shade.alpha = Math.sin(Math.min(1, shade.age / 0.35) * Math.PI) * 0.55 * c.power; if (shade.age > 0.35) { shade.destroy(); shade = null; flick = rnd(15, 30); } }
    };
}

// ---------- Аномалия: следующий к20 в помехах
let forced = null, forcedActor = null;
function anomaly(c) {
    const e = echoOf(c.actor);
    if (e.foresee == null && c.actor.isOwner) setEcho(c.actor, { foresee: 1 + Math.floor(Math.random() * 20) });
    if (!c.calm) overlay(c, 'anomaly');
    let next = rnd(4, 8), glitch = null;
    c.step = dt => {
        next -= dt;
        const n = echoOf(c.actor).foresee, me = tokenOf(c.actor);
        if (next <= 0 && !glitch && n != null && me) {
            glitch = new PIXI.Container(); glitch.age = 0;
            const style = color => new PIXI.TextStyle({ fontFamily: 'Signika, monospace', fontSize: Math.max(26, me.w * 0.42), fontWeight: '900', fill: color });
            for (const [color, dx] of [[0xff2a5a, -3], [0x2af0ff, 3], [0xf4f0ff, 0]]) { const t = new PIXI.Text(String(n), style(color)); t.anchor.set(0.5); t.x = dx; t.blendMode = color === 0xf4f0ff ? PIXI.BLEND_MODES.NORMAL : PIXI.BLEND_MODES.ADD; glitch.addChild(t); }
            for (let i = 0; i < 4; i++) { const b = new PIXI.Graphics(); b.beginFill(i % 2 ? 0x2af0ff : 0xff2a5a, 0.35).drawRect(-me.w * rnd(0.3, 0.7), rnd(-0.4, 0.4) * me.h, me.w * rnd(0.6, 1.3), rnd(2, 5)).endFill(); glitch.addChild(b); }
            glitch.position.set(me.center.x + me.w * 0.62, me.center.y - me.h * 0.55);
            c.layer.addChild(glitch);
        }
        if (glitch) {
            glitch.age += dt;
            const life = 1.7, k = glitch.age / life;
            glitch.alpha = (k < 0.15 ? k / 0.15 : k > 0.8 ? (1 - k) / 0.2 : 1) * (0.55 + 0.45 * c.power) * (c.calm ? 1 : (Math.random() < 0.12 ? 0.25 : 1));
            if (!c.calm) for (const ch of glitch.children) ch.x += rnd(-1.5, 1.5) - ch.x * 0.3;
            if (glitch.age > life) { glitch.destroy({ children: true }); glitch = null; next = rnd(18, 32) / (0.6 + c.power); }
        }
    };
}
// Следующий к20 этого персонажа выпадает тем, что видели в помехах; затем — новое число
Hooks.on('dnd5e.postRollConfiguration', (rolls, config) => {
    const actor = config?.subject?.actor ?? (config?.subject instanceof Actor ? config.subject : null);
    if (!actor?.isOwner || voiceOf(actor) !== 'аномалия' || !visionPower(actor) || visionMode() === 'off') return;
    const n = echoOf(actor).foresee;
    if (n == null || !rolls?.some(r => r.dice?.some(d => d.faces === 20))) return;
    forced = n; forcedActor = actor;
});
Hooks.once('ready', () => {
    const Die = foundry.dice?.terms?.Die;
    if (!Die || Die.prototype.gachadndForesee) return;
    const original = Die.prototype.randomFace;
    Die.prototype.randomFace = function () {
        if (forced != null && this.faces === 20) {
            const v = forced, actor = forcedActor; forced = null; forcedActor = null;
            setTimeout(() => actor?.isOwner && setEcho(actor, { foresee: 1 + Math.floor(Math.random() * 20) }), 300);
            return v;
        }
        return original.call(this);
    };
    Die.prototype.gachadndForesee = true;
    if (game.gachadnd?.echo) Object.assign(game.gachadnd.echo, { rebuildVision: rebuild, visionState });
});

export const visionState = () => (cur ? { actor: cur.actor.name, voice: cur.voice, power: cur.power, phantoms: game.gachadnd?.echo?.phantoms?.().length ?? 0, nodes: cur.layer.children.length, dom: cur.dom.map(d => d.className) } : null);
export const rebuildVision = rebuild;
