/**
 * Gacha Roguelike dnd5e — Удар Сайтамы в сцене
 *
 * Порядок кадра:
 *  1. Камера подъезжает к Сайтаме и цели, сцена уходит в ч/б, выезжают кинополосы.
 *  2. Вдох: воздух втягивается в Сайтаму, он замахивается назад, цель дрожит; камера медленно
 *     поворачивает по часовой и чуть отъезжает.
 *  3. Рывок: камера резко уходит против часовой и наезжает на цель, Сайтама бросается к ней.
 *  4. Касание — три мелькающих кадра на цели: столб света, молнии в тёмном конусе, молнии вокруг.
 *  5. Кулаки (impact-fists.js) — камера на это время замирает.
 *  6. За целью выстреливает разлёт, кадр инвертируется, цель отлетает по прямой от Сайтамы,
 *     сцена возвращается в цвет, камера — рывком на место.
 * Сцену и токены рисует движок (PIXI): они резкие при любом наезде; свет и молнии — вектор
 * поверх в разрешении экрана. Перенос токена делает клиент Мастера после показа.
 */

// Хронометраж, мс. Медленно — то, что надо рассмотреть, быстро — сами удары.
// approach — подъезд; inhale — вдох (windup — его часть с замахом); lunge — рывок; turn — резкий
// поворот камеры на рывке; light — кадры света и молний: связка, каждый мелькает на 3–4 кадра
// экрана, без своей анимации (beam — столб света, cone — молнии в тёмном конусе, остальное —
// молнии во все стороны);
// burst — тряска от разлёта; pop — выстрел разлёта; squash — качание токенов от удара; ghosts —
// следы рывка; hold — разлёт на виду; invert — инверсия; fly — отлёт; back — возврат камеры
const T = {
    approach: 520, inhale: 1000, windup: 650, lunge: 200, turn: 160, light: 170, beam: 50, cone: 60,
    burst: 250, pop: 45, squash: 450, ghosts: 450, hold: 220, invert: 140, fly: 300, back: 70
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

function seeded(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const easeOut = t => 1 - (1 - t) ** 3;
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const clamp01 = t => Math.min(1, Math.max(0, t));
// Пружина: 0 → 1 с перелётом и затухающими колебаниями
const springTo = t => t >= 1 ? 1 : 1 - Math.exp(-5 * t) * Math.cos(t * Math.PI * 2.6);
// Затухающее колебание около нуля после толчка: x — время в долях, 0 → 1
const wobble = x => x >= 1 || x < 0 ? 0 : Math.exp(-4.5 * x) * Math.cos(x * Math.PI * 5);
const lerp = (a, b, t) => a + (b - a) * t;

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

// Копия картинки токена в слое кадра: на месте токена, с его масштабом и поворотом
function tokenCopy(token) {
    const mesh = token?.mesh;
    if (!mesh?.texture) return null;
    const sprite = new PIXI.Sprite(mesh.texture);
    sprite.anchor.set(mesh.anchor?.x ?? 0.5, mesh.anchor?.y ?? 0.5);
    sprite.position.set(mesh.position.x, mesh.position.y);
    sprite.scale.set(mesh.scale.x, mesh.scale.y);
    sprite.rotation = mesh.rotation;
    // Чёрно-белый с поднятым контрастом
    const gray = new PIXI.ColorMatrixFilter();
    gray.desaturate();
    gray.contrast(0.5, true);
    sprite.filters = [gray];
    return sprite;
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
 * @param {() => void} options.onContact  Звук касания.
 * @param {() => Promise} options.between  Кулаки: камера ждёт, пока они отыграют.
 * @param {() => void} options.onBurst  Звук разлёта.
 * @returns {Promise<boolean>}  false — показать в сцене нельзя.
 */
export function playSaitama({ casterId, targetId, knock, calm = false, slow = 1, hideMarks = () => () => {}, onContact = () => {}, between = async () => {}, onBurst = () => {} }) {
    const stage = canvas?.stage, renderer = canvas?.app?.renderer;
    const caster = canvas?.tokens?.get(casterId), target = canvas?.tokens?.get(targetId);
    if (!stage || !renderer || !globalThis.PIXI || !target || !knock) return Promise.resolve(false);

    const saved = { x: stage.position.x, y: stage.position.y, sx: stage.scale.x, sy: stage.scale.y, rot: stage.rotation ?? 0 };
    const view = canvas.app.view ?? canvas.app.canvas;
    const rect = view.getBoundingClientRect();
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
    const half = ['x', 'y'].map(axis => Math.max(...[a, b, windup].map(p => Math.abs(p[axis] - span[axis]))) + radius * 1.5);
    const maxScale = Math.min(saved.sx * MAX_ZOOM, globalThis.CONFIG?.Canvas?.maxZoom ?? 3);
    const fit = Math.min(rect.width * FILL / (2 * half[0]), rect.height * FILL / (2 * half[1]));
    const scale = Math.max(saved.sx, Math.min(maxScale, fit));
    const focus = { x: lerp(span.x, b.x, 0.15), y: lerp(span.y, b.y, 0.15) };
    // Положение сцены, при котором точка center — в центре экрана при масштабе s и повороте rot
    const at = (s, center, rot = 0) => {
        const dx = (center.x - stage.pivot.x) * s, dy = (center.y - stage.pivot.y) * s;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        return { x: rect.width / 2 - (dx * cos - dy * sin), y: rect.height / 2 - (dx * sin + dy * cos) };
    };
    const viewCenter = { x: stage.pivot.x + (rect.width / 2 - saved.x) / saved.sx, y: stage.pivot.y + (rect.height / 2 - saved.y) / saved.sy };
    // Камера: k — от обычного вида (0) к крупному плану (1); zoom — множитель крупного плана;
    // pull — сдвиг центра к цели; tilt — поворот
    const camera = (k, zoom, pull, tilt, dx = 0, dy = 0) => {
        const s = lerp(saved.sx, scale * zoom, k), rot = tilt * k;
        const f = { x: lerp(focus.x, b.x, pull), y: lerp(focus.y, b.y, pull) };
        const pos = at(s, { x: lerp(viewCenter.x, f.x, k), y: lerp(viewCenter.y, f.y, k) }, rot);
        stage.scale.set(s, s * saved.sy / saved.sx);
        stage.rotation = saved.rot + rot;
        stage.position.set(pos.x + dx, pos.y + dy);
    };
    // Точка сцены → пиксели устройства на экране при текущей камере
    const screenOf = p => {
        const dx = (p.x - stage.pivot.x) * stage.scale.x, dy = (p.y - stage.pivot.y) * stage.scale.y;
        const cos = Math.cos(stage.rotation), sin = Math.sin(stage.rotation);
        return { x: (rect.left + stage.position.x + dx * cos - dy * sin) * devicePixelRatio, y: (rect.top + stage.position.y + dx * sin + dy * cos) * devicePixelRatio };
    };

    // Кинополосы — поверх всего, не наклоняются с камерой
    const bars = ['top', 'bottom'].map(side => {
        const bar = document.createElement('div');
        bar.className = `gd-letterbox gd-letterbox-${side}`;
        bar.style.height = `${BARS * 100}vh`;
        document.body.append(bar);
        return bar;
    });
    const showBars = k => bars.forEach((bar, i) => bar.style.transform = `translateY(${(i ? 1 : -1) * (1 - k) * 100}%)`);
    showBars(0);

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
    const wrap = copy => {
        const frame = new PIXI.Container();
        frame.rotation = dir;
        if (copy) {
            frame.position.set(copy.position.x, copy.position.y);
            copy.position.set(0, 0);
            copy.rotation -= dir;
            frame.addChild(copy);
        }
        return frame;
    };
    const casterWrap = casterCopy ? wrap(casterCopy) : null;
    const targetWrap = wrap(targetCopy);
    targetWrap.position.set(b.x, b.y);
    const ghosts = caster ? [0.25, 0.5, 0.75].map(f => {
        const ghost = tokenCopy(caster);
        ghost.position.set(lerp(windup.x, contact.x, f), lerp(windup.y, contact.y, f));
        ghost.alpha = 0;
        return { ghost, base: 0.2 + f * 0.3 };
    }) : [];
    layer.addChild(dark, air, burst, ...ghosts.map(g => g.ghost), ...[casterWrap, targetWrap].filter(Boolean));
    for (const token of [caster, target]) if (token?.mesh) { token.mesh.gdAlpha ??= token.mesh.alpha; token.mesh.alpha = 0; }
    const invert = new PIXI.ColorMatrixFilter();
    invert.negative();
    const showMarks = hideMarks();
    stage.addChild(layer);
    // Сцена чёрно-белая с подъезда до отлёта
    const gray = new PIXI.ColorMatrixFilter();
    gray.desaturate();
    gray.contrast(0.35, true);
    gray.alpha = 0;
    const savedFilters = { filters: stage.filters, area: stage.filterArea };
    stage.filters = [...(savedFilters.filters ?? []), gray];
    stage.filterArea = renderer.screen;
    let grayOn = true;
    const dropGray = () => {
        if (!grayOn) return;
        grayOn = false;
        stage.filters = savedFilters.filters ?? null;
        stage.filterArea = savedFilters.area ?? null;
    };
    // Свет и молнии — холст поверх сцены в пикселях устройства
    const cv = document.createElement('canvas');
    cv.className = 'gd-impact';
    cv.width = Math.round(innerWidth * devicePixelRatio);
    cv.height = Math.round(innerHeight * devicePixelRatio);
    cv.style.display = 'none';
    document.body.append(cv);
    const ctx = cv.getContext('2d');
    const lights = lightSet(ctx, Math.min(cv.width, cv.height));
    // Струи воздуха: угол, фаза и длина у каждой своя
    const rndAir = seeded(5);
    const streams = Array.from({ length: AIR.count }, () => ({ a: rndAir() * Math.PI * 2, phase: rndAir(), len: 0.5 + rndAir() * 0.9, w: 0.6 + rndAir() * 1.2 }));

    // Расписание: до кулаков — подъезд, вдох, рывок, свет; после — разлёт, инверсия, отлёт
    const sa = T.approach, si = sa + T.inhale, s2 = si + T.lunge, sp = s2 + T.light;
    const sb = sp, s3 = sb + T.burst, s4 = s3 + T.hold, s5 = s4 + (calm ? 0 : T.invert), s6 = s5 + T.fly, end = s6 + T.back;
    const shake = { x: 0, y: 0, at: -1e9, power: 0 };
    const kick = (when, power) => { const angle = Math.random() * Math.PI * 2; Object.assign(shake, { x: Math.cos(angle), y: Math.sin(angle), at: when, power }); };
    let contacted = false, burstPlayed = false, fistsDone = false;

    return new Promise(resolve => {
        let t0 = performance.now();
        const finish = () => {
            camera(0, 1, 0, 0);
            stage.rotation = saved.rot;
            dropGray();
            bars.forEach(bar => bar.remove());
            cv.remove();
            if (caster?.mesh?.gdAlpha !== undefined) { caster.mesh.alpha = caster.mesh.gdAlpha; delete caster.mesh.gdAlpha; }
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
                    const paused = performance.now();
                    return Promise.resolve().then(between).catch(error => console.error('gachadnd | кулаки', error)).then(() => {
                        t0 += performance.now() - paused;
                        requestAnimationFrame(frame);
                    });
                }
                // Касание: звук и тряска; разлёт после кулаков: звук и тряска сильнее
                if (t >= s2 && !contacted) { contacted = true; onContact(); kick(s2, SHAKE * 0.7); }
                if (t >= sb && fistsDone && !burstPlayed) { burstPlayed = true; onBurst(); kick(sb, SHAKE); }
                const sk = (t - shake.at) / T.burst;
                const jolt = sk >= 0 && sk < 1 ? shake.power * (1 - sk) ** 2 * Math.cos((t - shake.at) / 18 * Math.PI) : 0;

                // Камера
                const k = t < sa ? easeInOut(t / sa) : t < s6 ? 1 : 1 - easeOut((t - s6) / T.back);
                const inhale = easeInOut(clamp01((t - sa) / T.inhale));
                const turn = easeOut(clamp01((t - si) / T.turn));
                let zoom, tilt, pull;
                if (t < si) {
                    zoom = lerp(1, CAM.inhaleZoom, inhale); tilt = CAM.inhaleTilt * inhale; pull = 0;
                } else if (t < sb) {
                    zoom = lerp(CAM.inhaleZoom, CAM.lungeZoom, turn) + 0.03 * clamp01((t - s2) / T.light);
                    tilt = lerp(CAM.inhaleTilt, CAM.lungeTilt, turn); pull = CAM.lungePull * turn;
                } else {
                    // Разлёт бросает камеру обратно по часовой, дальше она плывёт
                    zoom = CAM.lungeZoom + 0.03;
                    tilt = lerp(CAM.lungeTilt, CAM.blastTilt, springTo(clamp01((t - sb) / 200))) + CAM.drift * clamp01((t - sb) / (s6 - sb));
                    pull = CAM.lungePull;
                }
                camera(k, zoom, pull, tilt, shake.x * jolt, shake.y * jolt);
                showBars(t < sa ? easeOut(t / sa) : t < s6 ? 1 : 1 - clamp01((t - s6) / T.back));
                gray.alpha = clamp01(t / sa);
                if (t >= s5) dropGray();
                // Затемнение: на крупном плане — наполовину, с разлётом — полностью, при отлёте уходит
                dark.alpha = t < sb ? 0.55 * clamp01(t / sa) : t < s5 ? 1 : Math.max(0, 1 - (t - s5) / T.fly);
                const unit = 1 / stage.scale.x;

                // Вдох: струи воздуха по спирали втягиваются в Сайтаму, к концу вдоха гуще
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

                // Сайтама: замах назад с пружиной на вдохе, рывок к цели, после отлёта — обратно.
                // На замахе сжат вдоль удара и пульсирует, в рывке вытянут, от касания — качается
                if (casterWrap) {
                    const wind = clamp01((t - sa) / T.windup);
                    const lunge = clamp01((t - si) / T.lunge);
                    const pos = t < si ? { x: lerp(home.x, windup.x, springTo(wind)), y: lerp(home.y, windup.y, springTo(wind)) }
                        : t < s2 ? { x: lerp(windup.x, contact.x, lunge ** 3), y: lerp(windup.y, contact.y, lunge ** 3) }
                        : t < s5 ? contact
                        : (f => ({ x: lerp(contact.x, home.x, f), y: lerp(contact.y, home.y, f) }))(easeOut(clamp01((t - s5) / T.fly)));
                    casterWrap.position.set(pos.x, pos.y);
                    const charge = t < si ? 0.18 * Math.min(1, wind * 1.4) * (1 + 0.15 * Math.sin(t / 55)) : 0;
                    const stretch = t >= si && t < s2 ? 0.35 * lunge : 0;
                    const recoil = t >= s2 ? -0.25 * wobble((t - s2) / T.squash) : 0;
                    const along = 1 - charge + stretch + recoil;
                    casterWrap.scale.set(along, 1 / Math.sqrt(Math.max(0.4, along)));
                }
                ghosts.forEach(({ ghost, base }, i) => {
                    const passed = si + T.lunge * Math.cbrt((i + 1) / 4);
                    ghost.alpha = t < passed ? 0 : base * (t < s2 ? 1 : Math.max(0, 1 - (t - s2) / T.ghosts));
                });
                // Цель: дрожит до касания; от касания и от разлёта сплющивается и качается
                const tremble = t < s2 ? TREMBLE * unit * clamp01((t - sa) / (si - sa)) : 0;
                const hit = wobble((t - s2) / T.squash) + (fistsDone ? wobble((t - sb) / T.squash) : 0);
                targetWrap.scale.set(1 - 0.3 * hit, 1 + 0.18 * hit);

                // Разлёт за целью — после кулаков
                const pop = (t - sb) / T.pop;
                burst.scale.set(!fistsDone || t < sb ? 0 : pop < 1 ? 0.35 + 0.85 * easeOut(pop) : 1 + 0.2 * Math.max(0, 1 - (pop - 1) / 2));
                burst.alpha = t < s5 ? 1 : Math.max(0, 1 - (t - s5) / (T.fly * 0.6));
                layer.filters = !calm && t >= s4 && t < s5 ? [invert] : null;
                if (t >= s5) {
                    const f = easeOut(clamp01((t - s5) / T.fly));
                    targetWrap.position.set(lerp(b.x, knock.to.x, f), lerp(b.y, knock.to.y, f));
                    for (const copy of [casterCopy, targetCopy]) if (copy) copy.filters = f < 0.6 ? copy.filters : null;
                } else targetWrap.position.set(b.x + (Math.random() - 0.5) * 2 * tremble, b.y + (Math.random() - 0.5) * 2 * tremble);

                // Свет и молнии — от касания до кулаков
                if (t >= s2 && t < sp) {
                    cv.style.display = '';
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.clearRect(0, 0, cv.width, cv.height);
                    const d = jolt * devicePixelRatio;
                    ctx.translate(shake.x * d, shake.y * d);
                    drawLight(ctx, cv.width, cv.height, screenOf(b), t - s2, lights, calm);
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
