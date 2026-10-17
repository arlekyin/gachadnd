/**
 * Gacha Roguelike dnd5e — Живые чернила
 *
 * Общий набросок от руки для карты этажа, Летописи и зарисовок событий.
 * Всё «нарисованное» строится из случайных чисел с зерном (seeded): у всех клиентов и при каждой перерисовке
 * линии дрожат одинаково. «Живые чернила»: у каждого штриха несколько форм с одним набором команд пути, и SVG
 * плавно перетекает между ними (animate по атрибуту d) — штрих медленно изгибается, как чернила на мокрой бумаге.
 *
 * Примитивы:
 *   stroke(points, rand, o)    — линия от руки по ломаной: дрожь поперёк, сглаживание, формы для перетекания;
 *   sketchLine(a, b, rand, o)  — путь между узлами карты (выходит вверх, входит сверху), концы не доходят до узлов;
 *   brushRing(rand, o)         — мазок кистью по кругу (кольцо узла);
 *   jitterPath(d, rand, k)     — те же числа пути, чуть сдвинутые (формы рисунка);
 *   inkSvgPath(forms, rand, o) — <path> с перетеканием форм и, по желанию, прорисовкой пером.
 * Координаты — в единицах поля; px = { x, y } — сколько пикселей в единице (отступы и дрожь задаются в пикселях).
 */

export const INK_FORMS = 3;

// Часы SVG стартуют при вставке в страницу, поэтому начало сдвинуто назад на время страницы: перерисованная
// линия продолжает движение с того же места. (setCurrentTime сразу после вставки в Chrome замораживает анимацию.)
let clock = 0;
/** Сдвинуть начало течения чернил к текущему времени страницы — перед каждой перерисовкой */
export const resetInkClock = () => { clock = performance.now() / 1000; };
/** Длительность цикла и сдвиг фазы — свои у каждого штриха: рисунок колышется не в такт */
export const inkMotion = rand => ({ dur: (4.5 + rand() * 3).toFixed(2), begin: (-rand() * 8 - clock).toFixed(2) });
/** Формы для animate: первая повторяется в конце, чтобы цикл замкнулся */
export const inkValues = forms => [...forms, forms[0]].join(';');

export function seeded(text) {
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
    let a = h >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const fmt = n => n.toFixed(2);
const PX1 = { x: 1, y: 1 };

/** Ломаная → точки через равные отрезки (в пикселях) */
function resample(points, px, spacing) {
    const lens = [0];
    for (let i = 1; i < points.length; i++) lens.push(lens[i - 1] + Math.hypot((points[i].x - points[i - 1].x) * px.x, (points[i].y - points[i - 1].y) * px.y));
    const total = lens.at(-1);
    const count = Math.max(2, Math.round(total / spacing));
    const out = [];
    for (let k = 0; k <= count; k++) {
        const L = total * k / count;
        let i = lens.findIndex(l => l >= L);
        if (i <= 0) { out.push({ ...points[0] }); continue; }
        const t = (L - lens[i - 1]) / ((lens[i] - lens[i - 1]) || 1);
        out.push({ x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t });
    }
    return out;
}

/**
 * Линия от руки по ломаной: точки через spacing пикселей со смещением поперёк, сглаженные через середины.
 * Концы дрожат меньше. Возвращает { forms: [d…], points } — формы одной линии: основа общая, у каждой формы своё
 * отклонение, между ними линия «течёт».
 * @param {{x,y}[]} points
 * @param {object} [o]  wobble — дрожь, px; flow — размах течения, px; spacing — шаг точек, px; px — масштаб единиц
 */
export function stroke(points, rand, { wobble = 3.5, flow = 3.5, spacing = 26, px = PX1, forms = INK_FORMS } = {}) {
    const pts = resample(points, px, spacing);
    const base = pts.map((p, i) => {
        const q = pts[Math.min(pts.length - 1, i + 1)], r = pts[Math.max(0, i - 1)];
        const dx = (q.x - r.x) * px.x, dy = (q.y - r.y) * px.y, len = Math.hypot(dx, dy) || 1;
        const end = i === 0 || i === pts.length - 1 ? 0.3 : 1;
        return { p, nx: -dy / len, ny: dx / len, end, shift: end * (rand() - 0.5) * 2 * wobble };
    });
    const shape = extra => {
        const out = base.map((b, i) => {
            const shift = b.shift + b.end * extra[i];
            return { x: b.p.x + b.nx * shift / px.x, y: b.p.y + b.ny * shift / px.y };
        });
        let d = `M ${fmt(out[0].x)} ${fmt(out[0].y)}`;
        if (out.length === 2) return { d: `${d} L ${fmt(out[1].x)} ${fmt(out[1].y)}`, points: out };
        for (let i = 1; i < out.length - 1; i++) {
            const m = { x: (out[i].x + out[i + 1].x) / 2, y: (out[i].y + out[i + 1].y) / 2 };
            d += ` Q ${fmt(out[i].x)} ${fmt(out[i].y)} ${fmt(m.x)} ${fmt(m.y)}`;
        }
        const last = out.at(-1);
        return { d: `${d} L ${fmt(last.x)} ${fmt(last.y)}`, points: out };
    };
    const all = Array.from({ length: forms }, () => shape(base.map(() => (rand() - 0.5) * 2 * flow)));
    return { forms: all.map(f => f.d), points: all[0].points };
}

// Кривая между узлами карты: выходит из узла вверх и входит сверху
function edgePoint(a, b, t) {
    const mid = (a.y + b.y) / 2, u = 1 - t;
    return {
        x: u ** 3 * a.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t ** 3 * b.x,
        y: u ** 3 * a.y + 3 * u * u * t * mid + 3 * u * t * t * mid + t ** 3 * b.y
    };
}

/** Путь между узлами карты: концы не доходят до узлов на trim пикселей */
export function sketchLine(a, b, rand, { trim = 38, wobble = 3.5, flow = 3.5, px = PX1 } = {}) {
    const samples = Array.from({ length: 41 }, (_, i) => edgePoint(a, b, i / 40));
    const lengths = [0];
    for (let i = 1; i < samples.length; i++) lengths.push(lengths[i - 1] + Math.hypot((samples[i].x - samples[i - 1].x) * px.x, (samples[i].y - samples[i - 1].y) * px.y));
    const total = lengths.at(-1);
    const iAt = len => { const i = lengths.findIndex(l => l >= len); return i < 0 ? 40 : i; };
    const i0 = iAt(Math.min(trim, total * 0.4)), i1 = iAt(Math.max(total - trim, total * 0.6));
    return stroke(samples.slice(i0, i1 + 1), rand, { wobble, flow, px });
}

/** Мазок кистью вокруг точки: незамкнутое кольцо, толстое в середине и сходящее на нет к концам (viewBox 0 0 100 100).
 *  Формы отличаются фазой неровностей и нажимом — кольцо медленно «дышит» */
export function brushRing(rand, { radius = 36, width = 6, turns = 1.12 } = {}) {
    const start = rand() * Math.PI * 2, wobbleA = rand() * 6, wobbleB = rand() * 6;
    const form = shift => {
        const outer = [], inner = [], steps = 56;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps, angle = start + shift * 0.12 + t * turns * Math.PI * 2;
            const r = radius + 2.2 * Math.sin(angle * 2 + wobbleA + shift) + 1.2 * Math.sin(angle * 3 + wobbleB - shift * 1.4) + t * 3;
            // Нажим: резкое начало, долгий хвост. Концы не сходят в ноль — иначе тонкий хвост то появляется, то пропадает
            const w = width * (1 + 0.08 * Math.sin(shift * 2 + t * 5)) * (0.35 + 0.65 * Math.min(1, t * 6)) * (0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.1)));
            outer.push(`${fmt(50 + Math.cos(angle) * (r + w / 2))} ${fmt(50 + Math.sin(angle) * (r + w / 2))}`);
            inner.push(`${fmt(50 + Math.cos(angle) * (r - w / 2))} ${fmt(50 + Math.sin(angle) * (r - w / 2))}`);
        }
        return `M ${outer.join(' L ')} L ${inner.reverse().join(' L ')} Z`;
    };
    return Array.from({ length: INK_FORMS }, (_, i) => form(i * 1.1));
}

/** Те же рисунки, но каждое число чуть сдвинуто. Дуги не трогаются: почти замкнутая дуга от малейшего сдвига
 *  конца перескакивает на другую сторону, и круг рвётся */
export function jitterPath(d, rand, amount) {
    let command = '';
    return d.replace(/[a-zA-Z]|-?\d*\.?\d+/g, token => {
        if (/[a-zA-Z]/.test(token)) { command = token; return token; }
        if (/a/i.test(command)) return token;
        return fmt(parseFloat(token) + (rand() - 0.5) * 2 * amount);
    });
}

const SPLINES = 'keyTimes="0;0.333;0.667;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1"';

/**
 * <path> живыми чернилами: формы перетекают одна в другую.
 * @param {string[]} forms
 * @param {object} [o]  cls, style — класс и стиль; draw = { at, dur } — прорисовка пером: штрих проступает
 *                      от начала к концу через at секунд за dur секунд (CSS: .gd-ink-draw)
 */
export function inkSvgPath(forms, rand, { cls = '', style = '', draw = null } = {}) {
    const motion = inkMotion(rand);
    const drawAttrs = draw ? ` pathLength="1" style="--at: ${draw.at.toFixed(2)}s; --dur: ${draw.dur.toFixed(2)}s; ${style}"` : (style ? ` style="${style}"` : '');
    return `<path class="${cls}${draw ? ' gd-ink-draw' : ''}" d="${forms[0]}"${drawAttrs}><animate attributeName="d" values="${inkValues(forms)}" dur="${motion.dur}s" begin="${motion.begin}s" repeatCount="indefinite" calcMode="spline" ${SPLINES}/></path>`;
}

// Рисунки на полях (viewBox 0 0 40 40): то, что кто-то набросал о Разломе
export const DOODLES = [
    // роза ветров
    'M20 3 L23 17 L37 20 L23 23 L20 37 L17 23 L3 20 L17 17 Z M20 9 L20 31 M9 20 L31 20 M11 11 l3 3 M29 11 l-3 3 M11 29 l3 -3 M29 29 l-3 -3',
    // спираль
    'M20 20 c2 -1 3 2 1 4 c-3 3 -8 0 -7 -4 c1 -6 9 -8 13 -3 c5 6 0 14 -7 14 c-9 0 -14 -9 -10 -16 c4 -8 16 -9 21 -2',
    // глаз
    'M3 20 Q20 5 37 20 Q20 35 3 20 Z M20 14 a6 6 0 1 0 0.1 0 M20 18 a2 2 0 1 0 0.1 0 M8 12 l-3 -4 M14 9 l-1 -5 M26 9 l1 -5 M32 12 l3 -4',
    // череп
    'M10 19 a10 10 0 1 1 20 0 v6 h-3 v5 h-14 v-5 h-3 Z M14 18 a3 3 0 1 0 0.1 0 M26 18 a3 3 0 1 0 0.1 0 M18 30 v-4 M22 30 v-4 M20 22 l-1 3 h2 z',
    // щупальце
    'M6 37 C9 25 19 27 17 17 C15 8 23 3 29 7 C34 11 31 17 27 16 C24 15 25 11 28 12 M12 29 a1 1 0 1 0 .1 0 M16 22 a1 1 0 1 0 .1 0 M19 14 a1 1 0 1 0 .1 0',
    // трещины
    'M3 5 L12 14 L9 21 L18 26 L15 36 M12 14 L21 11 L27 16 L35 13 M18 26 L27 29 L31 37 M21 11 L22 4',
    // стрелка и вопрос
    'M5 35 C13 27 17 19 29 9 M29 9 l-8 1 M29 9 l-2 8 M27 25 c0 -5 8 -5 8 0 c0 3 -4 3 -4 7 M31 37 l0 0.5',
    // мотылёк
    'M20 11 v19 M20 14 C10 3 1 14 10 20 C3 27 12 33 20 25 M20 14 C30 3 39 14 30 20 C37 27 28 33 20 25 M19 11 l-4 -6 M21 11 l4 -6',
    // арка двери
    'M9 37 V18 a11 11 0 0 1 22 0 V37 M20 7 V37 M24 24 a1 1 0 1 0 .1 0 M5 37 h30 M12 15 l3 2 M28 15 l-3 2',
    // туман
    'M2 13 q5 -5 10 0 t10 0 t10 0 t7 0 M6 22 q5 -5 10 0 t10 0 t10 0 M2 31 q5 -5 10 0 t10 0 t8 0',
    // руна в круге
    'M20 3 a17 17 0 1 1 -0.1 0 M20 8 L20 32 M20 14 L28 9 M20 20 L12 15 M20 26 L28 21',
    // искры
    'M7 7 l5 5 M12 7 l-5 5 M27 13 l4 4 M31 13 l-4 4 M15 29 l6 6 M21 29 l-6 6 M33 31 l2 2 M35 31 l-2 2'
];
