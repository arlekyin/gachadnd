/**
 * Gacha Roguelike dnd5e — Удар Сайтамы в сцене
 *
 * Порядок кадра:
 *  1. Камера подъезжает к Сайтаме и цели, сцена уходит в ч/б, выезжают кинополосы.
 *  2. Вдох: воздух втягивается в Сайтаму, он замахивается назад, цель дрожит; камера медленно
 *     поворачивает по часовой и чуть отъезжает.
 *  3. Рывок: камера резко уходит против часовой и наезжает на цель, Сайтама бросается к ней.
 *  4. Касание — мелькающие кадры: разлёт линий за целью на чёрном, столб света, молнии в тёмном
 *     конусе, молнии вокруг.
 *  5. Кулаки (impact-fists.js) — камера на это время замирает.
 *  6. Сразу после пятого кулака цель летит по прямой от Сайтамы: вытянута, кувыркается, за ней
 *     следы, линии скорости и пыль по земле; камера провожает её, сцена возвращает цвет.
 *  7. Приземление: стоп-кадр, ударная волна, пыль, трещины в земле, тряска; камера рывком
 *     на место, кинополосы уходят. Сайтама скучающе говорит «Ок.».
 * Сцену и токены рисует движок (PIXI): они резкие при любом наезде; свет и молнии — вектор
 * поверх в разрешении экрана. Перенос токена делает клиент Мастера после показа.
 */

import { seeded, lerp, clamp01, easeOut, easeInOut, springTo, wobble } from "../../cutscene/math.js";
import { stageCamera, shaker } from "../../cutscene/camera.js";
import { letterbox } from "../../cutscene/letterbox.js";
import { stageFilter, grayFilter, tokenCopy, rotatedFrame, hideToken, showToken } from "../../cutscene/stage.js";
import { overlay } from "../../cutscene/overlay.js";

// Хронометраж, мс. Медленно — то, что надо рассмотреть, быстро — сами удары.
// approach — подъезд; inhale — вдох (windup — его часть с замахом); lunge — рывок; turn — резкий
// поворот камеры на рывке; light — кадры света и молний: связка, каждый мелькает на 3–4 кадра
// экрана, без своей анимации (star — звезда взрыва с лучами, blot — чёрная клякса на белом,
// white — белый кадр, beam — столб света, cone — молнии в тёмном конусе, остальное — молнии
// во все стороны);
// lines — разлёт линий за целью: первый мелькающий кадр касания, появляется сразу целиком;
// burst — тряска; squash — качание токенов от удара; ghosts — следы рывка; fly — полёт цели;
// hitstop — стоп-кадр приземления; wave — ударная волна; settle — сцена после приземления до
// возврата камеры; back — возврат камеры; cracks — трещины в земле гаснут; ok — реплика Сайтамы
const T = {
    approach: 520, inhale: 1000, windup: 650, lunge: 200, turn: 160, light: 270, star: 35, blot: 35, white: 30, beam: 50, cone: 60,
    lines: 70, burst: 250, squash: 450, ghosts: 450, fly: 380, hitstop: 70, wave: 380, settle: 450,
    back: 70, cracks: 1700, ok: 1200
};
// Камера: на вдохе — поворот по часовой и отъезд; на рывке — против часовой и наезд на цель;
// от разлёта её бросает обратно, дальше плывёт. Углы — радианы, масштаб — множитель
const CAM = { inhaleTilt: 0.05, inhaleZoom: 0.92, lungeTilt: -0.07, lungeZoom: 1.14, lungePull: 0.4, blastTilt: -0.015, drift: 0.02 };
// Кинополосы: доля высоты экрана сверху и снизу
const BARS = 0.11;
// Замах Сайтамы назад — доля клетки; дрожь цели — CSS-пиксели
const WINDUP = 1.2, TREMBLE = 1.6;
// Тряска от разлёта и от касания, CSS-пиксели
const SHAKE = 34;
// Наезд: Сайтама и цель занимают такую долю экрана; не больше MAX_ZOOM от текущего
const FILL = 0.75, MAX_ZOOM = 3;
// Вдох: сколько струй воздуха и откуда — в радиусах токена Сайтамы
const AIR = { count: 46, from: 4.5, period: 520 };
// Полёт: вытяжение вдоль полёта, обороты кувырка, число следов
const FLIGHT = { stretch: 0.45, spin: 1.25, trails: 5 };
// Реплика Сайтамы после удара
const OK_LINE = 'Ок.';

/**
 * Куда отлетает цель: по прямой от нанёсшего удар на feet футов, до первой стены.
 * Считается там, где применён урон, и рассылается всем вместе с кадром.
 * @returns {{tokenId, casterId, x, y, reach, from: {x, y}, to: {x, y}}|null}  x, y — новый левый верхний угол токена; reach — полная дальность.
 */
export function knockback(casterId, targetId, feet) {
    const caster = canvas?.tokens?.get(casterId), target = canvas?.tokens?.get(targetId);
    const dims = canvas?.dimensions;
    if (!caster || !target || !dims?.distance) {
        console.info(`gachadnd | импакт: отлёта не будет — ${!caster ? 'нет токена нанёсшего удар на сцене' : !target ? 'нет токена цели на сцене' : 'у сцены нет масштаба'}`);
        return null;
    }
    const a = caster.center, b = target.center;
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return null;
    dx /= len; dy /= len;
    const reach = feet * dims.size / dims.distance;
    let end = { x: b.x + dx * reach, y: b.y + dy * reach };
    // Стена на пути: цель останавливается за полклетки до неё
    try {
        const hit = globalThis.CONFIG?.Canvas?.polygonBackends?.move?.testCollision?.({ x: b.x, y: b.y }, end, { type: 'move', mode: 'closest' });
        if (hit) {
            const d = Math.hypot(hit.x - b.x, hit.y - b.y), k = Math.max(0, d - dims.size / 2) / (d || 1);
            end = { x: b.x + (hit.x - b.x) * k, y: b.y + (hit.y - b.y) * k };
        }
    } catch (error) {
        console.warn('gachadnd | проверка стен при отлёте', error);
    }
    const doc = target.document;
    const w = doc.width * dims.size, h = doc.height * dims.size;
    // Новое место — по сетке, в пределах сцены
    let corner = { x: end.x - w / 2, y: end.y - h / 2 };
    try {
        if (canvas.grid.getSnappedPoint) corner = canvas.grid.getSnappedPoint(corner, { mode: globalThis.CONST?.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
        else if (canvas.grid.getSnappedPosition) corner = canvas.grid.getSnappedPosition(corner.x, corner.y);
    } catch { /* без сетки — как есть */ }
    const rect = dims.sceneRect ?? dims.rect;
    if (rect) {
        corner.x = Math.min(Math.max(corner.x, rect.x), rect.x + rect.width - w);
        corner.y = Math.min(Math.max(corner.y, rect.y), rect.y + rect.height - h);
    }
    return { tokenId: targetId, casterId, x: corner.x, y: corner.y, reach, from: { x: b.x, y: b.y }, to: { x: corner.x + w / 2, y: corner.y + h / 2 } };
}

/**
 * Разлёт за целью: белые линии на чёрном в сторону отлёта (ось x) — как след от взрыва.
 * Линии по всему конусу, у оси немного гуще, разной длины и толщины, часть — пунктиром; каждая сужается к обоим концам,
 * как мазок. Разлёт вдвое длиннее расстояния отлёта.
 * @param {number} radius  Радиус токена: линии начинаются у его края.
 * @param {number} reach   Расстояние отлёта.
 */
function burstGraphic(radius, reach) {
    const g = new PIXI.Graphics();
    const rnd = seeded(13), R = radius, L = Math.max(reach * 2, radius * 8);
    const SPREAD = 0.95;
    const stroke = (a, from, to, w) => {
        const mid = from + (to - from) * (0.25 + rnd() * 0.2);
        g.drawPolygon([
            Math.cos(a) * from, Math.sin(a) * from,
            Math.cos(a - w) * mid, Math.sin(a - w) * mid,
            Math.cos(a) * to, Math.sin(a) * to,
            Math.cos(a + w) * mid, Math.sin(a + w) * mid
        ]);
    };
    g.beginFill(0xffffff);
    for (let i = 0; i < 700; i++) {
        // Почти равномерно по конусу, у оси чуть гуще: сплошного белого быть не должно
        const u = rnd() * 2 - 1, a = Math.sign(u) * Math.abs(u) ** 1.25 * SPREAD;
        const from = R * (0.95 + rnd() * 0.9) + L * rnd() ** 3 * 0.4;
        const to = from + L * (0.25 + rnd() ** 0.6 * 0.95) * (1 - Math.abs(a) / SPREAD * 0.6);
        const w = (0.0015 + rnd() ** 4 * 0.014) * (1 - Math.abs(a) / SPREAD * 0.4);
        if (rnd() < 0.3) {
            // Пунктир: несколько коротких штрихов вдоль одного луча
            const parts = 2 + Math.floor(rnd() * 3), step = (to - from) / parts;
            for (let k = 0; k < parts; k++) stroke(a, from + step * k, from + step * (k + 0.35 + rnd() * 0.35), w * 0.8);
        } else stroke(a, from, to, w);
    }
    g.endFill();
    return g;
}


// ==========================================
// СВЕТ И МОЛНИИ
// ==========================================

// Молния: ломаная из точки удара с ответвлениями; ширина сужается к концу.
// angles — направления стволов; jag — сила изломов
function bolts(seed, unit, angles, { length = 0.8, width = 0.016, jag = 0.9, branch = 0.22 } = {}) {
    const rnd = seeded(seed), out = [];
    const grow = (x, y, angle, len, w, depth) => {
        const points = [[x, y]];
        const base = angle, steps = 10 + Math.floor(rnd() * 6);
        for (let i = 0; i < steps; i++) {
            // Излом вокруг общего направления ствола: молния петляет, но не разворачивается
            angle = base + (rnd() - 0.5) * jag * 1.6;
            const step = len / steps * (0.5 + rnd() * 1);
            x += Math.cos(angle) * step; y += Math.sin(angle) * step;
            points.push([x, y]);
            if (depth < 2 && rnd() < branch) grow(x, y, base + (rnd() < 0.5 ? -1 : 1) * (0.35 + rnd() * 0.5), len * 0.45, w * 0.6, depth + 1);
        }
        out.push({ points, width: w, depth });
    };
    for (const angle of angles) grow(0, 0, angle + (rnd() - 0.5) * 0.15, unit * length * (0.75 + rnd() * 0.4), unit * width * (0.8 + rnd() * 0.5), 0);
    return out;
}

// Молнии одним путём: свечение — широкой полупрозрачной линией, сама молния — белой
function drawBolts(ctx, P, set, glowAlpha, glowWidth) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 3;
    for (const b of set) {
        const path = () => {
            ctx.beginPath();
            ctx.moveTo(P.x + b.points[0][0], P.y + b.points[0][1]);
            for (let i = 1; i < b.points.length; i++) ctx.lineTo(P.x + b.points[i][0], P.y + b.points[i][1]);
        };
        // Свечение — два слоя: широкий бледный и узкий поярче, ореол без резкой границы
        if (glowAlpha) {
            for (const [a, w] of [[glowAlpha * 0.4, glowWidth], [glowAlpha, glowWidth * 0.5]]) {
                ctx.strokeStyle = `rgba(255,255,255,${a})`;
                ctx.lineWidth = b.width * w;
                path(); ctx.stroke();
            }
        }
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = b.width;
        path(); ctx.stroke();
    }
}

/**
 * Кадры света и молний в пикселях экрана, P — точка удара, f — время от касания. Три неподвижных
 * кадра, каждый мелькает:
 *  1. столб света — белый конус сверху на чёрном, горизонтальные блики, вспышка в точке удара;
 *  2. негатив столба — тёмный конус между серыми шершавыми стенками, в нём толстые рваные молнии
 *     вверх, на линии удара — плоский всплеск света, тонкие кресты бликов;
 *  3. молнии во все стороны из точки удара на чёрном, со свечением.
 */
function drawLight(ctx, W, H, P, f, set, calm) {
    const unit = Math.min(W, H), half = Math.max(W, H) * 0.32;
    const cone = () => { ctx.beginPath(); ctx.moveTo(P.x - half, -10); ctx.lineTo(P.x + half, -10); ctx.lineTo(P.x, P.y); ctx.closePath(); };
    const glow = (x, y, r, a) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    const streaks = a => {
        for (const s of set.streaks) {
            const g = ctx.createLinearGradient(0, 0, W, 0);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(0.5, `rgba(255,255,255,${a * s.alpha})`);
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g;
            ctx.fillRect(0, P.y + s.dy * unit - s.h / 2, W, s.h);
        }
    };
    // Кресты бликов: тонкие вертикальные и горизонтальные лучи через яркие точки
    const glints = a => {
        for (const g of set.glints) {
            const x = P.x + g.dx * unit, y = P.y + g.dy * unit, r = g.r * unit;
            for (const [w, h] of [[unit * 0.0025, r], [r * 0.7, unit * 0.0025]]) {
                const grad = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h));
                grad.addColorStop(0, `rgba(255,255,255,${a})`);
                grad.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = grad;
                ctx.fillRect(x - w, y - h, w * 2, h * 2);
            }
        }
    };
    // Промежуточные кадры между разлётом линий и столбом: звезда взрыва, клякса, белый.
    // «Без вспышек» — их нет, сразу молнии в конусе
    const pre = T.star + T.blot + T.white;
    if (f < pre && !calm) {
        if (f < T.star) {
            // Звезда взрыва: тёмно-серый фон, лучи от точки удара во все стороны, белая звезда
            ctx.fillStyle = '#1c1c1c';
            ctx.fillRect(0, 0, W, H);
            const R = Math.hypot(W, H);
            for (const r of set.rays) {
                ctx.strokeStyle = `rgba(255,255,255,${r.alpha})`;
                ctx.lineWidth = r.w * unit;
                ctx.beginPath();
                ctx.moveTo(P.x + Math.cos(r.a) * r.from * unit, P.y + Math.sin(r.a) * r.from * unit);
                ctx.lineTo(P.x + Math.cos(r.a) * R, P.y + Math.sin(r.a) * R);
                ctx.stroke();
            }
            glow(P.x, P.y, unit * 0.35, 0.8);
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            set.star.forEach(([a, r], i) => {
                const x = P.x + Math.cos(a) * r * unit, y = P.y + Math.sin(a) * r * unit * 0.8;
                i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            });
            ctx.closePath();
            ctx.fill();
        } else if (f < T.star + T.blot) {
            // Клякса: чёрный рваный силуэт с шипами на белом
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#000';
            ctx.beginPath();
            set.blot.forEach(([a, r], i) => {
                const x = P.x + Math.cos(a) * r * unit, y = P.y + Math.sin(a) * r * unit;
                i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            });
            ctx.closePath();
            ctx.fill();
        } else {
            // Белый кадр с едва заметными следами
            ctx.fillStyle = '#fbfbfb';
            ctx.fillRect(0, 0, W, H);
        }
        return;
    }
    f -= calm ? 0 : pre;
    if (f < T.beam && !calm) {
        // 1. Столб света
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        cone();
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        for (const v of set.veins) {
            const side = v.side, x0 = P.x + side * half * v.at, y0 = -10 + (P.y + 10) * v.y;
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x0 - side * v.w * unit, y0 + v.len * unit * 0.2);
            ctx.lineTo(x0 - side * v.w * unit * 0.3, y0 + v.len * unit);
            ctx.fill();
        }
        streaks(0.7);
        glow(P.x, P.y, unit * 0.24, 1);
        return;
    }
    if (f < T.beam + T.cone) {
        // 2. Негатив столба: серые шершавые стенки, тёмный конус и низ, молнии в конусе
        const g = ctx.createRadialGradient(P.x, P.y * 0.4, unit * 0.1, P.x, P.y * 0.4, Math.max(W, H) * 0.7);
        g.addColorStop(0, '#9a9a9a');
        g.addColorStop(1, '#3a3a3a');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, P.y);
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = set.grain;
        ctx.fillRect(0, 0, W, P.y);
        ctx.restore();
        ctx.fillStyle = '#050505';
        cone();
        ctx.fill();
        ctx.fillRect(0, P.y, W, H - P.y);
        drawBolts(ctx, P, set.coneBolts, 0.25, 3);
        // Всплеск: плоское колючее пятно света на линии удара и столбик над ним
        ctx.fillStyle = '#fff';
        for (const s of set.splash) {
            const len = s.len * unit * 1.4;
            ctx.beginPath();
            ctx.moveTo(P.x + Math.cos(s.a + 1.57) * s.w * unit, P.y + Math.sin(s.a + 1.57) * s.w * unit * 0.3);
            ctx.lineTo(P.x + Math.cos(s.a) * len, P.y + Math.sin(s.a) * len * 0.18);
            ctx.lineTo(P.x - Math.cos(s.a + 1.57) * s.w * unit, P.y - Math.sin(s.a + 1.57) * s.w * unit * 0.3);
            ctx.fill();
        }
        ctx.beginPath();
        ctx.ellipse(P.x, P.y, unit * 0.2, unit * 0.035, 0, 0, Math.PI * 2);
        ctx.fill();
        glow(P.x, P.y - unit * 0.03, unit * 0.13, 1);
        glints(0.8);
        return;
    }
    // 3. Молнии во все стороны на чёрном, со свечением
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawBolts(ctx, P, set.wideBolts, 0.35, 7);
    glow(P.x, P.y, unit * 0.16, 1);
    glints(0.6);
}

// Узор серых стенок: светлые и тёмные пятна, как шершавая бумага
function grainPattern(ctx) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    const g = tile.getContext('2d');
    const rnd = seeded(91);
    for (let i = 0; i < 2600; i++) {
        const light = rnd() < 0.5;
        g.fillStyle = light ? `rgba(255,255,255,${0.05 + rnd() * 0.12})` : `rgba(0,0,0,${0.05 + rnd() * 0.14})`;
        const r = 1 + rnd() ** 3 * 9;
        g.beginPath();
        g.arc(rnd() * 256, rnd() * 256, r, 0, Math.PI * 2);
        g.fill();
    }
    return ctx.createPattern(tile, 'repeat');
}

function lightSet(ctx, unit) {
    const rnd = seeded(211);
    // В конусе — стволы вверх, в его пределах; на третьем кадре — во все стороны
    const up = Array.from({ length: 5 }, (_, i) => -Math.PI / 2 + (i / 4 - 0.5) * 0.8);
    const around = Array.from({ length: 9 }, (_, i) => i / 9 * Math.PI * 2 + 0.3);
    return {
        coneBolts: bolts(17, unit, up, { length: 1.0, width: 0.022, jag: 0.6, branch: 0.12 }),
        wideBolts: bolts(29, unit, around, { length: 0.75, width: 0.016, jag: 0.9, branch: 0.2 }),
        grain: grainPattern(ctx),
        glints: Array.from({ length: 5 }, () => ({ dx: (rnd() - 0.5) * 0.9, dy: -rnd() * 0.5, r: 0.08 + rnd() * 0.15 })),
        streaks: Array.from({ length: 4 }, () => ({ dy: (rnd() - 0.65) * 0.6, h: unit * (0.003 + rnd() * 0.005), alpha: 0.4 + rnd() * 0.6 })),
        veins: Array.from({ length: 10 }, () => ({ side: rnd() < 0.5 ? -1 : 1, at: 0.6 + rnd() * 0.35, y: rnd() * 0.5, w: 0.01 + rnd() * 0.02, len: 0.1 + rnd() * 0.25 })),
        // Звезда взрыва: длинные горизонтальные концы, короче — вертикальные, рваные бугры между ними
        // Звезда взрыва: ядро и сужающиеся к остриям лучи — длинные в стороны, короче вверх-вниз,
        // мелкие рваные бугры по диагоналям
        star: (() => {
            const arms = [[0, 0.95, 0.42], [Math.PI, 0.9, 0.4], [-Math.PI / 2, 0.5, 0.32], [Math.PI / 2, 0.42, 0.3]];
            for (let i = 0; i < 6; i++) arms.push([Math.PI / 4 + i * Math.PI / 3 + (rnd() - 0.5) * 0.4, 0.2 + rnd() * 0.12, 0.25]);
            return Array.from({ length: 240 }, (_, i) => {
                const a = i / 240 * Math.PI * 2 - Math.PI;
                let r = 0.12 + rnd() * 0.015;
                for (const [axis, length, width] of arms) {
                    const d = Math.abs(Math.atan2(Math.sin(a - axis), Math.cos(a - axis)));
                    if (d < width) r = Math.max(r, length * (1 - d / width) ** 2.2 + 0.12 * (1 - d / width));
                }
                return [a, r];
            });
        })(),
        rays: Array.from({ length: 260 }, () => ({ a: rnd() * Math.PI * 2, from: 0.15 + rnd() * 0.5, w: 0.001 + rnd() ** 3 * 0.004, alpha: 0.35 + rnd() * 0.6 })),
        // Клякса: центр и шипы разной длины; часть уходит за край экрана
        blot: Array.from({ length: 34 }, (_, i) => [i / 34 * Math.PI * 2 + (rnd() - 0.5) * 0.08, i % 2 ? 0.3 + rnd() * 0.15 : 0.55 + rnd() ** 0.7 * 0.7]),
        splash: Array.from({ length: 90 }, () => ({ a: (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * 1.0, len: 0.12 + rnd() ** 2 * 0.3, w: 0.004 + rnd() * 0.006 }))
    };
}

// ==========================================
// ПОКАЗ
// ==========================================

/**
 * @param {object} options
 * @param {string} options.casterId, targetId  Токены.
 * @param {object} options.knock  Из knockback.
 * @param {boolean} options.calm  Без вспышек: без столба света и без инверсии.
 * @param {number} options.slow   Замедление.
 * @param {() => () => void} options.hideMarks  Прячет значки токенов, возвращает восстановление.
 * @param {() => Promise} options.between  Кулаки: камера ждёт, пока они отыграют.
 * @param {(name: string, options?: object) => void} options.onCue  Звук момента (impact-sound.js):
 *        approach, inhale, lunge, contact, fly, land, ok; duration — в секундах.
 * @returns {Promise<boolean>}  false — показать в сцене нельзя.
 */
export function playSaitama({ casterId, targetId, knock, calm = false, slow = 1, hideMarks = () => () => {}, between = async () => {}, onCue = () => {} }) {
    const stage = canvas?.stage, renderer = canvas?.app?.renderer;
    const caster = canvas?.tokens?.get(casterId), target = canvas?.tokens?.get(targetId);
    if (!stage || !renderer || !globalThis.PIXI || !target || !knock) return Promise.resolve(false);

    const cam = stageCamera();
    const { saved } = cam;
    const a = caster?.center ?? knock.from, b = knock.from;
    const size = canvas.dimensions.size;
    const radius = Math.max(target.w ?? 0, target.h ?? 0, size) / 2;
    const casterRadius = caster ? Math.max(caster.w ?? 0, caster.h ?? 0, size) / 2 : 0;
    // Направление удара: от Сайтамы к цели
    const dir = Math.atan2(b.y - a.y, b.x - a.x), ux = Math.cos(dir), uy = Math.sin(dir);
    const home = { x: a.x, y: a.y };
    const windup = { x: a.x - ux * WINDUP * size, y: a.y - uy * WINDUP * size };
    const reachDist = Math.max(0, Math.hypot(b.x - a.x, b.y - a.y) - (casterRadius + radius) * 0.95);
    const contact = { x: a.x + ux * reachDist, y: a.y + uy * reachDist };

    // Крупный план: в кадре Сайтама, его замах и цель; центр — между замахом и целью
    const span = { x: (windup.x + b.x) / 2, y: (windup.y + b.y) / 2 };
    const scale = cam.fit([a, b, windup], span, { fill: FILL, margin: radius * 1.5, maxZoom: MAX_ZOOM });
    const focus = { x: lerp(span.x, b.x, 0.15), y: lerp(span.y, b.y, 0.15) };
    // Камера: k — от обычного вида (0) к крупному плану (1); zoom — множитель крупного плана;
    // pull — сдвиг центра к цели; tilt — поворот; follow — камера провожает цель к месту приземления
    const camera = (k, zoom, pull, tilt, dx = 0, dy = 0, follow = 0) => {
        const pulled = { x: lerp(focus.x, b.x, pull), y: lerp(focus.y, b.y, pull) };
        cam.place({ k, scale: scale * zoom, rot: tilt, dx, dy, center: { x: lerp(pulled.x, knock.to.x, follow), y: lerp(pulled.y, knock.to.y, follow) } });
    };
    const screenOf = cam.screenOf;

    const bars = letterbox(BARS);

    // Слой кадра поверх сцены: затемнение, вдох, разлёт, следы, копии токенов
    const layer = new PIXI.Container();
    const dark = new PIXI.Graphics();
    dark.beginFill(0x000000).drawRect(-1e6, -1e6, 2e6, 2e6).endFill();
    dark.alpha = 0;
    const air = new PIXI.Graphics();
    const burst = burstGraphic(radius, knock.reach ?? Math.hypot(knock.to.x - b.x, knock.to.y - b.y));
    burst.position.set(b.x, b.y);
    burst.rotation = Math.atan2(knock.to.y - b.y, knock.to.x - b.x);
    burst.scale.set(0, 0);
    const casterCopy = caster ? tokenCopy(caster) : null, targetCopy = tokenCopy(target);
    // Рамки, повёрнутые по удару: сжатие и растяжение токенов идут вдоль удара
    const casterWrap = casterCopy ? rotatedFrame(casterCopy, dir) : null;
    const targetWrap = rotatedFrame(targetCopy, dir);
    targetWrap.position.set(b.x, b.y);
    const ghosts = caster ? [0.25, 0.5, 0.75].map(f => {
        const ghost = tokenCopy(caster);
        ghost.position.set(lerp(windup.x, contact.x, f), lerp(windup.y, contact.y, f));
        ghost.alpha = 0;
        return { ghost, base: 0.2 + f * 0.3 };
    }) : [];
    // Полёт и приземление: пыль по земле, трещины, ударная волна, линии скорости, следы цели
    const ground = new PIXI.Graphics(), trail = new PIXI.Graphics();
    const flightGhosts = Array.from({ length: FLIGHT.trails }, (_, i) => {
        const ghost = tokenCopy(target);
        if (!ghost) return null;
        ghost.filters = null;
        ghost.alpha = 0;
        return { ghost, lag: 0.07 * (i + 1), base: 0.45 * (1 - i / FLIGHT.trails) };
    }).filter(Boolean);
    const baseSpin = targetCopy?.rotation ?? 0;
    const travel = { x: knock.to.x - b.x, y: knock.to.y - b.y };
    const travelLen = Math.hypot(travel.x, travel.y) || 1;
    const fly = { x: travel.x / travelLen, y: travel.y / travelLen };
    const rndFx = seeded(73);
    const dust = Array.from({ length: 12 }, (_, i) => ({ at: (i + 0.5) / 12, side: (rndFx() - 0.5) * 1.4, size: 0.25 + rndFx() * 0.25, passed: null }));
    const speedLines = Array.from({ length: 26 }, () => ({ off: (rndFx() - 0.5) * 2.2, back: 0.6 + rndFx() * 2.5, len: 1.5 + rndFx() * 4, w: 0.5 + rndFx() * 1.5 }));
    const landPuffs = Array.from({ length: 10 }, () => ({ a: rndFx() * Math.PI * 2, dist: 1.2 + rndFx() * 1.4, size: 0.4 + rndFx() * 0.4 }));
    const landCracks = (() => {
        const out = [];
        for (let i = 0; i < 9; i++) {
            let a = i / 9 * Math.PI * 2 + rndFx() * 0.5, x = 0, y = 0, r = 0.8;
            x = Math.cos(a) * r; y = Math.sin(a) * r;
            const pts = [[x, y]];
            const len = 1.5 + rndFx() * 1.6;
            for (let k = 0; k < 6; k++) { a += (rndFx() - 0.5) * 0.8; x += Math.cos(a) * len / 6; y += Math.sin(a) * len / 6; pts.push([x, y]); }
            out.push(pts);
        }
        return out;
    })();
    // Реплика: пузырь у Сайтамы
    const bubble = new PIXI.Container();
    {
        // Размер текста — не меньше 30 пикселей экрана при обычном масштабе сцены
        const fs = Math.max(size * 0.6, 30 / saved.sx);
        const text = new PIXI.Text(OK_LINE, { fontFamily: 'Signika, Arial, sans-serif', fontSize: fs, fontWeight: '700', fill: 0x111111 });
        text.anchor.set(0.5);
        text.resolution = 3;
        const w = text.width + fs * 0.9, h = text.height + fs * 0.5;
        const g = new PIXI.Graphics();
        g.lineStyle(fs * 0.08, 0x111111, 1);
        g.beginFill(0xffffff);
        g.drawRoundedRect(-w / 2, -h / 2, w, h, h * 0.45);
        g.endFill();
        // Хвостик к Сайтаме
        g.beginFill(0xffffff);
        g.moveTo(-w * 0.18, h / 2 - fs * 0.04);
        g.lineTo(-w * 0.42, h / 2 + fs * 0.55);
        g.lineTo(-w * 0.02, h / 2 - fs * 0.04);
        g.endFill();
        g.moveTo(-w * 0.18, h / 2);
        g.lineTo(-w * 0.42, h / 2 + fs * 0.55);
        g.lineTo(-w * 0.02, h / 2);
        bubble.addChild(g, text);
        bubble.position.set(home.x + casterRadius * 0.9 + w * 0.3, home.y - casterRadius - h * 0.6);
        bubble.visible = false;
    }
    layer.addChild(dark, ground, air, burst, trail, ...ghosts.map(g => g.ghost), ...flightGhosts.map(g => g.ghost), ...[casterWrap, targetWrap].filter(Boolean), bubble);
    hideToken(caster);
    hideToken(target);
    const showMarks = hideMarks();
    stage.addChild(layer);
    // Сцена чёрно-белая с подъезда до отлёта
    const gray = grayFilter(0.35);
    gray.alpha = 0;
    const grayed = stageFilter(gray);
    const dropGray = grayed.remove;
    // Свет и молнии — холст поверх сцены в пикселях устройства
    const { canvas: cv, ctx } = overlay({ hidden: true });
    const lights = lightSet(ctx, Math.min(cv.width, cv.height));
    // Струи воздуха: угол, фаза и длина у каждой своя
    const rndAir = seeded(5);
    const streams = Array.from({ length: AIR.count }, () => ({ a: rndAir() * Math.PI * 2, phase: rndAir(), len: 0.5 + rndAir() * 0.9, w: 0.6 + rndAir() * 1.2 }));

    // Расписание: до кулаков — подъезд, вдох, рывок, разлёт и свет; после — полёт, приземление,
    // возврат камеры, реплика
    const sa = T.approach, si = sa + T.inhale, s2 = si + T.lunge, sL = s2 + T.lines, sp = sL + T.light;
    const sf = sp, sland = sf + T.fly, sHit = sland + T.hitstop, s6 = sHit + T.settle, sOk = s6 + T.back, end = sOk + T.ok;
    const shake = shaker();
    const kick = (when, power) => shake.kick(when, power);
    let contacted = false, launched = false, landed = false, fistsDone = false;
    // Звуки моментов до касания — один раз; длительность — с учётом замедления
    const cued = new Set();
    const cue = (name, when, t, options = {}) => { if (t >= when && !cued.has(name)) { cued.add(name); onCue(name.replace(/\d+$/, ''), options); } };

    return new Promise(resolve => {
        let t0 = performance.now();
        const finish = () => {
            cam.restore();
            dropGray();
            bars.remove();
            cv.remove();
            showToken(caster);
            layer.destroy({ children: true });
            showMarks();
            resolve(true);
        };
        const frame = now => {
            try {
                const t = (now - t0) / slow;
                if (t >= end || !canvas.ready) return finish();
                // Кулаки: на это время показ замирает, потом идёт дальше с того же места
                if (t >= sp && !fistsDone) {
                    fistsDone = true;
                    cv.style.display = 'none';
                    // Под кулаками сцена чёрная: после пятого — сразу полёт
                    dark.alpha = 1;
                    const paused = performance.now();
                    return Promise.resolve().then(between).catch(error => console.error('gachadnd | кулаки', error)).then(() => {
                        t0 += performance.now() - paused;
                        requestAnimationFrame(frame);
                    });
                }
                cue('approach', 0, t, { duration: sa / 1000 * slow });
                cue('bars', 0, t);
                // Промежуточные кадры касания: провал в тишину на белом, свист столба, треск молний
                const sw = sL + T.star + T.blot, sb2 = sw + T.white;
                if (!calm) {
                    cue('dip', sw, t, { duration: T.white / 1000 * slow });
                    cue('beam', sb2, t);
                }
                cue('zap', calm ? sL : sb2 + T.beam, t);
                if (!calm) cue('zap2', sb2 + T.beam + T.cone, t);
                // Вдох обрывается вместе с концом вдоха: дальше — свист рывка и тишина перед касанием
                cue('inhale', sa, t, { duration: T.inhale / 1000 * slow });
                cue('lunge', si, t);
                if (t >= s2 && !contacted) { contacted = true; onCue('contact'); kick(s2, SHAKE * 0.7); }
                // Полёт и приземление звучат с той стороны экрана, куда летит и где падает цель
                const panOf = p => Math.max(-1, Math.min(1, (screenOf(p).x / cv.width * 2 - 1) * 0.9));
                if (t >= sf && fistsDone && !launched) { launched = true; onCue('fly', { duration: T.fly / 1000 * slow, pan: panOf(knock.to) }); kick(sf, SHAKE * 0.6); }
                if (t >= sland && launched && !landed) { landed = true; onCue('land', { pan: panOf(knock.to) }); kick(sHit, SHAKE * 0.55); }
                // Перед репликой — тишина: хвосты приземления обрываются
                cue('hush', sOk - 420, t, { duration: 0.4 * slow });
                if (t >= sOk) cue('ok', sOk, t, { pan: caster ? panOf(home) * 0.6 : 0 });
                const jolt = shake.offset(t, T.burst);

                // Полёт: f — доля пути; стоп-кадр приземления — цель на месте, всё замерло
                const f = t < sf ? 0 : easeOut(clamp01((t - sf) / T.fly));

                // Камера
                const k = t < sa ? easeInOut(t / sa) : t < s6 ? 1 : 1 - easeOut(clamp01((t - s6) / T.back));
                const inhale = easeInOut(clamp01((t - sa) / T.inhale));
                const turn = easeOut(clamp01((t - si) / T.turn));
                let zoom, tilt, pull, follow = 0;
                if (t < si) {
                    zoom = lerp(1, CAM.inhaleZoom, inhale); tilt = CAM.inhaleTilt * inhale; pull = 0;
                } else if (t < sf) {
                    zoom = lerp(CAM.inhaleZoom, CAM.lungeZoom, turn) + 0.03 * clamp01((t - s2) / T.light);
                    tilt = lerp(CAM.inhaleTilt, CAM.lungeTilt, turn); pull = CAM.lungePull * turn;
                } else {
                    // Полёт: камеру бросает обратно по часовой, она провожает цель и чуть отъезжает
                    zoom = CAM.lungeZoom + 0.03 - 0.12 * f;
                    tilt = lerp(CAM.lungeTilt, CAM.blastTilt, springTo(clamp01((t - sf) / 200))) + CAM.drift * f;
                    pull = CAM.lungePull;
                    follow = 0.6 * f;
                }
                camera(k, zoom, pull, tilt, jolt.x, jolt.y, follow);
                bars.show(t < sa ? easeOut(t / sa) : t < s6 ? 1 : 1 - clamp01((t - s6) / T.back));
                // Ч/б — с подъезда; цвет возвращается во время полёта
                gray.alpha = t < sf ? clamp01(t / sa) : 1 - f;
                if (t >= sland) dropGray();
                dark.alpha = t < s2 ? 0.55 * clamp01(t / sa) : t < sf ? 1 : Math.max(0, 1 - f * 1.4);
                const unit = 1 / stage.scale.x;

                // Вдох: струи воздуха по спирали втягиваются в Сайтаму
                air.clear();
                if (caster && t >= sa && t < si) {
                    const strength = Math.sin(Math.PI * clamp01((t - sa) / T.inhale)) ** 0.5;
                    const c = casterWrap.position;
                    for (const st of streams) {
                        const p = ((t - sa) / AIR.period + st.phase) % 1;
                        const r = casterRadius * (1.1 + (AIR.from - 1.1) * (1 - p) ** 1.5);
                        const ang = st.a + p * 0.9;
                        const len = casterRadius * st.len * (1 - p * 0.6);
                        const x0 = c.x + Math.cos(ang) * r, y0 = c.y + Math.sin(ang) * r;
                        const x1 = c.x + Math.cos(ang - 0.25) * (r + len), y1 = c.y + Math.sin(ang - 0.25) * (r + len);
                        air.lineStyle(st.w * unit * 2, 0xffffff, 0.7 * strength * Math.sin(Math.PI * p));
                        air.moveTo(x1, y1);
                        air.lineTo(x0, y0);
                    }
                }

                // Сайтама: замах на вдохе, рывок к цели, во время полёта цели — обратно на место
                if (casterWrap) {
                    const wind = clamp01((t - sa) / T.windup);
                    const lunge = clamp01((t - si) / T.lunge);
                    const pos = t < si ? { x: lerp(home.x, windup.x, springTo(wind)), y: lerp(home.y, windup.y, springTo(wind)) }
                        : t < s2 ? { x: lerp(windup.x, contact.x, lunge ** 3), y: lerp(windup.y, contact.y, lunge ** 3) }
                        : t < sf ? contact
                        : { x: lerp(contact.x, home.x, f), y: lerp(contact.y, home.y, f) };
                    casterWrap.position.set(pos.x, pos.y);
                    const charge = t < si ? 0.18 * Math.min(1, wind * 1.4) * (1 + 0.15 * Math.sin(t / 55)) : 0;
                    const stretch = t >= si && t < s2 ? 0.35 * lunge : 0;
                    const recoil = t >= s2 ? -0.25 * wobble((t - s2) / T.squash) : 0;
                    const along = 1 - charge + stretch + recoil;
                    casterWrap.scale.set(along, 1 / Math.sqrt(Math.max(0.4, along)));
                    if (t >= sf && casterCopy) casterCopy.filters = f < 0.6 ? casterCopy.filters : null;
                }
                ghosts.forEach(({ ghost, base }, i) => {
                    const passed = si + T.lunge * Math.cbrt((i + 1) / 4);
                    ghost.alpha = t < passed ? 0 : base * (t < s2 ? 1 : Math.max(0, 1 - (t - s2) / T.ghosts));
                });

                // Разлёт за целью — первый кадр касания: сразу целиком, без роста
                burst.scale.set(t >= s2 && t < sL ? 1 : 0);

                // Цель: дрожит до касания, от касания качается; потом полёт и приземление
                const R = radius;
                if (t < sf) {
                    const tremble = t < s2 ? TREMBLE * unit * clamp01((t - sa) / (si - sa)) : 0;
                    targetWrap.position.set(b.x + (Math.random() - 0.5) * 2 * tremble, b.y + (Math.random() - 0.5) * 2 * tremble);
                    const hit = wobble((t - s2) / T.squash);
                    targetWrap.scale.set(1 - 0.3 * hit, 1 + 0.18 * hit);
                } else {
                    const at = { x: b.x + travel.x * f, y: b.y + travel.y * f };
                    targetWrap.position.set(at.x, at.y);
                    // Вытянута вдоль полёта, к концу — обратно; от приземления — сплющивается и качается
                    const st = FLIGHT.stretch * (1 - f) ** 2, land = wobble((t - sHit) / T.squash);
                    targetWrap.scale.set((1 + st) * (1 - 0.3 * land), (1 + 0.18 * land) / Math.sqrt(1 + st));
                    if (targetCopy) {
                        targetCopy.rotation = baseSpin + FLIGHT.spin * Math.PI * 2 * f;
                        targetCopy.filters = f < 0.6 ? targetCopy.filters : null;
                    }
                }
                // Следы полёта: копии цели позади, гаснут по очереди
                for (const g of flightGhosts) {
                    const fg = t < sf ? 0 : easeOut(clamp01((t - sf) / T.fly - g.lag));
                    g.ghost.position.set(b.x + travel.x * fg, b.y + travel.y * fg);
                    g.ghost.rotation = baseSpin + FLIGHT.spin * Math.PI * 2 * fg;
                    g.ghost.alpha = t < sf || t > sland + 120 ? 0 : g.base * (1 - clamp01((t - sland) / 120)) * (fg > 0 ? 1 : 0);
                }
                // Линии скорости: позади цели, вдоль полёта
                trail.clear();
                if (t >= sf && t < sland + 150) {
                    const fade = t < sland ? 1 - f * 0.4 : 1 - (t - sland) / 150;
                    const head = targetWrap.position, nx = -fly.y, ny = fly.x;
                    for (const l of speedLines) {
                        const x0 = head.x - fly.x * R * l.back + nx * R * l.off, y0 = head.y - fly.y * R * l.back + ny * R * l.off;
                        trail.lineStyle(l.w * unit * 2, 0xffffff, 0.75 * fade);
                        trail.moveTo(x0, y0);
                        trail.lineTo(x0 - fly.x * R * l.len, y0 - fly.y * R * l.len);
                    }
                }
                // Земля: пыль по пути, на приземлении — ударная волна, клубы и трещины
                ground.clear();
                for (const d of dust) {
                    if (d.passed === null && t >= sf && f >= d.at) d.passed = t;
                    if (d.passed === null) continue;
                    const age = (t - d.passed) / 700;
                    if (age >= 1) continue;
                    const px = b.x + travel.x * d.at - fly.y * R * d.side, py = b.y + travel.y * d.at + fly.x * R * d.side;
                    ground.beginFill(0xd9d0c4, 0.55 * (1 - age));
                    ground.drawCircle(px, py, R * d.size * (1 + age * 1.5));
                    ground.endFill();
                }
                if (t >= sHit) {
                    const L = knock.to;
                    const crackA = 1 - clamp01((t - sHit - T.cracks * 0.55) / (T.cracks * 0.45));
                    ground.lineStyle(R * 0.06, 0x241e1a, 0.85 * crackA);
                    for (const pts of landCracks) {
                        ground.moveTo(L.x + pts[0][0] * R, L.y + pts[0][1] * R);
                        for (const [x, y] of pts.slice(1)) ground.lineTo(L.x + x * R, L.y + y * R);
                    }
                    ground.lineStyle(0);
                    const wave = (t - sHit) / T.wave;
                    if (wave < 1) {
                        ground.lineStyle(R * 0.18 * (1 - wave), 0xffffff, 0.9 * (1 - wave));
                        ground.drawCircle(L.x, L.y, R * (1 + 3.2 * easeOut(wave)));
                        ground.lineStyle(0);
                    }
                    const puff = (t - sHit) / 800;
                    if (puff < 1) for (const p of landPuffs) {
                        ground.beginFill(0xd9d0c4, 0.6 * (1 - puff));
                        ground.drawCircle(L.x + Math.cos(p.a) * R * p.dist * (0.6 + 0.6 * easeOut(puff)), L.y + Math.sin(p.a) * R * p.dist * (0.6 + 0.6 * easeOut(puff)), R * p.size * (1 + puff));
                        ground.endFill();
                    }
                }
                // Реплика Сайтамы: выскакивает с пружиной, в конце гаснет
                if (t >= sOk) {
                    const age = t - sOk;
                    bubble.visible = true;
                    bubble.scale.set(Math.max(0.01, springTo(clamp01(age / 260))));
                    bubble.alpha = 1 - clamp01((age - (T.ok - 220)) / 220);
                }

                // Свет и молнии — после разлёта и до кулаков
                if (t >= sL && t < sp) {
                    cv.style.display = '';
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.clearRect(0, 0, cv.width, cv.height);
                    ctx.translate(jolt.x * devicePixelRatio, jolt.y * devicePixelRatio);
                    drawLight(ctx, cv.width, cv.height, screenOf(b), t - sL, lights, calm);
                } else cv.style.display = 'none';
                requestAnimationFrame(frame);
            } catch (error) {
                finish();
                console.error('gachadnd | удар Сайтамы', error);
            }
        };
        requestAnimationFrame(frame);
    });
}
