/**
 * Gacha Roguelike dnd5e — Отлёт цели (второй этап кадра Сайтамы)
 *
 * После кулаков камера наезжает на середину между Сайтамой и целью, их токены становятся
 * чёрно-белыми. Всё остальное уходит в чёрное, и за целью вырастает белый взрыв — шлейф
 * в сторону отлёта с лучами. Кадр инвертируется, цель отлетает по прямой от Сайтамы,
 * и сцена возвращается в цвет. Рисует сам движок сцены (PIXI): токены резкие при любом наезде.
 * Сам перенос токена на новое место делает клиент Мастера, когда его показ закончился.
 */

// Хронометраж, мс
const T = { zoom: 320, gray: 140, burst: 190, hold: 110, invert: 130, fly: 280, back: 260 };
// Наезд: Сайтама и цель занимают такую долю экрана; не больше MAX_ZOOM от текущего
const FILL = 0.75, MAX_ZOOM = 3;

function seeded(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const easeOut = t => 1 - (1 - t) ** 3;
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
 * Линии гуще у оси, разной длины и толщины, часть — пунктиром; каждая сужается к обоим концам,
 * как мазок. Длина разлёта — расстояние отлёта.
 * @param {number} radius  Радиус токена: линии начинаются у его края.
 * @param {number} reach   Расстояние отлёта.
 */
function burstGraphic(radius, reach) {
    const g = new PIXI.Graphics();
    const rnd = seeded(13), R = radius, L = Math.max(reach, radius * 4);
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
    for (let i = 0; i < 420; i++) {
        // Гуще у оси: угол — разность двух случайных
        const a = (rnd() - rnd()) * SPREAD;
        const from = R * (0.95 + rnd() * 0.9) + L * rnd() ** 3 * 0.4;
        const to = from + L * (0.25 + rnd() ** 0.6 * 0.95) * (1 - Math.abs(a) / SPREAD * 0.6);
        const w = (0.002 + rnd() ** 3 * 0.02) * (1 - Math.abs(a) / SPREAD * 0.5);
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
    const close = at(scale, { x: lerp(mid.x, b.x, 0.35), y: lerp(mid.y, b.y, 0.35) });
    const camera = (k, dx = 0, dy = 0) => {
        const s = lerp(saved.sx, scale, k);
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
    layer.addChild(dark, burst, ...[casterCopy, targetCopy].filter(Boolean));
    const invert = new PIXI.ColorMatrixFilter();
    invert.negative();
    const showMarks = hideMarks();
    stage.addChild(layer);

    // Расписание
    const s1 = T.zoom, s2 = s1 + T.gray, s3 = s2 + T.burst, s4 = s3 + T.hold, s5 = s4 + (calm ? 0 : T.invert), s6 = s5 + T.fly, end = s6 + T.back;
    let burstPlayed = false;
    const shake = { x: 0, y: 0 };

    return new Promise(resolve => {
        const t0 = performance.now();
        const finish = () => {
            camera(0);
            layer.destroy({ children: true });
            showMarks();
            resolve(true);
        };
        const frame = now => {
            try {
                const t = (now - t0) / slow;
                if (t >= end || !canvas.ready) return finish();
                // Камера: наезд, держится, после отлёта — обратно
                const k = t < s1 ? easeInOut(t / s1) : t < s6 ? 1 : 1 - easeInOut((t - s6) / T.back);
                if (t >= s2 && !burstPlayed) {
                    burstPlayed = true;
                    onBurst();
                    const p = 14 / scale;
                    shake.x = (Math.random() - 0.5) * p * scale; shake.y = (Math.random() - 0.5) * p * scale;
                }
                const shaking = t >= s2 && t < s3;
                camera(k, shaking ? shake.x * (1 - (t - s2) / T.burst) : 0, shaking ? shake.y * (1 - (t - s2) / T.burst) : 0);
                // Затемнение: при наезде — наполовину, со взрывом — полностью, при отлёте уходит
                dark.alpha = t < s2 ? 0.55 * Math.min(1, t / s1) : t < s5 ? 1 : Math.max(0, 1 - (t - s5) / T.fly);
                // Взрыв растёт из-за цели и гаснет вместе с затемнением
                burst.scale.set(t < s2 ? 0 : easeOut(Math.min(1, (t - s2) / T.burst)));
                burst.alpha = t < s5 ? 1 : Math.max(0, 1 - (t - s5) / (T.fly * 0.6));
                layer.filters = !calm && t >= s4 && t < s5 ? [invert] : null;
                // Отлёт: копия цели летит, настоящий токен на старом месте скрыт
                if (t >= s5) {
                    const f = easeOut(Math.min(1, (t - s5) / T.fly));
                    if (targetCopy) targetCopy.position.set(lerp(b.x, knock.to.x, f), lerp(b.y, knock.to.y, f));
                    if (target.mesh) { target.mesh.gdAlpha ??= target.mesh.alpha; target.mesh.alpha = 0; }
                    // Копии возвращают цвет вместе со сценой
                    for (const copy of [casterCopy, targetCopy]) if (copy) copy.filters = f < 0.6 ? copy.filters : null;
                }
                requestAnimationFrame(frame);
            } catch (error) {
                finish();
                console.error('gachadnd | отлёт цели', error);
            }
        };
        requestAnimationFrame(frame);
    });
}
