/**
 * Gacha Roguelike dnd5e — Отлёт цели (второй этап кадра Сайтамы)
 *
 * После кулаков — склейка на крупный план Сайтамы и цели, сцена чёрно-белая; камера ползёт
 * ближе, Сайтама замахивается назад, цель дрожит. На взрыве Сайтама рывком бросается к цели,
 * цель сжимается от удара. Всё остальное уходит в чёрное, и за целью вырастает белый взрыв — шлейф
 * в сторону отлёта с лучами. Кадр инвертируется, цель отлетает по прямой от Сайтамы,
 * и сцена возвращается в цвет. Рисует сам движок сцены (PIXI): токены резкие при любом наезде.
 * Сам перенос токена на новое место делает клиент Мастера, когда его показ закончился.
 */

// Хронометраж, мс
// tense — крупный план до взрыва: камера уже там (склейка), ползёт ближе, Сайтама замахивается,
// цель дрожит; lunge — рывок Сайтамы к цели, взрыв — в момент касания; burst — разлёт и тряска после взрыва; pop — за сколько
// разлёт выстреливает на полную длину; squash — сжатие и отскок цели от удара;
// back — возврат камеры: рывком, а не плавно
// PACE замедляет весь этап, кроме взрывных мгновений: выстрела разлёта и рывка камеры назад
const PACE = 1.3;
const T = Object.fromEntries(Object.entries({ tense: 1000, lunge: 170, burst: 190, squash: 420, ghosts: 420, hold: 110, invert: 130, fly: 280 })
    .map(([key, ms]) => [key, ms * PACE]).concat([['pop', 45], ['back', 70]]));
// Замах занимает такую долю крупного плана, остальное — Сайтама держит его, цель дрожит
const WINDUP_SHARE = 0.65;
// Камера на крупном плане ползёт ещё ближе, доля
const CREEP = 0.07;
// Замах Сайтамы назад — доля клетки; дрожь цели — CSS-пиксели
const WINDUP = 1.2, TREMBLE = 1.6;
// Тряска от взрыва, CSS-пиксели: затухает за время разлёта
const SHAKE = 34;
// Наезд: Сайтама и цель занимают такую долю экрана; не больше MAX_ZOOM от текущего
const FILL = 0.75, MAX_ZOOM = 3;

function seeded(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const easeOut = t => 1 - (1 - t) ** 3;
// Пружина: 0 → 1 с перелётом и затухающими колебаниями
const springTo = t => t >= 1 ? 1 : 1 - Math.exp(-5 * t) * Math.cos(t * Math.PI * 2.6);
// Затухающее колебание около нуля после толчка: x — время в долях, 0 → 1
const wobble = x => x >= 1 || x < 0 ? 0 : Math.exp(-4.5 * x) * Math.cos(x * Math.PI * 5);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Куда отлетает цель: по прямой от нанёсшего удар на feet футов, до первой стены.
 * Считается там, где применён урон, и рассылается всем вместе с кадром.
 * @returns {{tokenId, x, y, reach, from: {x, y}, to: {x, y}}|null}  x, y — новый левый верхний угол токена; reach — полная дальность.
 */
export function knockback(casterId, targetId, feet) {
    const caster = canvas?.tokens?.get(casterId), target = canvas?.tokens?.get(targetId);
    const dims = canvas?.dimensions;
    if (!caster || !target || !dims?.distance) return null;
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
    return { tokenId: targetId, x: corner.x, y: corner.y, reach, from: { x: b.x, y: b.y }, to: { x: corner.x + w / 2, y: corner.y + h / 2 } };
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

/**
 * @param {object} options
 * @param {string} options.casterId, targetId  Токены.
 * @param {object} options.knock  Из knockback.
 * @param {boolean} options.calm  Без инверсии.
 * @param {number} options.slow   Замедление.
 * @param {() => () => void} options.hideMarks  Прячет значки токенов, возвращает восстановление.
 * @param {() => void} options.onBurst  Звук взрыва.
 * @returns {Promise<void>}
 */
export function playKnock({ casterId, targetId, knock, calm = false, slow = 1, hideMarks = () => () => {}, onBurst = () => {} }) {
    const stage = canvas?.stage, renderer = canvas?.app?.renderer;
    const caster = canvas?.tokens?.get(casterId), target = canvas?.tokens?.get(targetId);
    if (!stage || !renderer || !globalThis.PIXI || !target || !knock) return Promise.resolve(false);

    const saved = { x: stage.position.x, y: stage.position.y, sx: stage.scale.x, sy: stage.scale.y };
    const view = canvas.app.view ?? canvas.app.canvas;
    const rect = view.getBoundingClientRect();
    // Наезд на середину между Сайтамой и целью; в кадре — оба токена, шлейф может уходить за край
    const a = caster?.center ?? knock.from, b = knock.from;
    const radius = Math.max(target.w ?? 0, target.h ?? 0, canvas.dimensions.size) / 2;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Центр кадра чуть смещён к цели: за ней разлёт
    const half = ['x', 'y'].map(axis => Math.max(...[a, b].map(p => Math.abs(p[axis] - mid[axis]))) + radius * 1.5);
    const maxScale = Math.min(saved.sx * MAX_ZOOM, globalThis.CONFIG?.Canvas?.maxZoom ?? 3);
    const fit = Math.min(rect.width * FILL / (2 * half[0]), rect.height * FILL / (2 * half[1]));
    const scale = Math.max(saved.sx, Math.min(maxScale, fit));
    const at = (s, center) => ({ x: rect.width / 2 - (center.x - stage.pivot.x) * s, y: rect.height / 2 - (center.y - stage.pivot.y) * s });
    const focus = { x: lerp(mid.x, b.x, 0.35), y: lerp(mid.y, b.y, 0.35) };
    // Камера: k — от обычного вида (0) к крупному плану (1); creep — доползание на крупном плане
    const camera = (k, creep, dx = 0, dy = 0) => {
        const zoomed = scale * (1 + CREEP * creep), close = at(zoomed, focus);
        const s = lerp(saved.sx, zoomed, k);
        stage.scale.set(s, s * saved.sy / saved.sx);
        stage.position.set(lerp(saved.x, close.x, k) + dx, lerp(saved.y, close.y, k) + dy);
    };

    // Слой кадра поверх сцены: затемнение, взрыв, копии токенов. Инверсия — фильтром слоя
    const layer = new PIXI.Container();
    const dark = new PIXI.Graphics();
    dark.beginFill(0x000000).drawRect(-1e6, -1e6, 2e6, 2e6).endFill();
    dark.alpha = 0;
    const burst = burstGraphic(radius, knock.reach ?? Math.hypot(knock.to.x - b.x, knock.to.y - b.y));
    burst.position.set(b.x, b.y);
    burst.rotation = Math.atan2(knock.to.y - b.y, knock.to.x - b.x);
    burst.scale.set(0, 0);
    const casterCopy = caster ? tokenCopy(caster) : null, targetCopy = tokenCopy(target);
    // Направление удара: от Сайтамы к цели
    const dir = Math.atan2(b.y - a.y, b.x - a.x), ux = Math.cos(dir), uy = Math.sin(dir);
    // Рамки, повёрнутые по удару: сжатие и растяжение токенов идут вдоль удара, а не по осям картинки
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
    const casterRadius = caster ? Math.max(caster.w ?? 0, caster.h ?? 0, canvas.dimensions.size) / 2 : 0;
    // Замах: назад от цели; рывок: вплотную к цели
    const home = { x: a.x, y: a.y };
    const windup = { x: a.x - ux * WINDUP * canvas.dimensions.size, y: a.y - uy * WINDUP * canvas.dimensions.size };
    const reachDist = Math.max(0, Math.hypot(b.x - a.x, b.y - a.y) - (casterRadius + radius) * 0.95);
    const contact = { x: a.x + ux * reachDist, y: a.y + uy * reachDist };
    const targetWrap = wrap(targetCopy);
    targetWrap.position.set(b.x, b.y);
    // Следы рывка: полупрозрачные копии Сайтамы между замахом и целью
    const ghosts = caster ? [0.25, 0.5, 0.75].map(f => {
        const ghost = tokenCopy(caster);
        ghost.position.set(lerp(windup.x, contact.x, f), lerp(windup.y, contact.y, f));
        ghost.alpha = 0;
        return { ghost, base: 0.2 + f * 0.3 };
    }) : [];
    layer.addChild(dark, burst, ...ghosts.map(g => g.ghost), ...[casterWrap, targetWrap].filter(Boolean));
    // Сцена чёрно-белая с первого кадра крупного плана до отлёта
    const gray = new PIXI.ColorMatrixFilter();
    gray.desaturate();
    gray.contrast(0.35, true);
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
    // Настоящие токены скрыты на весь кадр: двигаются их копии
    for (const token of [caster, target]) if (token?.mesh) { token.mesh.gdAlpha ??= token.mesh.alpha; token.mesh.alpha = 0; }
    const invert = new PIXI.ColorMatrixFilter();
    invert.negative();
    const showMarks = hideMarks();
    stage.addChild(layer);

    // Расписание
    const sl = T.tense, s2 = sl + T.lunge, s3 = s2 + T.burst, s4 = s3 + T.hold, s5 = s4 + (calm ? 0 : T.invert), s6 = s5 + T.fly, end = s6 + T.back;
    let burstPlayed = false;
    const shake = { x: 0, y: 0 };

    return new Promise(resolve => {
        const t0 = performance.now();
        const finish = () => {
            camera(0, 0);
            dropGray();
            // Сайтама на месте — его токен виден сразу; цель — когда Мастер её перенёс
            if (caster?.mesh?.gdAlpha !== undefined) { caster.mesh.alpha = caster.mesh.gdAlpha; delete caster.mesh.gdAlpha; }
            layer.destroy({ children: true });
            showMarks();
            resolve(true);
        };
        const frame = now => {
            try {
                const t = (now - t0) / slow;
                if (t >= end || !canvas.ready) return finish();
                // Камера: склейка на крупный план, там ползёт ближе; после отлёта — рывком обратно
                const k = t < s6 ? 1 : 1 - easeOut((t - s6) / T.back);
                const creep = easeOut(Math.min(1, t / s3));
                if (t >= s2 && !burstPlayed) {
                    burstPlayed = true;
                    onBurst();
                    const angle = Math.random() * Math.PI * 2;
                    shake.x = Math.cos(angle) * SHAKE; shake.y = Math.sin(angle) * SHAKE;
                }
                const shaking = t >= s2 && t < s3;
                // Тряска: камеру бросает туда-обратно, размах быстро гаснет
                const jolt = shaking ? (1 - (t - s2) / T.burst) ** 2 * Math.cos((t - s2) / 18 * Math.PI) : 0;
                camera(k, creep, shake.x * jolt, shake.y * jolt);
                // Затемнение: на крупном плане — наполовину, со взрывом — полностью, при отлёте уходит
                dark.alpha = t < s2 ? 0.55 : t < s5 ? 1 : Math.max(0, 1 - (t - s5) / T.fly);
                const unit = 1 / stage.scale.x;
                // Сцена возвращает цвет с отлётом
                if (t >= s5) dropGray();
                // Сайтама: замах назад с пружинящим перелётом, рывок к цели, после отлёта — обратно на место.
                // Пружина в теле: на замахе сжат вдоль удара, в рывке вытянут, от касания — сплющен и качается
                if (casterWrap) {
                    const wind = Math.min(1, t / (sl * WINDUP_SHARE));
                    const p = springTo(wind);
                    const lunge = Math.max(0, Math.min(1, (t - sl) / T.lunge));
                    const pos = t < sl ? { x: lerp(home.x, windup.x, p), y: lerp(home.y, windup.y, p) }
                        // Рывок разгоняется к цели: быстрее всего — в момент удара
                        : t < s2 ? { x: lerp(windup.x, contact.x, lunge ** 2), y: lerp(windup.y, contact.y, lunge ** 2) }
                        : t < s5 ? contact
                        : (f => ({ x: lerp(contact.x, home.x, f), y: lerp(contact.y, home.y, f) }))(easeOut(Math.min(1, (t - s5) / T.fly)));
                    casterWrap.position.set(pos.x, pos.y);
                    // Вдоль удара: сжатие на замахе (держится, слегка пульсирует), вытяжение в рывке, сплющивание от касания
                    const charge = t < sl ? 0.18 * Math.min(1, wind * 1.4) * (1 + 0.15 * Math.sin(t / 55)) : 0;
                    const stretch = t >= sl && t < s2 ? 0.35 * lunge : 0;
                    const recoil = t >= s2 ? -0.25 * wobble((t - s2) / T.squash) : 0;
                    const along = 1 - charge + stretch + recoil;
                    casterWrap.scale.set(along, 1 / Math.sqrt(Math.max(0.4, along)));
                }
                // Следы рывка: каждый остаётся, когда Сайтама его прошёл, и гаснет после удара
                ghosts.forEach(({ ghost, base }, i) => {
                    const passed = sl + T.lunge * Math.sqrt((i + 1) / 4);
                    ghost.alpha = t < passed ? 0 : base * (t < s2 ? 1 : Math.max(0, 1 - (t - s2) / T.ghosts));
                });
                // Цель: дрожит до взрыва, сильнее к удару; от удара сплющивается вдоль него и качается, как пружина
                const tremble = t < s2 ? TREMBLE * unit * Math.min(1, t / sl) : 0;
                const hit = t < s2 ? 0 : wobble((t - s2) / T.squash);
                targetWrap.scale.set(1 - 0.3 * hit, 1 + 0.18 * hit);
                // Взрыв растёт из-за цели и гаснет вместе с затемнением
                // Разлёт выстреливает за T.pop с перелётом и отскакивает к полной длине
                const pop = (t - s2) / T.pop;
                burst.scale.set(t < s2 ? 0 : pop < 1 ? 0.35 + 0.85 * easeOut(pop) : 1 + 0.2 * Math.max(0, 1 - (pop - 1) / 2));
                burst.alpha = t < s5 ? 1 : Math.max(0, 1 - (t - s5) / (T.fly * 0.6));
                layer.filters = !calm && t >= s4 && t < s5 ? [invert] : null;
                // Отлёт: копия цели летит, настоящий токен на старом месте скрыт
                if (t >= s5) {
                    const f = easeOut(Math.min(1, (t - s5) / T.fly));
                    targetWrap.position.set(lerp(b.x, knock.to.x, f), lerp(b.y, knock.to.y, f));
                    // Копии возвращают цвет вместе со сценой
                    for (const copy of [casterCopy, targetCopy]) if (copy) copy.filters = f < 0.6 ? copy.filters : null;
                } else targetWrap.position.set(b.x + (Math.random() - 0.5) * 2 * tremble, b.y + (Math.random() - 0.5) * 2 * tremble);
                requestAnimationFrame(frame);
            } catch (error) {
                finish();
                console.error('gachadnd | отлёт цели', error);
            }
        };
        requestAnimationFrame(frame);
    });
}
