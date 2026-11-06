/**
 * Gacha Roguelike dnd5e — Счётчики живых навыков: значки, надписи, правило в карточке, порог, сводка
 *
 * Игрок должен видеть, от чего растёт счётчик, и вспоминать правило после перерыва — учит само событие:
 *   значок     — у токена владельца: точки (●●○○), пустой счётчик не висит; обратный отсчёт — над носителем,
 *                его видят все (угроза, которую видно заранее);
 *   надпись    — счётчик вырос: «+1 зарубка» всплывает над токеном, как числа урона;
 *   правило    — в карточке навыка на панели Памяти: состояние и правило целиком (на сцене — только значки,
 *                чтобы ничего не закрывало клетки);
 *   порог      — строка в чат шёпотом владельцу и Мастеру («рука набита — следующий удар критический»);
 *   сводка     — в первом бою сессии шёпот владельцу: что у него копится.
 * Видят владелец и Мастер. Ничего на сцене не создаётся — у каждого клиента рисуется своё.
 * Строки на пороге и сводка — подсказка hintCounters (подменю «Подсказки Мастеру»).
 */

import { MODULE_ID } from "../../../core/constants.js";
import { hint } from "../../../core/prefs.js";
import { isAwake } from "../../synergy/synergy.js";
import { counterOf, counterMax, livingKind } from "./common.js";
import { countdownsOf } from "./countdown.js";
import { emberRadius } from "./ember.js";
import { t } from "../../../core/i18n.js";

const NAME = 'gdLivingBadge';
const plural = (n, [one, few, many]) => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);
const pips = (n, max) => '●'.repeat(Math.min(n, max)) + '○'.repeat(Math.max(0, max - n));

/**
 * Виды счётчиков: значок, единица, правило, порог. ready — счётчик дошёл до порога (после этого изменения);
 * readyText — строка на пороге.
 */
const KINDS = {
    hone: {
        icon: '⚒', unit: [t('зарубка'), t('зарубки'), t('зарубок')], max: item => counterMax(item, 4),
        badge: item => (counterOf(item) ? `⚒ ${pips(counterOf(item), counterMax(item, 4))}` : null),
        rule: item => t('{v} из {v2} зарубок. Зарубка — каждое попадание оружием. На полном счёте удар оружием — критическое попадание, счёт обнуляется. Держится до долгого отдыха.', { v: counterOf(item), v2: counterMax(item, 4) }),
        ready: (item, before) => counterOf(item) >= counterMax(item, 4) && before < counterMax(item, 4),
        readyText: () => t('рука набита — следующий удар оружием критический'),
        short: () => t('рука набита!')
    },
    third: {
        icon: '☯', unit: [t('провал'), t('провала'), t('провалов')], max: () => 2,
        badge: item => (counterOf(item) ? `☯ ${pips(counterOf(item), 2)}` : null),
        rule: item => t('{v} из 2 провалов подряд. Провал — проваленная проверка или спасбросок со Сл. После двух — следующий бросок к20 с преимуществом. Успех обнуляет счёт.', { v: counterOf(item) }),
        ready: (item, before) => counterOf(item) >= 2 && before < 2,
        readyText: () => t('следующий бросок к20 — с преимуществом'),
        short: () => t('преимущество!')
    },
    perfection: {
        icon: '✦', unit: [t('штрих'), t('штриха'), t('штрихов')], max: () => 7,
        badge: item => (counterOf(item) ? `✦ ${pips(counterOf(item), 7)}` : null),
        rule: item => t('{v} из 7 штрихов. Штрих — действие нового для этого боя вида: удар, чары, навык Памяти, манёвр, помощь, приём, окружение. Ход без нового штриха — последний гаснет. Пять — +1 к броскам атаки, проверкам и спасброскам; семь — до конца следующего хода к20 не ниже 10, потом всё по новой. Гаснет с концом боя.', { v: counterOf(item) }),
        ready: (item, before) => counterOf(item) >= 5 && before < 5,
        readyText: () => t('почти совершенство — +1 к броскам атаки, проверкам и спасброскам'),
        short: () => t('почти!')
    },
    ember: {
        icon: '🔥', unit: [t('сожжён'), t('сожжены'), t('сожжены')], max: () => null,
        badge: item => (counterOf(item) ? t('🔥 {v} фт', { v: emberRadius(item) }) : null),
        rule: item => {
            const n = counterOf(item), r = emberRadius(item);
            return t('Радиус пламени {r} футов. Каждые 3 существа, убитые вашим огнём, — радиус +5 футов, до 30. {v} Держится до конца забега.', { r, v: r >= 30 ? t('Пламя в полной силе.') : t('До следующего: {v}.', { v: 3 - (n % 3) }) });
        },
        ready: (item, before) => emberRadius(item) > emberRadius({ flags: { [MODULE_ID]: { counter: before } } }),
        readyText: item => t('пламя разгорелось — радиус {v} футов', { v: emberRadius(item) }),
        short: item => t('пламя {v} фт!', { v: emberRadius(item) })
    }
};

const canSee = actor => !!actor && (game.user.isGM || actor.isOwner);
const skillsOf = actor => (actor?.items ?? []).filter(i => KINDS[livingKind(i)] && !i.flags[MODULE_ID].is_crystal_item && isAwake(i));

function labels(token) {
    const out = [];
    const actor = token.actor;
    if (canSee(actor)) for (const item of skillsOf(actor)) {
        const text = KINDS[livingKind(item)].badge(item);
        if (text) out.push({ text, color: 0xf3e3c0, item });
    }
    for (const c of countdownsOf(game.combat)) {
        if (c.tokenId === token.document.id) out.push({ text: `⏱ ${c.value}`, color: 0xff6a3d, big: true, countdown: c });
    }
    return out;
}

/**
 * Значки над верхним краем токена: счётчики — мелкой строкой, сколько влезает в ширину клетки (обычно два), остальные —
 * строкой выше; отсчёт — крупно над ними. По бокам ничего не выходит за клетку — соседние клетки свободны
 */
function draw(token) {
    token.children?.find(c => c.name === NAME)?.destroy({ children: true });
    const list = labels(token);
    if (!list.length) return;
    const box = new PIXI.Container();
    box.name = NAME;
    box.eventMode = 'none';
    const style = big => ({ fontFamily: 'Signika, sans-serif', fontSize: Math.max(12, token.w * (big ? 0.2 : 0.13)), fontWeight: '700', stroke: 0x141210, strokeThickness: 3.5 });
    // Строки: сколько влезает в ширину клетки (обычно два), остальное — следующей строкой
    const small = list.filter(l => !l.big).map(l => ({ ...l, t: new PIXI.Text(l.text, { ...style(false), fill: l.color }) })), rows = [];
    for (const l of small) { const row = rows.at(-1), w = row ? row.reduce((s, x) => s + x.t.width + 6, 0) + l.t.width : Infinity; if (row && w <= token.w) row.push(l); else rows.push([l]); }
    let y = 0;
    for (const { text, color } of list.filter(l => l.big)) {
        const t = new PIXI.Text(text, { ...style(true), fill: color });
        t.position.set((token.w - t.width) / 2, y); y += t.height - 2; box.addChild(t);
    }
    for (const row of rows) {
        const parts = row.map(l => l.t);
        const gap = 6, width = parts.reduce((s, t) => s + t.width, 0) + gap * (parts.length - 1);
        let x = (token.w - width) / 2, h = 0;
        for (const t of parts) { t.position.set(x, y); x += t.width + gap; h = Math.max(h, t.height); box.addChild(t); }
        y += h - 2;
    }
    box.position.set(0, -y + 2);
    token.addChild(box);
}

function refreshAll() {
    if (!canvas?.ready) return;
    for (const token of canvas.tokens.placeables) draw(token);
}

let timer = null;
const later = () => { clearTimeout(timer); timer = setTimeout(refreshAll, 80); };
Hooks.on('refreshToken', token => { if (!token.children?.some(c => c.name === NAME) && labels(token).length) draw(token); });
for (const hook of ['canvasReady', 'updateCombat', 'deleteCombat', 'updateItem', 'createItem', 'deleteItem', 'createToken', 'controlToken']) Hooks.on(hook, later);

// ---------- Надпись: счётчик вырос — «+1 зарубка» над токеном (у владельца и Мастера)

const last = new Map();
const remember = actor => { for (const item of skillsOf(actor)) last.set(item.uuid, counterOf(item)); };
Hooks.once('ready', () => game.actors.forEach(remember));
Hooks.on('createItem', item => { if (KINDS[livingKind(item)]) last.set(item.uuid, counterOf(item)); });

function floatText(actor, text, color, size = 26) {
    if (!canSee(actor) || !canvas?.ready) return;
    const token = actor.getActiveTokens?.()[0];
    if (!token) return;
    canvas.interface?.createScrollingText?.(token.center, text, {
        anchor: CONST.TEXT_ANCHOR_POINTS?.TOP ?? 2, direction: CONST.TEXT_ANCHOR_POINTS?.TOP ?? 2,
        fontSize: size, fill: color, stroke: '#141210', strokeThickness: 5, jitter: 0.2, duration: 2200
    });
}

/** Строка в чат шёпотом владельцу и Мастеру */
function whisperOwners(actor, title, html, icon = 'fa-star') {
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        whisper: game.users.filter(u => u.isGM || actor.testUserPermission(u, 'OWNER')).map(u => u.id),
        content: `<div class="gd-blast-card gd-living-card"><div class="gd-blast-title"><i class="fas ${icon}"></i> ${title}</div>${html}</div>`
    });
}

Hooks.on('updateItem', (item, changes, options, userId) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.counter`)) return;
    const kind = KINDS[livingKind(item)];
    if (!kind) return;
    const before = last.get(item.uuid) ?? 0, now = counterOf(item);
    last.set(item.uuid, now);
    const actor = item.actor;
    if (now > before) {
        const d = now - before;
        floatText(actor, `+${d} ${kind.icon} ${plural(d, kind.unit)}`, '#f3e3c0');
    }
    // Порог — одна строка в чат: пишет тот, чей клиент изменил счётчик
    if (userId === game.user.id && hint('hintCounters') && kind.ready(item, before)) {
        // Строка порога — следом за «+1», чуть мельче, чтобы надписи не легли друг на друга
        setTimeout(() => floatText(actor, kind.short(item), '#ffcf6a', 24), 900);
        whisperOwners(actor, item.name, `<p>${kind.readyText(item)[0].toUpperCase()}${kind.readyText(item).slice(1)}.</p>`, 'fa-bolt');
    }
});

// ---------- Сводка: первый бой сессии — шёпот владельцу, что у него копится (пишет Мастер)

let summarized = false;
Hooks.on('combatStart', async combat => {
    if (summarized || !game.users.activeGM?.isSelf) return;
    summarized = true;
    if (!hint('hintCounters')) return;
    const actors = [...new Set(combat.combatants.map(c => c.actor).filter(a => a?.hasPlayerOwner && a.type === 'character'))];
    for (const actor of actors) {
        const lines = skillsOf(actor).map(item => {
            const kind = KINDS[livingKind(item)];
            const n = counterOf(item), max = kind.max(item);
            const state = livingKind(item) === 'ember' ? t('радиус {v} фт', { v: emberRadius(item) }) : t('{n} из {max}', { n, max });
            return `<li><b>${kind.icon} ${foundry.utils.escapeHTML(item.name)}</b> — ${state}</li>`;
        });
        if (lines.length) await whisperOwners(actor, t('Копится'), `<ul class="gd-counter-summary">${lines.join('')}</ul><p class="gd-counter-note">${t('Правило каждого счётчика — в карточке навыка на панели Памяти.')}</p>`, 'fa-layer-group');
    }
});

/** Счётчик навыка для карточки и проверок: значок на токене, состояние (и при нуле), правило целиком */
export const counterInfo = item => {
    const kind = KINDS[livingKind(item)];
    if (!kind) return null;
    const n = counterOf(item), max = kind.max(item);
    const state = livingKind(item) === 'ember' ? t('{icon} {v} фт', { icon: kind.icon, v: emberRadius(item) }) : `${kind.icon} ${pips(n, max)}`;
    return { badge: kind.badge(item), state, rule: kind.rule(item) };
};
export const resetSummary = () => { summarized = false; };
