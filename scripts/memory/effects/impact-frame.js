/**
 * Gacha Roguelike dnd5e — Импакт-кадр навыка
 *
 * Импакт-кадр — акцент результата, а не замаха: как хитстоп в файтингах, он подтверждает удар.
 * Навык с полем impact (ультимейты: Мегумин, Вергилий) при использовании только «взводится». Кадр
 * показывается, когда урон применён и он решающий: цель погибла или потеряла не меньше половины
 * максимума ПЗ. Ещё кадр даёт рухнувший слой памяти Пожирателя. Один взвод — один кадр.
 *
 * Кадр на долю секунды подменяет экран у всех игроков, по снимку сцены, как её видит каждый игрок.
 * Сначала — стартовый кадр: живая сцена, застывшая с рывком к точке удара (как хитстоп). Затем два
 * кадра удара, в которых выделены фигуры — токены нанёсшего удар и цели, вырезанные по прозрачности
 * их картинок: в первом кадре фигура — чёрный силуэт с белой каймой, во втором — белый с чёрной.
 * Фон кадров:
 *  1. светлое — чёрное, пробитое белыми штрихами от точки удара; остальное — белое в чёрных штрихах;
 *  2. инверсия: что было чёрным — сплошь белое, что было белым — чёрное с проблесками белых штрихов.
 * Границы светлого размазаны к точке удара, как в рисованных импакт-кадрах. Без сцены кадры
 * собираются из арта навыка. «Без вспышек» оставляет только первый кадр — каждый игрок у себя.
 *
 * Навык может задать свой рисунок кадра (impact.style). slash — разрез Ямато, собранный в самой
 * сцене, как импакт-кадры Roblox: фильтр сцены делает её контрастной ч/б и рассекает по линии
 * шаблона навыка (половины разъезжаются вдоль неё), токены удара — силуэты с обводкой, камера
 * делает рывок к точке удара; поверх — разрез и полосы от него. Второй кадр — инверсия.
 * fists — удар Сайтамы (impact-knock.js): камера к нему и цели, вдох, рывок, кадр света и молний,
 * пять кулаков (impact-fists.js), разлёт за целью и её отлёт на 30 футов. Кадр идёт после любого
 * применённого урона взведённого навыка, а не только решающего.
 * Значки состояний токенов (череп, кровотечение) в снимок сцены не попадают.
 */

import { MODULE_ID } from "../../core/constants.js";
import { emit, onSocket } from "../../core/socket.js";
import { playFists, prepareFists } from "./impact-fists.js";
import { knockback, playSaitama } from "./impact-knock.js";
import { playCue } from "./impact-sound.js";

// Отлёт цели Сайтамы, футы
const KNOCK_FEET = 30;

// Хронометраж, мс. Рисунок импакт-кадра в аниме держится 1–3 кадра при 24 к/с (≈42–125 мс),
// хитстоп тяжёлого удара в играх — 50–100 мс: первый кадр — 2 кадра анимации, второй — 2
const T = { start: 84, first: 168, end: 252, calm: 168 };
// Сколько взвод ждёт урона: навык использован, выбор цели, броски и применение урона — следом
const ARM_MS = 5 * 60 * 1000;
// Сторож показа: если кадр не закончился за это время (×замедление), экран и сцена возвращаются
const WATCHDOG_MS = 20 * 1000;

// Журнал решений в консоли (F12): почему кадр показан или пропущен
const trace = message => console.info(`${MODULE_ID} | импакт: ${message}`);
// Наезд камеры к точке удара: в стартовом кадре слабый, в кадрах удара — сильный, фигура крупнее
const ZOOM = { start: 1.1, first: 1.35, second: 1.3 };
// Ширина снимка для обработки: 1280 — резкость на весь экран при задержке ~0,1 с сверх 800;
// полная ширина экрана удваивает задержку
const SHOT_WIDTH = 1280;
// Секторы штрихов по кругу: в каждом секторе не больше одного штриха
const BINS = 720;

export function registerImpactSettings() {
    game.settings.register(MODULE_ID, 'impactFrames', {
        name: 'Импакт-кадры навыков',
        hint: 'Стоп-кадр во весь экран, когда ультимейт решает исход: цель погибла или потеряла половину ПЗ.',
        scope: 'client',
        config: true,
        type: Boolean,
        default: true
    });
    game.settings.register(MODULE_ID, 'impactCalm', {
        name: 'Импакт-кадры без вспышек',
        hint: 'Без белой вспышки и инверсии кадра. Снимите галочку, чтобы видеть полный эффект.',
        scope: 'client',
        config: true,
        type: Boolean,
        default: true
    });
    game.settings.register(MODULE_ID, 'impactSlow', {
        name: 'Импакт-кадры: замедление',
        hint: 'Во сколько раз медленнее показывать кадры — чтобы рассмотреть их. 1 — обычная скорость.',
        scope: 'client',
        config: true,
        type: Number,
        range: { min: 1, max: 30, step: 1 },
        default: 1
    });
    game.settings.register(MODULE_ID, 'impactSoundFolder', {
        name: 'Папка звуков импакт-кадров',
        hint: 'Своя озвучка удара Сайтамы: файлы approach, inhale, lunge, contact, punch, punchFinal, fly, land, ok (.ogg). Пусто — звуки синтезируются в браузере.',
        scope: 'world',
        config: true,
        type: String,
        filePicker: 'folder',
        default: ''
    });
    game.settings.register(MODULE_ID, 'impactSound', {
        name: 'Звук импакт-кадра',
        hint: 'Путь к звуковому файлу, например modules/gachadnd/assets/sounds/explosion.ogg. Пусто — взрыв синтезируется в браузере.',
        scope: 'world',
        config: true,
        type: String,
        default: ''
    });
}

// ==========================================
// ВЗВОД И РЕЗУЛЬТАТ
// ==========================================

// Взведённые ультимейты: { actorId, art, until }. Взвод рассылается всем — урон обычно применяет Мастер
const armed = new Map();

// Навык использован: кадр ещё не показывается — он ждёт решающего урона
Hooks.on('dnd5e.postUseActivity', (activity, usageConfig, results) => {
    const item = activity?.item;
    const impact = item?.flags?.[MODULE_ID]?.impact;
    if (!impact || !item.actor) return;
    const data = {
        actorId: item.actor.id, art: impact.art || item.img, style: impact.style ?? null,
        tokenId: item.actor.getActiveTokens?.()[0]?.id ?? null,
        // Шаблон области dnd5e ставит до этого хука: линия разреза — по нему. Каждый поставленный
        // шаблон приходит списком созданных документов, поэтому список плоский
        line: templateLine([results?.templates ?? []].flat(2)[0])
    };
    emit('impactArm', data);
    arm(data);
});
onSocket('impactArm', message => arm(message));

function arm({ actorId, art, style = null, tokenId, line = null }) {
    armed.set(actorId, { art, style, tokenId, line, until: Date.now() + ARM_MS });
    // Рисунки кулаков — пока бросают урон, а не в момент удара
    if (style === 'fists') setTimeout(() => { prepareFists().catch(error => console.warn(`${MODULE_ID} | рисунки кулаков`, error)); }, 50);
    trace(`взведён ${game.actors.get(actorId)?.name ?? actorId}${style ? ` (${style})` : ''}, ждёт урона ${ARM_MS / 60000} мин${tokenId ? '' : '; токена на сцене нет'}`);
}

// Шаблон-линия → отрезок в координатах сцены: от начала шаблона по его направлению на его длину
function templateLine(template) {
    const dims = canvas?.dimensions;
    if (!template || !dims?.distance || !Number.isFinite(template.distance)) return null;
    const length = template.distance * dims.size / dims.distance;
    const angle = (template.direction ?? 0) * Math.PI / 180;
    return { from: { x: template.x, y: template.y }, to: { x: template.x + Math.cos(angle) * length, y: template.y + Math.sin(angle) * length } };
}

// Без шаблона (его не поставили) — линия от нанёсшего удар через цель
function tokenLine(fromId, toPoint) {
    const from = canvas?.tokens?.get(fromId)?.center;
    if (!from || !toPoint) return null;
    const dx = toPoint.x - from.x, dy = toPoint.y - from.y, len = Math.hypot(dx, dy);
    if (len < 1) return null;
    const reach = Math.max(len, (canvas.dimensions?.size ?? 100) * 60);
    return { from: { x: from.x, y: from.y }, to: { x: from.x + dx / len * reach, y: from.y + dy / len * reach } };
}

// Чей это урон: источник dnd5e не сообщает. Берётся взведённый персонаж, чей сейчас ход;
// вне боя — любой взведённый (взводы живут недолго)
// В бою — взведённый персонаж, чей ход; если ход не его, но взведён ровно один — он
// (урон часто применяют уже после передачи хода)
function armedSource() {
    const now = Date.now();
    for (const [id, a] of armed) if (a.until < now) { armed.delete(id); trace(`взвод ${game.actors.get(id)?.name ?? id} истёк`); }
    if (!armed.size) return null;
    const turn = game.combat?.started ? game.combat.combatant?.actor?.id : null;
    if (turn && armed.has(turn)) return [turn, armed.get(turn)];
    if (!turn || armed.size === 1) return armed.entries().next().value;
    trace('взведено несколько персонажей, ход ни одного из них — неясно, чей урон');
    return null;
}

const tokenPoint = actor => {
    const token = actor?.getActiveTokens?.()[0];
    return token?.center ? { x: token.center.x, y: token.center.y } : null;
};
const tokenId = actor => actor?.getActiveTokens?.()[0]?.id ?? null;

// Решающий урон: цель погибла или потеряла не меньше половины максимума ПЗ. Хук — у применившего урон
Hooks.on('dnd5e.applyDamage', (actor, amount) => {
    if (!(amount > 0)) return;
    const source = armedSource();
    if (!source) return;
    const { art, style, tokenId: casterId, line } = source[1];
    const hp = actor.system.attributes?.hp;
    // Кулаки — сам удар Сайтамы: кадр после любого урона; остальные — только после решающего
    if (style !== 'fists' && (!hp || (hp.value > 0 && amount < (hp.max ?? Infinity) / 2))) return trace(`урон ${amount} по ${actor.name} не решающий — кадр ждёт дальше`);
    trace(`урон ${amount} по ${actor.name} — кадр`);
    armed.delete(source[0]);
    const point = tokenPoint(actor);
    const data = {
        art, style, sceneId: canvas?.scene?.id ?? null, point, disarm: source[0], tokens: [casterId, tokenId(actor)].filter(Boolean),
        line: style === 'slash' ? line ?? tokenLine(casterId, point) : null,
        knock: style === 'fists' ? knockback(casterId, tokenId(actor), KNOCK_FEET) : null
    };
    if (style === 'fists' && !casterId) trace('у нанёсшего удар не было токена на сцене при использовании навыка');
    emit('impactFrame', data);
    playImpact(data);
});

// Рухнул слой памяти Пожирателя (Мастер отметил заряд особенности «Слои памяти»)
Hooks.on('updateItem', (item, changes) => {
    const actor = item.parent;
    if (actor?.flags?.[MODULE_ID]?.creature !== 'devourer' || item.name !== 'Слои памяти') return;
    // Только трата заряда: сброс слоёв перед новой встречей кадра не даёт
    if (!(Number(foundry.utils.getProperty(changes, 'system.uses.spent')) > 0) || !game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    const data = { art: actor.img, sceneId: canvas?.scene?.id ?? null, point: tokenPoint(actor), tokens: [tokenId(actor)].filter(Boolean) };
    emit('impactFrame', data);
    playImpact(data);
});

onSocket('impactFrame', message => {
    if (message.disarm) armed.delete(message.disarm);
    playImpact(message);
});

// ==========================================
// КАДРЫ УДАРА
// ==========================================

const cache = new Map();

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

function seeded(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Штрихи по секторам: в секторе — мазок от точки удара наружу, [от, до] по доле радиуса,
// своей толщины и смещения; мазок сужается к обоим концам, как след кисти
function streaks(seed, density, minLength, maxWidth, start = 0) {
    const rnd = seeded(seed);
    const from = new Float32Array(BINS), to = new Float32Array(BINS);
    const width = new Float32Array(BINS), offset = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
        if (rnd() > density) { from[b] = 2; to[b] = 0; continue; }
        from[b] = start + rnd() * (0.7 - start * 0.5);
        to[b] = from[b] + minLength + rnd() * 0.8;
        width[b] = maxWidth * (0.3 + rnd() * 0.7);
        offset[b] = 0.25 + rnd() * 0.5;
    }
    return { from, to, width, offset };
}
// Попадает ли точка (сектор b, доля сектора frac, радиус r) в мазок
function inStroke(set, b, frac, r) {
    if (r < set.from[b] || r > set.to[b]) return false;
    const k = (r - set.from[b]) / (set.to[b] - set.from[b]);
    return Math.abs(frac - set.offset[b]) < set.width[b] * Math.sin(Math.PI * k) ** 0.6;
}

/**
 * Два кадра удара из изображения.
 * @param {CanvasImageSource & {width: number, height: number}} img
 * @param {number} fx, fy  Точка удара — доли ширины и высоты.
 * @returns {{first: HTMLCanvasElement, second: HTMLCanvasElement}}
 */
function impactPair(img, fx, fy, figures = null) {
    const w = Math.min(SHOT_WIDTH, img.width), h = Math.round(w * img.height / img.width);
    // Фигуры: непрозрачное на холсте силуэтов; кайма — фон в пределах 2 пикселей от фигуры
    const figure = new Uint8Array(w * h);
    if (figures) {
        const fd = figures.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
        for (let p = 0; p < figure.length; p++) figure[p] = fd[p * 4 + 3] > 60 ? 1 : 0;
    }
    const RIM = 2;
    const rim = new Uint8Array(w * h);
    if (figures) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (figure[y * w + x]) continue;
        search: for (let dy = -RIM; dy <= RIM; dy++) for (let dx = -RIM; dx <= RIM; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < h && xx >= 0 && xx < w && figure[yy * w + xx]) { rim[y * w + x] = 1; break search; }
        }
    }
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    const sx = src.getContext('2d', { willReadFrequently: true });
    sx.drawImage(img, 0, 0, w, h);
    const d = sx.getImageData(0, 0, w, h).data;

    // Яркость и порог Оцу: светлое отделяется от тёмного на любой карте
    const lum = new Uint8Array(w * h), hist = new Float64Array(256);
    for (let p = 0, i = 0; p < lum.length; p++, i += 4) hist[lum[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let best = 0, threshold = 128, wB = 0, sumB = 0;
    for (let v = 0; v < 256; v++) {
        wB += hist[v]; if (!wB) continue;
        const wF = lum.length - wB; if (!wF) break;
        sumB += v * hist[v];
        const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
        if (between > best) { best = between; threshold = v; }
    }
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < mask.length; p++) mask[p] = lum[p] > threshold ? 1 : 0;

    // Детали внутри фигуры: самые светлые 25 % её пикселей (блики, лицо, оружие) — светлые,
    // остальное — сплошной силуэт. Так круглый токен читается как существо, а не как диск
    const figHist = new Uint32Array(256);
    let figCount = 0;
    for (let p = 0; p < figure.length; p++) if (figure[p]) { figHist[lum[p]]++; figCount++; }
    let figThreshold = 255;
    for (let v = 255, seen = 0; v >= 0 && figCount; v--) {
        seen += figHist[v];
        if (seen >= figCount * 0.25) { figThreshold = v; break; }
    }

    // Рваные границы: случайный сдвиг порога по секторам, к точке удара он сходит на нет
    const rnd = seeded(97);
    const jag = Float32Array.from({ length: BINS }, () => rnd() - 0.5);
    const white1 = streaks(11, 0.45, 0.15, 0.22);  // белые штрихи в чёрном первого кадра
    const black1 = streaks(23, 0.14, 0.12, 0.35, 0.45);  // редкие чёрные мазки у краёв белого первого кадра
    const white2 = streaks(37, 0.3, 0.1, 0.16);    // проблески во втором кадре

    const out1 = sx.createImageData(w, h), out2 = sx.createImageData(w, h);
    const o1 = out1.data, o2 = out2.data;
    const cx = fx * w, cy = fy * h;
    const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const SAMPLES = 12, SMEAR = 0.24;
    for (let y = 0, p = 0; y < h; y++) {
        for (let x = 0; x < w; x++, p++) {
            const dx = x - cx, dy = y - cy;
            const r = Math.hypot(dx, dy) / maxR;
            const a = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI) * BINS;
            const b = Math.min(BINS - 1, a | 0), frac = a - b;
            // Размазывание к точке удара: среднее маски вдоль луча
            let acc = 0;
            for (let k = 0; k < SAMPLES; k++) {
                const f = 1 - SMEAR * k / SAMPLES;
                acc += mask[((cy + dy * f) | 0) * w + ((cx + dx * f) | 0)];
            }
            const light = acc / SAMPLES + jag[b] * Math.min(1, r * 3) * 0.7 > 0.5;
            const grain = Math.random() < 0.02;
            // Кадр 1: светлое — чёрное с белыми штрихами, тёмное — белое с чёрными штрихами
            let v1 = light ? (inStroke(white1, b, frac, r) || grain ? 255 : 0) : (inStroke(black1, b, frac, r) ? 0 : 255);
            // Кадр 2: светлое — белое, тёмное — чёрное с проблесками
            let v2 = light ? 255 : (inStroke(white2, b, frac, r) || grain ? 255 : 0);
            // Фигура поверх фона: в первом кадре чёрная с белой каймой, во втором — наоборот
            if (figure[p]) { const detail = lum[p] >= figThreshold; v1 = detail ? 255 : 0; v2 = detail ? 0 : 255; }
            else if (rim[p]) { v1 = 255; v2 = 0; }
            const i = p * 4;
            o1[i] = o1[i + 1] = o1[i + 2] = v1; o1[i + 3] = 255;
            o2[i] = o2[i + 1] = o2[i + 2] = v2; o2[i + 3] = 255;
        }
    }
    const toCanvas = image => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').putImageData(image, 0, 0);
        return c;
    };
    return { first: toCanvas(out1), second: toCanvas(out2) };
}

async function artPair(src) {
    if (!cache.has(src)) cache.set(src, loadImage(src).then(img => impactPair(img, 0.5, 0.5)));
    return cache.get(src);
}

// ==========================================
// КАДРЫ УДАРА ИЗ ПОРТРЕТА
// ==========================================

/**
 * Два кадра удара в разрешении экрана: портрет цели крупным планом, переведённый в тушь, и линии
 * фокуса вокруг — как рисованный импакт-кадр, а не общий план карты. Линии — векторы, поэтому резкие
 * на любом экране; портрет обрабатывается в том размере, в котором показывается.
 * Прозрачный портрет вырезается по своим очертаниям, непрозрачный — рваным овалом.
 * @returns {Promise<{first: HTMLCanvasElement, second: HTMLCanvasElement}>}
 */
async function portraitFrames(src, W, H) {
    const img = await loadImage(src);
    if (!img.width || !img.height) throw new Error('пустой портрет');
    // Фигура — 82 % высоты экрана, не шире 60 % ширины
    let fh = Math.round(H * 0.82), fw = Math.round(fh * img.width / img.height);
    if (fw > W * 0.6) { fw = Math.round(W * 0.6); fh = Math.round(fw * img.height / img.width); }
    const pc = document.createElement('canvas'); pc.width = fw; pc.height = fh;
    const px = pc.getContext('2d', { willReadFrequently: true });
    px.drawImage(img, 0, 0, fw, fh);
    const d = px.getImageData(0, 0, fw, fh).data;

    // Маска фигуры: по прозрачности, а у непрозрачной картинки — рваный овал
    const n = fw * fh, mask = new Uint8Array(n);
    let clear = 0;
    for (let p = 0; p < n; p++) if (d[p * 4 + 3] < 128) clear++;
    const rnd = seeded(331);
    for (let y = 0, p = 0; y < fh; y++) for (let x = 0; x < fw; x++, p++) {
        if (clear > n * 0.08) { mask[p] = d[p * 4 + 3] > 60 ? 1 : 0; continue; }
        const dx = (x - fw / 2) / (fw / 2), dy = (y - fh / 2) / (fh / 2);
        // Край как мазок кисти: сумма волн разной частоты, без ступенек
        const a = Math.atan2(dy, dx);
        const k = 0.93 + 0.035 * Math.sin(5 * a + 1.3) + 0.025 * Math.sin(11 * a + 0.4) + 0.012 * Math.sin(29 * a + 2.1);
        mask[p] = dx * dx + dy * dy < k * k ? 1 : 0;
    }

    // Тушь: порог Оцу по яркости внутри фигуры
    const lum = new Uint8Array(n), hist = new Float64Array(256);
    let count = 0;
    for (let p = 0; p < n; p++) {
        const i = p * 4;
        lum[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
        if (mask[p]) { hist[lum[p]]++; count++; }
    }
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let best = 0, threshold = 128, wB = 0, sumB = 0;
    for (let v = 0; v < 256; v++) {
        wB += hist[v]; if (!wB) continue;
        const wF = count - wB; if (!wF) break;
        sumB += v * hist[v];
        const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
        if (between > best) { best = between; threshold = v; }
    }

    // Кайма вокруг фигуры — 3 пикселя: отделяет силуэт от фона любого цвета
    const RIM = 3, rim = new Uint8Array(n);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
        const p = y * fw + x;
        if (mask[p]) continue;
        search: for (let dy = -RIM; dy <= RIM; dy++) for (let dx = -RIM; dx <= RIM; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < fh && xx >= 0 && xx < fw && mask[yy * fw + xx]) { rim[p] = 1; break search; }
        }
    }
    const figure = invert => {
        const out = px.createImageData(fw, fh), o = out.data;
        for (let p = 0; p < n; p++) {
            if (!mask[p] && !rim[p]) continue;
            const ink = rim[p] ? 0 : lum[p] > threshold ? 255 : 0;
            const v = invert ? 255 - ink : ink;
            o[p * 4] = o[p * 4 + 1] = o[p * 4 + 2] = v; o[p * 4 + 3] = 255;
        }
        const c = document.createElement('canvas'); c.width = fw; c.height = fh;
        c.getContext('2d').putImageData(out, 0, 0);
        return c;
    };

    // Линии фокуса: клинья от края фигуры за пределы экрана, широкие у края экрана
    const cx = W / 2, cy = H / 2, far = Math.hypot(W, H);
    const r0 = Math.min(fw, fh) * 0.42;
    const lines = Array.from({ length: 150 }, () => ({
        a: rnd() * Math.PI * 2, w: 0.004 + rnd() ** 2 * 0.03, start: r0 * (1 + rnd() * 0.9)
    }));
    const frame = invert => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d');
        x.fillStyle = invert ? '#000' : '#fff';
        x.fillRect(0, 0, W, H);
        x.fillStyle = invert ? '#fff' : '#000';
        for (const l of lines) {
            x.beginPath();
            x.moveTo(cx + Math.cos(l.a) * l.start, cy + Math.sin(l.a) * l.start);
            x.lineTo(cx + Math.cos(l.a - l.w) * far, cy + Math.sin(l.a - l.w) * far);
            x.lineTo(cx + Math.cos(l.a + l.w) * far, cy + Math.sin(l.a + l.w) * far);
            x.closePath();
            x.fill();
        }
        x.drawImage(figure(invert), Math.round(cx - fw / 2), Math.round(cy - fh / 2));
        return c;
    };
    return { first: frame(false), second: frame(true), portrait: true };
}

// Портрет фигуры удара: цель (последний токен), иначе первый; картинка актёра, иначе токена
function portraitSource(tokenIds) {
    for (const id of [...(tokenIds ?? [])].reverse()) {
        const token = canvas?.tokens?.get(id);
        const src = token?.actor?.img && !/mystery-man/.test(token.actor.img) ? token.actor.img : token?.document?.texture?.src;
        if (src) return src;
    }
    return null;
}

/**
 * Снимок сцены, как её видит этот игрок. Холст WebGL не хранит кадр после показа,
 * поэтому сцена перерисовывается и копируется в той же задаче, до вывода на экран.
 * @returns {HTMLCanvasElement|null}  null — сцены нет, она другая или снимок пуст.
 */
function captureScene(sceneId) {
    const app = canvas?.app;
    const view = app?.view ?? app?.canvas;
    if (!canvas?.ready || !view || (sceneId && canvas.scene?.id !== sceneId)) return null;
    // Значки состояний (череп поверженного, кровотечение) — не часть удара: на время снимка скрыты
    const marks = (canvas.tokens?.placeables ?? []).map(t => t.effects).filter(e => e?.visible);
    try {
        marks.forEach(e => e.visible = false);
        app.renderer.render(app.stage);
        // Снимок сразу уменьшается: дальнейшая обработка идёт по малому холсту
        const shot = document.createElement('canvas');
        shot.width = Math.min(SHOT_WIDTH, view.width);
        shot.height = Math.round(shot.width * view.height / view.width);
        const x = shot.getContext('2d', { willReadFrequently: true });
        x.drawImage(view, 0, 0, shot.width, shot.height);
        // Пустой буфер: проверка по сетке точек
        const probe = x.getImageData(0, 0, shot.width, shot.height).data;
        const step = Math.max(4, Math.floor(probe.length / 4 / 400)) * 4;
        let filled = 0;
        for (let i = 3; i < probe.length; i += step) if (probe[i] > 0) filled++;
        return filled > 20 ? shot : null;
    } catch (error) {
        console.warn(`${MODULE_ID} | снимок сцены для импакт-кадра`, error);
        return null;
    } finally {
        marks.forEach(e => e.visible = true);
    }
}

/**
 * Силуэты токенов на холсте размера снимка: картинка токена по его месту на экране, с поворотом.
 * Прозрачное в картинке — не фигура: силуэт повторяет очертания существа, а не квадрат токена.
 */
async function figureLayer(tokenIds, shot) {
    const view = canvas?.app?.view ?? canvas?.app?.canvas;
    const tokens = (tokenIds ?? []).map(id => canvas?.tokens?.get(id)).filter(t => t?.document?.texture?.src && t.visible !== false);
    if (!tokens.length || !view) return null;
    const layer = document.createElement('canvas');
    layer.width = shot.width; layer.height = shot.height;
    const ctx = layer.getContext('2d');
    const rect = view.getBoundingClientRect();
    const k = shot.width / rect.width;
    for (const token of tokens) {
        try {
            const img = await loadImage(token.document.texture.src);
            const doc = token.document;
            const w = doc.width * canvas.grid.size * Math.abs(doc.texture.scaleX ?? 1);
            const h = doc.height * canvas.grid.size * Math.abs(doc.texture.scaleY ?? 1);
            const c = canvas.stage.worldTransform.apply(token.center);
            const scale = canvas.stage.scale.x * k;
            ctx.save();
            ctx.translate(c.x * k, c.y * k);
            ctx.rotate((doc.rotation ?? 0) * Math.PI / 180);
            ctx.drawImage(img, -w * scale / 2, -h * scale / 2, w * scale, h * scale);
            ctx.restore();
        } catch (error) {
            console.warn(`${MODULE_ID} | силуэт токена для импакт-кадра`, error);
        }
    }
    return layer;
}

// Точка сцены → доля экрана; за краем экрана — прижата к нему, чтобы удар оставался в кадре
function screenFocus(point) {
    const view = canvas?.app?.view ?? canvas?.app?.canvas;
    if (!point || !view) return { fx: 0.5, fy: 0.48 };
    const p = canvas.stage.worldTransform.apply({ x: point.x, y: point.y });
    const rect = view.getBoundingClientRect();
    const clamp = v => Math.min(0.85, Math.max(0.15, v));
    return { fx: clamp(p.x / rect.width), fy: clamp(p.y / rect.height) };
}

// ==========================================
// РАЗРЕЗ (style: slash)
// ==========================================

// Часть отрезка S→E внутри экрана: [t0, t1] в долях отрезка, null — отрезок вне экрана
function visibleRange(S, E, W, H) {
    let t0 = 0, t1 = 1;
    const dx = E.x - S.x, dy = E.y - S.y;
    for (const [p, q] of [[-dx, S.x], [dx, W - S.x], [-dy, S.y], [dy, H - S.y]]) {
        if (p === 0) { if (q < 0) return null; continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
        else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return t1 > t0 ? [t0, t1] : null;
}

// Хронометраж и камера разреза: рывок к точке удара, в первом кадре — толчок
const SLASH_ZOOM = { start: 1.06, first: 1.16, second: 1.12 };
// Сдвиг половин сцены по линии разреза, CSS-пиксели при высоте экрана 1000: вдоль линии и поперёк
const SLASH_SPLIT = { first: [60, 14], second: [130, 34] };

/**
 * Фильтр всей сцены: цветокоррекция кадра и разрез. По обе стороны линии сцена берётся со сдвигом
 * вдоль линии в разные стороны и чуть врозь, щель между половинами — цвета фона кадра.
 * Режим 0 — стартовый кадр: цвет с поднятым контрастом; 1 — ч/б, тёмное; 2 — ч/б, инверсия.
 */
const SLASH_SHADER = `
precision highp float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 inputSize;
uniform vec4 outputFrame;
uniform vec4 filterClamp;
uniform vec2 uPoint;
uniform vec2 uDir;
uniform vec2 uSplit;
uniform float uMode;
uniform float uDim;
void main() {
    vec2 screen = vTextureCoord * inputSize.xy + outputFrame.xy;
    vec2 normal = vec2(-uDir.y, uDir.x);
    float side = dot(screen - uPoint, normal) < 0.0 ? -1.0 : 1.0;
    float gap = abs(dot(screen - uPoint, normal)) < uSplit.y ? 1.0 : 0.0;
    vec2 coord = vTextureCoord - (uDir * uSplit.x + normal * uSplit.y) * side * inputSize.zw;
    bool outside = any(lessThan(coord, filterClamp.xy)) || any(greaterThan(coord, filterClamp.zw));
    vec4 color = outside ? vec4(0.0, 0.0, 0.0, 1.0) : texture2D(uSampler, coord);
    vec3 rgb = color.a > 0.0 ? color.rgb / color.a : vec3(0.0);
    if (uMode < 0.5) {
        rgb = clamp((rgb - 0.5) * 1.45 + 0.5, 0.0, 1.0);
        gl_FragColor = vec4(rgb, 1.0);
        return;
    }
    float v = dot(rgb, vec3(0.299, 0.587, 0.114));
    v = clamp((v - 0.5) * 2.4 + 0.45, 0.0, 1.0);
    v = mix(v, 0.0, gap);
    if (uMode > 1.5) v = 1.0 - v;
    gl_FragColor = vec4(vec3(v * uDim), 1.0);
}`;

/**
 * Силуэты токенов поверх сцены, под фильтром кадра: картинка токена тушью — светлое белым,
 * остальное чёрным — на белой обводке. Фильтр второго кадра инвертирует их — как Highlight в Roblox.
 * Силуэт повторяет форму картинки токена: прозрачное в ней — не фигура.
 */
function silhouettes(tokenIds) {
    const layer = new PIXI.Container();
    const outline = 3 / (canvas.stage.scale.x || 1);
    // Тушь: яркость с порогом 0,55 и резким переходом
    const ink = new PIXI.ColorMatrixFilter();
    const K = 10, row = [0.299 * K, 0.587 * K, 0.114 * K, 0, -0.55 * K];
    ink.matrix = [...row, ...row, ...row, 0, 0, 0, 1, 0];
    for (const id of tokenIds ?? []) {
        const token = canvas.tokens?.get(id);
        const mesh = token?.mesh;
        if (!mesh?.texture || token.visible === false) continue;
        const copy = (tint, dx = 0, dy = 0, filter = null) => {
            const sprite = new PIXI.Sprite(mesh.texture);
            sprite.anchor.set(mesh.anchor?.x ?? 0.5, mesh.anchor?.y ?? 0.5);
            sprite.position.set(mesh.position.x + dx, mesh.position.y + dy);
            sprite.scale.set(mesh.scale.x, mesh.scale.y);
            sprite.rotation = mesh.rotation;
            sprite.tint = tint;
            if (filter) sprite.filters = [filter];
            layer.addChild(sprite);
        };
        for (let i = 0; i < 12; i++) copy(0xffffff, Math.cos(i * Math.PI / 6) * outline, Math.sin(i * Math.PI / 6) * outline);
        copy(0xffffff, 0, 0, ink);
    }
    return layer;
}

// Значки состояний, полосы и имена токенов на время кадра скрыты: череп поверженного — не часть удара
function hideTokenMarks() {
    const hidden = [];
    for (const token of canvas.tokens?.placeables ?? []) {
        for (const part of [token.effects, token.bars, token.nameplate, token.tooltip, token.targetArrows, token.border]) {
            if (part?.visible) { part.visible = false; hidden.push(part); }
        }
    }
    return () => hidden.forEach(part => part.visible = true);
}

// Точка сцены → CSS-пиксели холста по текущей камере (сцена — корень, без поворота)
const toView = p => {
    const stage = canvas.stage;
    return { x: stage.position.x + (p.x - stage.pivot.x) * stage.scale.x, y: stage.position.y + (p.y - stage.pivot.y) * stage.scale.y };
};

/**
 * Разрез и полосы — вектор на прозрачном холсте поверх сцены, в пикселях устройства.
 * Разрез — рваная полоса по видимой части шаблона, сужается к его концу; от неё в стороны клинья.
 */
function drawSlash(ctx, line, color) {
    const ratio = devicePixelRatio, W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const toScreen = p => { const q = toView(p); return { x: q.x * ratio, y: q.y * ratio }; };
    const S = toScreen(line.from), E = toScreen(line.to);
    const len = Math.hypot(E.x - S.x, E.y - S.y);
    const range = len >= 1 ? visibleRange(S, E, W, H) : null;
    if (!range) return;
    const [t0, t1] = range;
    const N = { x: -(E.y - S.y) / len, y: (E.x - S.x) / len }, D = { x: -N.y, y: N.x };
    const at = (t, off = 0) => ({ x: S.x + (E.x - S.x) * t + N.x * off, y: S.y + (E.y - S.y) * t + N.y * off });
    const k = Math.min(W, H) / 1000, seen = (t1 - t0) * len;
    const rnd = seeded(11);
    ctx.fillStyle = color;
    for (let i = 0, n = Math.round(25 + 100 * seen / H); i < n; i++) {
        const t = t0 + rnd() * (t1 - t0), side = rnd() < 0.5 ? -1 : 1;
        const length = (35 + rnd() ** 2 * 480) * k, width = (2 + rnd() * 8) * k, lean = (rnd() - 0.3) * 0.5;
        const base = at(t);
        ctx.beginPath();
        ctx.moveTo(base.x + D.x * width, base.y + D.y * width);
        ctx.lineTo(base.x - D.x * width, base.y - D.y * width);
        ctx.lineTo(base.x + (N.x * side + D.x * lean) * length, base.y + (N.y * side + D.y * lean) * length);
        ctx.closePath(); ctx.fill();
    }
    const STEPS = 80, from = t0 === 0 ? -14 * k / len : t0;
    const half = (i, sign) => {
        const t = from + (t1 - from) * i / STEPS;
        return at(t, sign * 12 * k * (1 - Math.max(0, t) * 0.7) * (0.85 + rnd() * 0.3));
    };
    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) { const p = half(i, 1); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
    for (let i = STEPS; i >= 0; i--) { const p = half(i, -1); ctx.lineTo(p.x, p.y); }
    ctx.closePath(); ctx.fill();
}

/**
 * Импакт-кадр разреза в самой сцене, как в Roblox: не снимок, а живая сцена под фильтром —
 * цветокоррекция кадра (ColorCorrection), силуэты токенов (Highlight), камера (наезд и толчок)
 * и разрез поверх. Всё рисуется движком в разрешении экрана.
 * @returns {boolean}  false — сцены нет или она другая: кадр собирается по-старому.
 */
function playEngineSlash({ sceneId, point, tokens, line }) {
    const stage = canvas?.stage, renderer = canvas?.app?.renderer;
    if (!canvas?.ready || !stage || !renderer || !globalThis.PIXI || (sceneId && canvas.scene?.id !== sceneId)) return false;
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const slow = Math.max(1, Number(game.settings.get(MODULE_ID, 'impactSlow')) || 1);

    const filter = new PIXI.Filter(undefined, SLASH_SHADER, { uPoint: [0, 0], uDir: [1, 0], uSplit: [0, 0], uMode: 0, uDim: 1 });
    const saved = { filters: stage.filters, filterArea: stage.filterArea, x: stage.position.x, y: stage.position.y, sx: stage.scale.x, sy: stage.scale.y };
    const showMarks = hideTokenMarks();
    const figures = silhouettes(tokens);
    figures.visible = false;
    stage.addChild(figures);
    stage.filters = [...(saved.filters ?? []), filter];
    stage.filterArea = renderer.screen;

    const cv = document.createElement('canvas');
    cv.className = 'gd-impact';
    cv.width = Math.round(innerWidth * devicePixelRatio); cv.height = Math.round(innerHeight * devicePixelRatio);
    document.body.append(cv);
    const ctx = cv.getContext('2d');
    playSound();

    // Камера: наезд вокруг точки удара — она остаётся на месте экрана
    const view = canvas.app.view ?? canvas.app.canvas;
    const focus = screenFocus(point), rect = view.getBoundingClientRect();
    const fx = rect.width * focus.fx, fy = rect.height * focus.fy;
    const camera = (zoom, dx = 0, dy = 0) => {
        stage.scale.set(saved.sx * zoom, saved.sy * zoom);
        stage.position.set(fx - (fx - saved.x) * zoom + dx, fy - (fy - saved.y) * zoom + dy);
    };
    const k = Math.min(rect.width, rect.height) / 1000;
    const ox = (Math.random() - 0.5) * 24 * k, oy = (Math.random() - 0.5) * 24 * k;
    // Линия в координатах экрана — после камеры: шейдер работает в CSS-пикселях холста
    const aim = split => {
        const S = toView(line.from), E = toView(line.to);
        const len = Math.hypot(E.x - S.x, E.y - S.y) || 1;
        filter.uniforms.uPoint = [S.x, S.y];
        filter.uniforms.uDir = [(E.x - S.x) / len, (E.y - S.y) / len];
        filter.uniforms.uSplit = split ? [split[0] * k, split[1] * k] : [0, 0];
    };

    let phase = null;
    const t0 = performance.now();
    const finish = () => {
        stage.filters = saved.filters ?? null;
        stage.filterArea = saved.filterArea ?? null;
        stage.scale.set(saved.sx, saved.sy);
        stage.position.set(saved.x, saved.y);
        figures.destroy({ children: true });
        showMarks();
        cv.remove();
        playing = false;
    };
    const tick = now => {
        try {
            const t = (now - t0) / slow;
            if (t >= (calm ? T.calm : T.end) || !canvas.ready) return finish();
            const next = t < T.start ? 'start' : (calm || t < T.first) ? 'first' : 'second';
            if (next !== phase) {
                phase = next;
                if (phase === 'start') camera(SLASH_ZOOM.start, -ox / 2, -oy / 2);
                else if (phase === 'first') camera(SLASH_ZOOM.first, ox, oy);
                else camera(SLASH_ZOOM.second, -ox / 3, -oy / 3);
                aim(phase === 'start' ? null : SLASH_SPLIT[phase]);
                filter.uniforms.uMode = phase === 'start' ? 0 : phase === 'first' ? 1 : 2;
                // Без вспышек: первый кадр приглушён, белое становится серым
                filter.uniforms.uDim = calm ? 0.55 : 1;
                figures.visible = phase !== 'start';
                if (phase === 'start') ctx.clearRect(0, 0, cv.width, cv.height);
                else drawSlash(ctx, line, phase === 'first' ? (calm ? '#8c8c8c' : '#fff') : '#000');
            }
            requestAnimationFrame(tick);
        } catch (error) {
            finish();
            console.error(`${MODULE_ID} | импакт-кадр`, error);
        }
    };
    requestAnimationFrame(tick);
    return true;
}

// ==========================================
// ПРОВЕРКА
// ==========================================

/**
 * Показать кадр навыка без использования и урона: выделенный токен — нанёсший удар,
 * цель (клавиша T) — цель. Для макроса: game.gachadnd.impactTest('fists').
 * @param {'fists'|'slash'|null} style
 * @param {object} [options]
 * @param {boolean} [options.move=false]  Отлёт по-настоящему: Мастер переносит цель.
 * @param {boolean} [options.everyone=false]  Показать всем игрокам, а не только себе.
 */
export function impactTest(style = 'fists', { move = false, everyone = false } = {}) {
    const caster = canvas?.tokens?.controlled[0], target = game.user.targets.first();
    if (!caster || !target) return ui.notifications.warn('Выделите токен нанёсшего удар и возьмите цель клавишей T.');
    if (move && !game.user.isGM) return ui.notifications.warn('Переносить цель может только Мастер.');
    const point = { x: target.center.x, y: target.center.y };
    const data = {
        art: caster.actor?.img ?? caster.document.texture.src, style, sceneId: canvas.scene.id, point, tokens: [caster.id, target.id],
        line: style === 'slash' ? tokenLine(caster.id, point) : null,
        knock: style === 'fists' ? knockback(caster.id, target.id, KNOCK_FEET) : null,
        dry: !move
    };
    trace(`проверка ${style ?? 'кадра'}: ${caster.name} → ${target.name}${move ? ', с переносом цели' : ''}`);
    if (everyone) emit('impactFrame', data);
    return playImpact(data);
}

// ==========================================
// ЗВУК
// ==========================================

let audio = null;

// Взрыв без файла: низкий удар с падением тона и шумовой хвост под закрывающимся фильтром
function synthExplosion(volume) {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    const out = audio.createGain();
    out.gain.value = volume;
    out.connect(audio.destination);

    const thump = audio.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(110, t);
    thump.frequency.exponentialRampToValueAtTime(32, t + 0.6);
    const thumpGain = audio.createGain();
    thumpGain.gain.setValueAtTime(1.2, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    thump.connect(thumpGain).connect(out);
    thump.start(t); thump.stop(t + 1);

    const length = Math.round(audio.sampleRate * 2.2);
    const buffer = audio.createBuffer(1, length, audio.sampleRate);
    const ch = buffer.getChannelData(0);
    // Коричневый шум: рокот вместо шипения
    for (let i = 0, last = 0; i < length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        ch[i] = last * 3.5;
    }
    const noise = audio.createBufferSource();
    noise.buffer = buffer;
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + 2);
    const noiseGain = audio.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(1.6, t + 0.02);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
    noise.connect(filter).connect(noiseGain).connect(out);
    noise.start(t);
}

function playSound() {
    if (!game.settings.get(MODULE_ID, 'soundsEnabled')) return;
    const volume = game.settings.get(MODULE_ID, 'soundsVolume');
    const src = game.settings.get(MODULE_ID, 'impactSound');
    if (src) {
        const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
        return helper?.play({ src, volume, autoplay: true, loop: false }, false);
    }
    try { synthExplosion(volume); } catch (error) { console.warn(`${MODULE_ID} | звук импакт-кадра`, error); }
}

// ==========================================
// ПОКАЗ
// ==========================================

let playing = false;

// Убрать всё, что кадр мог оставить, если он оборвался: холсты, кинополосы, скрытые токены
function cleanupImpact() {
    document.querySelectorAll('.gd-impact, .gd-letterbox').forEach(el => el.remove());
    for (const token of canvas?.tokens?.placeables ?? []) {
        if (token.mesh?.gdAlpha !== undefined) { token.mesh.alpha = token.mesh.gdAlpha; delete token.mesh.gdAlpha; }
    }
}

let playId = 0;

export async function playImpact({ art, style = null, sceneId, point, tokens, line = null, knock = null, dry = false }) {
    // Отлёт — правило навыка, а не украшение: Мастер переносит цель, даже если кадры у него выключены
    if (style === 'fists' && knock && (playing || !game.settings.get(MODULE_ID, 'impactFrames'))) {
        trace(playing ? 'предыдущий кадр ещё идёт — только перенос цели' : 'импакт-кадры выключены в настройках — только перенос цели');
        return dry ? null : moveKnocked(sceneId, knock);
    }
    if (playing) return trace('предыдущий кадр ещё идёт — этот пропущен');
    if (!game.settings.get(MODULE_ID, 'impactFrames')) return trace('импакт-кадры выключены в настройках клиента');
    playing = true;
    // Сторож: кадр, который по какой-то причине не закончился, не должен заблокировать следующие
    const id = ++playId;
    const slowFactor = Math.max(1, Number(game.settings.get(MODULE_ID, 'impactSlow')) || 1);
    setTimeout(() => {
        if (!playing || id !== playId) return;
        trace('кадр не закончился вовремя — экран возвращён');
        cleanupImpact();
        playing = false;
    }, WATCHDOG_MS * slowFactor);
    if (style === 'fists') {
        const calm = game.settings.get(MODULE_ID, 'impactCalm');
        const slow = Math.max(1, Number(game.settings.get(MODULE_ID, 'impactSlow')) || 1);
        // Звуки моментов: синтез или файлы из папки звуков (impact-sound.js)
        const onCue = (name, options = {}) => {
            if (!game.settings.get(MODULE_ID, 'soundsEnabled')) return;
            playCue(name, { volume: game.settings.get(MODULE_ID, 'soundsVolume'), folder: game.settings.get(MODULE_ID, 'impactSoundFolder'), ...options });
        };
        const onHit = (final, index) => onCue(final ? 'punchFinal' : 'punch', { index });
        try {
            const fists = (quick = false) => playFists({ calm, slow, onHit, quick });
            if (!knock) { trace('отлёта нет: не вычислена точка (см. выше) — только кулаки'); await fists(); }
            else if (!canvas?.ready || canvas.scene?.id !== sceneId) { trace('у вас открыта другая сцена — только кулаки'); await fists(); }
            else if (!(await playSaitama({
                casterId: knock.casterId ?? tokens?.[0], targetId: knock.tokenId, knock, calm, slow,
                hideMarks: hideTokenMarks, between: () => fists(true), onCue
            }))) {
                trace('токен цели не найден на сцене — только кулаки');
                await fists();
            }
        } catch (error) {
            console.error(`${MODULE_ID} | импакт-кадр`, error);
            cleanupImpact();
        }
        if (id === playId) playing = false;
        if (knock) dry ? setTimeout(cleanupImpact, 100) : moveKnocked(sceneId, knock);
        return;
    }
    // Разрез — в самой сцене; без сцены кадр собирается по-старому
    if (style === 'slash' && line) {
        try {
            if (playEngineSlash({ sceneId, point, tokens, line })) return;
        } catch (error) {
            console.warn(`${MODULE_ID} | разрез в сцене`, error);
        }
    }
    let pair, focus = { fx: 0.5, fy: 0.5 };
    const shot = captureScene(sceneId);
    console.info(`${MODULE_ID} | импакт-кадр: ${shot ? `снимок сцены ${shot.width}×${shot.height}` : 'арт навыка'}`);
    if (shot) focus = screenFocus(point);
    const portrait = portraitSource(tokens);
    try {
        // Кадры удара — крупный план портрета; без него — из снимка сцены, без сцены — из арта навыка
        if (portrait) pair = await portraitFrames(portrait, innerWidth, innerHeight).catch(() => null);
        if (!pair && shot) pair = impactPair(shot, focus.fx, focus.fy, await figureLayer(tokens, shot));
        if (!pair) pair = await artPair(art);
    } catch (error) {
        playing = false;
        return console.warn(`${MODULE_ID} | импакт-кадр не собран`, error);
    }
    const calm = game.settings.get(MODULE_ID, 'impactCalm');
    const cv = document.createElement('canvas');
    cv.className = 'gd-impact';
    cv.width = innerWidth; cv.height = innerHeight;
    document.body.append(cv);
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, cx = W * focus.fx, cy = H * focus.fy;
    playSound();

    // Кадр во весь экран; масштаб — вокруг точки удара, она остаётся на месте.
    // Кадры из портрета уже в разрешении экрана и построены вокруг его центра
    const cover = (src, zoom, ox, oy, centred = false) => {
        const fx = centred ? W / 2 : cx, fy = centred ? H / 2 : cy;
        const base = Math.max(W / src.width, H / src.height);
        const bx = (W - src.width * base) / 2, by = (H - src.height * base) / 2;
        ctx.drawImage(src, fx - (fx - bx) * zoom + ox, fy - (fy - by) * zoom + oy, src.width * base * zoom, src.height * base * zoom);
    };
    const zoomOf = z => pair.portrait ? 1 + (z - 1) * 0.3 : z;

    // Стартовый кадр — живая сцена, застывшая с рывком к точке удара и поднятым контрастом;
    // первый кадр удара сдвинут и чуть крупнее, второй встаёт на место
    const ox = (Math.random() - 0.5) * 24, oy = (Math.random() - 0.5) * 24;
    const t0 = performance.now();
    const slow = Math.max(1, Number(game.settings.get(MODULE_ID, 'impactSlow')) || 1);
    const finish = () => { cv.remove(); playing = false; };
    const tick = now => {
        try {
            const t = (now - t0) / slow;
            if (t >= (calm ? T.calm : T.end)) return finish();
            // Чёрно-белые кадры растягиваются без сглаживания: края остаются резкими, а не мутными
            ctx.imageSmoothingEnabled = !!(shot && t < T.start) || !!pair.portrait;
            if (shot && t < T.start) {
                ctx.filter = 'contrast(1.45) saturate(1.3)';
                cover(shot, ZOOM.start, -ox / 2, -oy / 2);
                ctx.filter = 'none';
            } else if (calm || t < T.first) {
                // Без вспышек: первый кадр приглушён — белое становится серым
                if (calm) ctx.filter = 'brightness(0.55)';
                cover(pair.first, zoomOf(ZOOM.first), ox, oy, pair.portrait);
                ctx.filter = 'none';
            } else cover(pair.second, zoomOf(ZOOM.second), 0, 0, pair.portrait);
            requestAnimationFrame(tick);
        } catch (error) {
            finish();
            console.error(`${MODULE_ID} | импакт-кадр`, error);
        }
    };
    requestAnimationFrame(tick);
}
