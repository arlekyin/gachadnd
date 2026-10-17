/**
 * Gacha Roguelike dnd5e — Летопись этажа
 *
 * Когда Мастер чертит следующий этаж, у всех открывается дневник Разлома — лист карты тем же наброском
 * чернилами:
 *   1) лист прошлого этажа; всё, куда отряд не ходил, мягко выцветает, и сразу же
 *   2) путь отряда загорается нитью от Входа к Боссу, на узлах проступают пометки: надгробие — где
 *      оставили тело, огонь — где сгорел навык, след — где прорвался Пожиратель, луна — сделка у Босса
 *      и дары луны, дом — кто поселился в Якоре;
 *   3) страница перелистывается — под ней уже лежит карта нового этажа.
 * Щелчок или Esc — пропустить. Эффекты выключены — сцены нет.
 */

import { MODULE_ID } from "../core/constants.js";
import { emit, onSocket, isActiveGM } from "../core/socket.js";
import { fxOn, fxSlow } from "../core/prefs.js";
import { boardContext } from "./map.js";
import { RESIDENTS } from "./residents.js";
import { LOTS } from "./moon-deal.js";

export const FLOOR_DRAWN = 'gachadnd.floorDrawn';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
const roman = n => ROMAN[n - 1] ?? String(n);
const esc = s => foundry.utils.escapeHTML(String(s ?? ''));
const MARKS = {
    fallen: { icon: 'fa-cross', cls: 'fallen' },
    burn: { icon: 'fa-fire', cls: 'burn' },
    breach: { icon: 'fa-paw', cls: 'breach' },
    echo: { icon: 'fa-crown', cls: 'moon' },
    devour: { icon: 'fa-paw', cls: 'moon' },
    moon: { icon: 'fa-moon', cls: 'moon' },
    resident: { icon: 'fa-house-chimney', cls: 'resident' }
};
// Пометок на узле — не больше; остальное — «и ещё N»
const PER_NODE = 3;
// Время сцены, мс: начало нити, путь (на узел, в пределах), пауза после пометок, перелистывание, новый лист
const T = { thread: 450, perNode: 480, min: 2200, max: 5600, hold: 1800, turn: 1900, rest: 2400 };

// ==========================================
// ЧТО СЛУЧИЛОСЬ НА ЭТАЖЕ
// ==========================================

/** Пометки на узлах старой карты: [{ nodeId, kind, text }] */
export function floorMarks(map, floor) {
    const path = map.visitedNodes ?? [];
    const last = path.at(-1) ?? map.currentNodeId;
    const marks = [];
    for (const grave of game.settings.get(MODULE_ID, 'graveyard') ?? []) {
        if (grave.floor === floor) marks.push({ nodeId: path.includes(grave.nodeId) ? grave.nodeId : last, kind: 'fallen', text: grave.name });
    }
    for (const entry of map.chronicle ?? []) marks.push(entry);
    const boss = map.nodes.find(n => n.type === 'boss');
    if (boss?.deal?.status === 'sealed') marks.push({ nodeId: boss.id, kind: 'moon', text: `Луна: ${LOTS[boss.deal.result?.lot ?? boss.deal.lot]?.name ?? 'сделка'}` });
    else if (boss?.deal?.status === 'refused') marks.push({ nodeId: boss.id, kind: 'moon', text: 'Луне отказали' });
    for (const r of game.settings.get(MODULE_ID, 'anchorResidents') ?? []) {
        if (r.floor === floor && RESIDENTS[r.id]) marks.push({ nodeId: last, kind: 'resident', text: `В Якоре: ${RESIDENTS[r.id].name}` });
    }
    return marks.filter(m => m.nodeId && MARKS[m.kind]);
}

// Мастер начертил новый этаж — Летопись у всех
Hooks.on(FLOOR_DRAWN, ({ oldMap, oldFloor, newMap, newFloor }) => {
    if (!isActiveGM() || !oldMap?.visitedNodes?.length || !newMap) return;
    const data = { oldMap, oldFloor, newMap, newFloor, marks: floorMarks(oldMap, oldFloor) };
    emit('floorChronicle', data);
    playChronicle(data);
});
onSocket('floorChronicle', data => playChronicle(data));

// ==========================================
// СЦЕНА
// ==========================================

let playing = null;
const SHEET = { w: 720, h: 900, top: 92, bottom: 26 };

const BOARD_H = SHEET.h - SHEET.top - SHEET.bottom;

/** Лист с картой: поле карты (оно выше листа на длинном этаже) уменьшено, чтобы этаж уместился целиком.
 *  fit = { s, top } — масштаб и отступ сверху: по ним нить и пометки встают на узлы */
async function sheet(map, floor, cls) {
    const board = boardContext(map, floor);
    const html = await foundry.applications.handlebars.renderTemplate(`modules/${MODULE_ID}/templates/map/board.hbs`, { hasMap: true, ...board });
    const el = document.createElement('div');
    el.className = `gd-chr-sheet ${cls}`;
    el.innerHTML = `<div class="gd-chr-title"><span class="gd-chr-cap">Этаж ${roman(floor)}</span><span class="gd-chr-sub">${cls === 'old' ? 'летопись' : 'новый этаж'}</span></div>
        <div class="gd-chr-board">${html}</div>`;
    const s = Math.min(1, BOARD_H / board.height);
    const fit = { s, top: (BOARD_H - board.height * s) / 2, h: board.height * s };
    const plane = el.querySelector('.gd-map-plane');
    Object.assign(plane.style, { width: `${100 / s}%`, transform: `scale(${s})`, transformOrigin: '0 0', marginTop: `${fit.top}px` });
    return { el, board, fit };
}

/** Точка узла в пикселях листа (поле — 720 × BOARD_H) */
const at = (p, fit) => ({ x: p.x * SHEET.w / 100, y: fit.top + p.y * fit.h / 100 });

/** Нить пути: кривые между узлами по порядку прохождения, в пикселях поля (штрих рисуется по длине пути) */
function threadPath(path, coords, fit) {
    const pts = path.map(id => coords[id]).filter(Boolean).map(p => at(p, fit));
    if (!pts.length) return '';
    let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], mid = ((a.y + b.y) / 2).toFixed(2);
        d += ` C${a.x.toFixed(2)},${mid} ${b.x.toFixed(2)},${mid} ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
    }
    return d;
}

/** Оборот страницы — запись в дневнике: этаж пройден и короткий итог по пометкам */
function summaryPage(data, path) {
    const count = kind => (data.marks ?? []).filter(m => m.kind === kind).length;
    const lines = [
        `Пройдено узлов: ${path.length}`,
        count('fallen') ? `Остались на этаже: ${count('fallen')}` : null,
        count('burn') ? `Сгорело навыков: ${count('burn')}` : null,
        count('breach') ? `Прорывов Пожирателя: ${count('breach')}` : null,
        ...(data.marks ?? []).filter(m => m.kind === 'moon' || m.kind === 'resident').map(m => m.text)
    ].filter(Boolean);
    return `<div class="gd-chr-diary"><div class="gd-chr-cap">Этаж ${roman(data.oldFloor)}</div><div class="gd-chr-sub">пройден</div>
        <ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
}

/**
 * Летопись у этого клиента. data = { oldMap, oldFloor, newMap, newFloor, marks }.
 * @returns {Promise<void>} когда сцена закончилась или её пропустили
 */
export async function playChronicle(data) {
    if (!fxOn() || playing) return;
    // Замедление эффектов (настройка «Замедление импакт-кадров») растягивает и Летопись
    const slow = fxSlow();
    let stopped = false;
    const timers = new Set();
    const wait = ms => new Promise(resolve => { const t = setTimeout(() => { timers.delete(t); resolve(); }, ms * slow); timers.add(t); });

    const root = document.createElement('div');
    root.className = 'gachadnd-map gd-chronicle';
    root.style.setProperty('--slow', slow);
    root.innerHTML = `<div class="gd-chr-veil"></div><div class="gd-chr-frame"><div class="gd-chr-spine"></div></div><div class="gd-chr-skip">щелчок — пропустить</div>`;
    const frame = root.querySelector('.gd-chr-frame');
    // Фаза сцены — в разметке: dim, thread, turn, end (по ней ждут проверки)
    const phase = name => { root.dataset.phase = name; };
    const fit = () => frame.style.setProperty('--s', Math.min(1, (innerHeight * 0.94) / SHEET.h, (innerWidth * 0.94) / SHEET.w).toFixed(3));
    fit();

    const old = await sheet(data.oldMap, data.oldFloor, 'old');
    const next = await sheet(data.newMap, data.newFloor, 'new');
    const path = (data.oldMap.visitedNodes ?? []).filter(id => old.board.coords[id]);

    // Нить и пометки — на самом листе: он перелистывается вместе с ними
    const layer = document.createElement('div');
    layer.className = 'gd-chr-layer';
    const d = threadPath(path, old.board.coords, old.fit);
    layer.innerHTML = `<svg class="gd-chr-thread" viewBox="0 0 ${SHEET.w} ${BOARD_H}"><path class="glow" d="${d}" pathLength="1"/><path class="core" d="${d}" pathLength="1"/></svg><div class="gd-chr-marks"></div>`;
    const byNode = new Map();
    for (const m of data.marks ?? []) byNode.set(m.nodeId, [...(byNode.get(m.nodeId) ?? []), m]);
    const marksEl = layer.querySelector('.gd-chr-marks');
    const markEls = new Map();
    for (const [nodeId, list] of byNode) {
        const coord = old.board.coords[nodeId];
        if (!coord) continue;
        const pt = at(coord, old.fit);
        const shown = list.slice(0, PER_NODE);
        const rest = list.length - shown.length;
        const el = document.createElement('div');
        el.className = `gd-chr-mark${coord.x > 62 ? ' left' : ''}`;
        el.style.left = `${pt.x}px`;
        el.style.top = `${pt.y}px`;
        el.innerHTML = shown.map(m => `<div class="${MARKS[m.kind].cls}"><i class="fas ${MARKS[m.kind].icon}"></i> ${esc(m.text)}</div>`).join('') + (rest > 0 ? `<div class="more">и ещё ${rest}</div>` : '');
        marksEl.append(el);
        markEls.set(nodeId, el);
    }
    old.el.append(layer);

    // Перелистываемая страница: лицо — прошлый этаж, оборот — чистая бумага; тени — на странице и под ней
    const leaf = document.createElement('div');
    leaf.className = 'gd-chr-leaf';
    old.el.classList.add('front');
    const back = Object.assign(document.createElement('div'), { className: 'gd-chr-sheet back' });
    back.innerHTML = summaryPage(data, path);
    leaf.append(old.el, back);
    old.el.append(Object.assign(document.createElement('div'), { className: 'gd-chr-shade' }));
    next.el.append(Object.assign(document.createElement('div'), { className: 'gd-chr-cast' }));
    frame.append(next.el, leaf);

    const finish = (fast = false) => {
        if (stopped) return;
        stopped = true;
        timers.forEach(clearTimeout);
        root.classList.add('out');
        setTimeout(() => root.remove(), fast ? 350 : 900);
        removeEventListener('keydown', onKey, true);
        playing = null;
    };
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true); } };
    root.addEventListener('click', () => finish(true));
    addEventListener('keydown', onKey, true);
    addEventListener('resize', fit, { once: true });

    playing = root;
    document.body.append(root);
    const done = new Promise(resolve => {
        const check = setInterval(() => { if (stopped) { clearInterval(check); resolve(); } }, 100);
    });

    (async () => {
        // 1–2. Дневник открыт: невиданное выцветает, нить почти сразу идёт по пути, пометки — когда нить дошла
        await wait(60);
        root.classList.add('in');
        phase('dim');
        old.el.classList.add('dim');
        await wait(T.thread);
        if (stopped) return;
        phase('thread');
        const span = Math.min(T.max, Math.max(T.min, path.length * T.perNode)) * slow;
        layer.querySelectorAll('.gd-chr-thread path').forEach(p => p.animate(
            [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
            { duration: span, easing: 'cubic-bezier(0.35, 0, 0.45, 1)', fill: 'forwards' }
        ));
        path.forEach((id, i) => {
            const el = markEls.get(id);
            if (!el) return;
            const t = setTimeout(() => { el.classList.add('on'); timers.delete(t); }, span * (path.length > 1 ? i / (path.length - 1) : 1));
            timers.add(t);
        });
        await wait(span / slow + T.hold);
        if (stopped) return;

        // 3. Страница перелистывается — под ней новый этаж; книга встаёт разворотом посередине
        phase('turn');
        frame.style.setProperty('--turn', `${T.turn * slow}ms`);
        frame.classList.add('spread');
        leaf.animate(
            [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-12deg)', offset: 0.18 }, { transform: 'rotateY(-180deg)' }],
            { duration: T.turn * slow, easing: 'cubic-bezier(0.55, 0.05, 0.35, 1)', fill: 'forwards' }
        );
        // Тень на странице густеет к ребру, тень на новом листе уходит вслед за страницей
        old.el.querySelector('.gd-chr-shade').animate([{ opacity: 0 }, { opacity: 0.55, offset: 0.5 }, { opacity: 0.85 }], { duration: T.turn * slow, fill: 'forwards' });
        next.el.querySelector('.gd-chr-cast').animate([{ opacity: 0.7, transform: 'scaleX(1)' }, { opacity: 0.35, transform: 'scaleX(0.5)', offset: 0.55 }, { opacity: 0, transform: 'scaleX(0)' }], { duration: T.turn * slow, easing: 'ease-in', fill: 'forwards' });
        await wait(T.turn);
        if (stopped) return;
        phase('end');
        await wait(T.rest);
        finish();
    })().catch(error => { console.error(`${MODULE_ID} | Летопись этажа`, error); finish(true); });
    return done;
}
