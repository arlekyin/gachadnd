/**
 * Gacha Roguelike dnd5e — Паутина на WebGL (PIXI 7 — тот же движок, что рисует сцену Foundry)
 *
 * Латунная астролябия в Тумане: кольца зон (край, Заставы, внутренняя зона) медленно вращаются, на них —
 * кристаллы узлов цвета их типа; между узлами — изогнутые нити света. Отряд — янтарный фонарь: его свет
 * выхватывает ближние кристаллы, дальние тонут в Тумане. Куда можно шагнуть — нити янтарные, по ним бежит
 * искра. Выбор узла — щелчок (кристалл загорается), второй щелчок — шаг: фонарь перелетает по нити.
 * Пройденный кристалл потух и треснул; съеденное Пожирателем обвивают чёрно-бирюзовые пряди.
 *
 * new WebStage(canvas, { onStep, canStep, onHover, resizeTo }) → stage.update(model) → stage.destroy().
 * model = { center: {x, y}, size, nodes: [{ id, x, y, type, color, icon, label, state, tier, visited, eaten, touched, labeled }],
 *           edges: [{ a, b, cls }], trail: [id…], next: id|null }
 */

import { playWeb } from "./web-sound.js";

export const VERT = `precision mediump float;
attribute vec2 aVertexPosition; attribute vec2 aUvs;
uniform mat3 translationMatrix; uniform mat3 projectionMatrix;
varying vec2 vUv;
void main() { vUv = aUvs; gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0); }`;

export const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }`;

// Туман: клубится медленно; у центра — отсвет; к правому краю и углам тает клубами. Палитра — униформы:
// у карты сизый с латунью (FOG_MAP), у Терминала — бирюзовая туманность с фиолетовыми прожилками
export const FOG = `precision mediump float;
varying vec2 vUv; uniform float uTime; uniform float uAspect; uniform vec2 uCenter; uniform float uRadius; uniform float uSlide;
uniform vec3 uLow; uniform vec3 uHigh; uniform vec3 uGlow; uniform vec3 uVein;
${NOISE}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y) * 2.2;
  float t = uTime * 0.03;
  float warp = fbm(p * 0.7 - vec2(t, t * 0.5));
  float n = fbm(p + vec2(t * 1.2, -t * 0.6) + warp * 1.6);
  vec3 col = mix(uLow, uHigh, smoothstep(0.3, 0.9, n));
  col += uVein * smoothstep(0.55, 0.85, fbm(p * 1.3 + vec2(5.0, -t))) * 0.6;
  vec2 d = vec2((vUv.x - uCenter.x) * uAspect, vUv.y - uCenter.y);
  float glow = exp(-dot(d, d) / (uRadius * uRadius * 0.7));
  col += uGlow * glow * (0.6 + 0.4 * n);
  float a = 0.93 + 0.05 * n;
  float rr = length(vec2(vUv.x, (vUv.y - 0.5) * 0.95)) + (warp - 0.5) * 0.22 + (n - 0.5) * 0.08;
  float edge = 1.0 - smoothstep(0.56, 1.02, rr);
  edge = edge * edge * (3.0 - 2.0 * edge);
  a *= edge;
  // Появление: Туман наползает слева рваным краем
  a *= 1.0 - smoothstep(uSlide - 0.25, uSlide, vUv.x + (warp - 0.5) * 0.18);
  gl_FragColor = vec4(col * a, a);
}`;

// Пряди Пожирателя вокруг узла: обнимают грани кристалла и вьются спиралью наружу, медленно вращаясь.
// r — «расстояние» по форме кристалла (вытянутый шестигранник): на его гранях r = uInner
const TENDRIL = `precision mediump float;
varying vec2 vUv; uniform float uTime; uniform float uSeed; uniform float uGrow; uniform float uInner;
${NOISE}
void main() {
  vec2 c = vUv - 0.5; vec2 q = c * 2.0 / uInner;
  float hex = max(abs(q.x) / 0.78, (abs(q.y) + abs(q.x)) / 1.2);
  float r = mix(hex * uInner, length(c) * 2.0, smoothstep(uInner * 1.2, 1.0, length(c) * 2.0));
  float a = atan(c.y, c.x);
  float t = uTime * 0.22 + uSeed * 9.0;
  float tw = a + 1.7 * log(max(r, 0.05)) - t * 0.35;
  float f = fbm(vec2(tw * 1.7, r * 3.2 - t) + uSeed * 13.0);
  float strand = pow(max(0.0, sin(tw * 5.0 + f * 5.0 + uSeed * 6.0)), 2.2);
  float hug = smoothstep(uInner - 0.06, uInner + 0.02, r) * (1.0 - smoothstep(uInner + 0.04, uInner + 0.3 + 0.12 * f, r));
  float tail = strand * smoothstep(uInner, uInner + 0.08, r) * (1.0 - smoothstep(uInner + 0.1, 1.0, r * (0.8 + 0.45 * f)));
  // Рост: пряди выползают от граней наружу
  float reach = mix(uInner, 1.0, uGrow);
  float alpha = clamp(hug * (0.75 + 0.45 * f) + tail * 1.1, 0.0, 1.0) * smoothstep(reach + 0.05, reach - 0.1, r) * min(1.0, uGrow * 2.5);
  vec3 col = mix(vec3(0.0, 0.025, 0.028), vec3(0.03, 0.42, 0.4), smoothstep(0.58, 0.95, f) * (1.0 - smoothstep(uInner, 1.0, r)));
  gl_FragColor = vec4(col * alpha, alpha);
}`;

// След Пожирателя: полоса вдоль пути; x — расстояние вдоль следа, y — поперёк. Чёрно-бирюзовые переливы текут
// по следу от его начала к Пожирателю, края — мягкие
const TRAIL = `precision mediump float;
varying vec2 vUv; uniform float uTime; uniform float uReveal; uniform float uHead;
${NOISE}
void main() {
  float across = abs(vUv.y - 0.5) * 2.0;
  float s = vUv.x;
  float t = uTime;
  float f = fbm(vec2(s * 1.4 - t * 0.45, vUv.y * 1.3 + t * 0.08));
  float flow = 0.5 + 0.5 * sin(s * 7.0 - t * 1.8 + f * 5.0);
  float band = smoothstep(0.32, 0.66, f) * (0.3 + 0.7 * flow);
  vec3 deep = vec3(0.0, 0.02, 0.024);
  vec3 teal = vec3(0.07, 0.74, 0.69);
  vec3 col = mix(deep, teal, 0.16 + 0.84 * band);
  col += vec3(0.35, 1.0, 0.95) * pow(band, 3.0) * 0.45 * (1.0 - across);
  float edge = 1.0 - smoothstep(0.45 + 0.25 * f, 1.0, across);
  float a = edge * (0.82 + 0.18 * band) * smoothstep(uReveal + 0.02, uReveal - 0.25, s);
  // Голова следа — яркая бирюза там, где Пожиратель сейчас
  col += vec3(0.2, 0.9, 0.85) * smoothstep(0.5, 0.0, abs(s - uReveal + 0.12)) * (1.0 - across) * 0.6 * uHead;
  gl_FragColor = vec4(col * a, a);
}`;

/**
 * Проявление следа к моменту now: value — докуда виден след, head — яркость бирюзовой головы (тает за 0.8 с
 * после конца), base — тёмная подложка (дорастает вместе со следом, без скачка)
 */
function revealAt({ from, to, start, ms }, now) {
    const k = Math.min(1, (now - start) / ms);
    const value = from + (to - from) * (1 - (1 - k) * (1 - k));
    const after = Math.max(0, now - start - ms);
    const head = from >= to ? 0 : Math.max(0, 1 - after / 800);
    const grown = to > 0 ? Math.min(1, value / to) : 1;
    return { value, head: head * head * (3 - 2 * head), base: from >= to ? 1 : grown };
}

/** Полоса вдоль ломаной pts шириной w; u — расстояние вдоль следа (для шейдера) */
const ribbon = (pts, w, scale) => {
    const pos = [], uvs = [], idx = [];
    let u = 0;
    pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len * w / 2, ny = dx / len * w / 2;
        if (i) u += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) / scale;
        pos.push(p.x + nx, p.y + ny, p.x - nx, p.y - ny);
        uvs.push(u, 0, u, 1);
        if (i) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    });
    const geometry = new PIXI.Geometry().addAttribute('aVertexPosition', pos, 2).addAttribute('aUvs', uvs, 2).addIndex(idx);
    geometry.lengths = pts.map((p, i) => (i ? Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) / scale : 0)).map((v, i, list) => list.slice(0, i + 1).reduce((s, x) => s + x, 0));
    return geometry;
};

/** Палитры Тумана: карта и Терминал занимают одну область, отличаются только цветом */
export const FOG_MAP = { uLow: [0.03, 0.04, 0.05], uHigh: [0.15, 0.17, 0.19], uGlow: [0.16, 0.1, 0.035], uVein: [0, 0, 0] };
export const FOG_TERMINAL = { uLow: [0.025, 0.055, 0.065], uHigh: [0.09, 0.25, 0.26], uGlow: [0.0, 0.11, 0.11], uVein: [0.17, 0.02, 0.22] };

export const quad = (w, h) => new PIXI.Geometry()
    .addAttribute('aVertexPosition', [0, 0, w, 0, w, h, 0, h], 2)
    .addAttribute('aUvs', [0, 0, 1, 0, 1, 1, 0, 1], 2)
    .addIndex([0, 1, 2, 0, 2, 3]);

/** Символ значка Font Awesome по классу (fa-ghost → ) — из стиля ::before */
const GLYPHS = new Map();
function glyph(icon) {
    if (GLYPHS.has(icon)) return GLYPHS.get(icon);
    const el = document.createElement('i');
    el.className = `fas ${icon}`;
    el.style.position = 'absolute'; el.style.visibility = 'hidden';
    document.body.append(el);
    const content = getComputedStyle(el, '::before').content ?? '';
    el.remove();
    const ch = /"(.)/u.exec(content)?.[1] ?? '?';
    GLYPHS.set(icon, ch);
    return ch;
}
const FA = '"Font Awesome 7 Pro", "Font Awesome 6 Pro", "Font Awesome 6 Free", "Font Awesome 5 Free"';

const hex = c => (typeof c === 'number' ? c : parseInt(String(c ?? '#888888').replace('#', ''), 16) || 0x888888);
const shade = (c, k) => {
    const n = hex(c);
    const ch = s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
    return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};
const mixc = (c1, c2, t) => {
    const a = hex(c1), b = hex(c2);
    const ch = s => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
    return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};
/** Стабильное число 0…1 по строке — изгиб нити не меняется между перерисовками */
const seed = str => { let h = 2166136261; for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return ((h >>> 0) % 1000) / 1000; };

// Кристалл: вытянутый шестигранник; грани — светлая слева, тёмная справа, блик сверху
const crystal = r => [0, -1.2 * r, 0.78 * r, -0.42 * r, 0.78 * r, 0.5 * r, 0, 1.2 * r, -0.78 * r, 0.5 * r, -0.78 * r, -0.42 * r];

const AMBER = 0xffb347, EMBER = 0xff8a1e, DIM_AMBER = 0x8a6230, BRASS = 0xb8925a, BONE = 0xf1e6cf, BOSS_RED = 0xc8322a;
// Кольца астролябии (доли радиуса поля): обод, кольцо Застав, внутренняя зона, сердце у Босса
const RINGS = { rim: 1.05, outposts: 0.62, inner: 0.35, core: 0.13 };

export class WebStage {
    constructor(canvas, { onStep, canStep, onHover, resizeTo = window } = {}) {
        this.onStep = onStep; this.canStep = canStep; this.onHover = onHover;
        this.app = new PIXI.Application({ view: canvas, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1, resizeTo });
        this.time = 0;
        this.fog = new PIXI.Mesh(quad(1, 1), PIXI.Shader.from(VERT, FOG, { uTime: 0, uAspect: 1, uCenter: [0.35, 0.5], uRadius: 0.4, uSlide: 1.5, ...FOG_MAP }));
        // Первое появление: Туман слева, потом кристаллы, потом нити между ними
        this.introPending = true;
        this.fog.eventMode = 'static';
        this.fog.on('pointertap', () => this.#select(null));
        this.rings = new PIXI.Container();
        this.lines = new PIXI.Container();
        this.glows = new PIXI.Container();
        this.lantern = new PIXI.Container();
        this.nodesLayer = new PIXI.Container();
        this.fogLayer = new PIXI.Container();
        this.labels = new PIXI.Container();
        this.app.stage.addChild(this.fog, this.rings, this.glows, this.lines, this.lantern, this.nodesLayer, this.fogLayer, this.labels);
        this.nodes = new Map();
        this.tendrils = [];
        this.sparks = [];
        this.still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        this.tick = () => this.#frame(this.app.ticker.deltaMS / 1000);
        this.app.ticker.add(this.tick);
        this.app.renderer.on('resize', () => this.model && this.update(this.model));
    }

    get view() { return this.app.view; }

    destroy() {
        this.app.ticker.remove(this.tick);
        this.app.destroy(false, { children: true, texture: true });
    }

    /** Нарисовать астролябию заново по модели */
    update(model) {
        this.model = model;
        const { width: W, height: H } = this.app.screen;
        this.fog.scale.set(W, H);
        Object.assign(this.fog.shader.uniforms, { uAspect: W / H, uCenter: [model.center.x / W, model.center.y / H], uRadius: model.size / 2 / H });
        for (const layer of [this.rings, this.lines, this.glows, this.lantern, this.nodesLayer, this.fogLayer, this.labels]) layer.removeChildren().forEach(c => c.destroy({ children: true }));
        const prev = this.prev ?? null;
        this.nodes.clear();
        this.edgeDraw = [];
        if (this.introPending) { this.introPending = false; this.intro = { start: performance.now(), popped: new Set() }; playWeb('open'); }
        this.tendrils = [];
        this.sparks = [];
        this.familiar = [];
        this.bursts = [];
        this.bossEye = null;
        this.twitch = [];
        this.selected = null;
        const { size, center } = model;
        const half = size / 2;
        const at = n => ({ x: center.x + (n.x - 50) / 100 * size, y: center.y + (n.y - 50) / 100 * size });
        const R = Math.max(13, Math.min(26, size * 0.027));
        this.R = R;
        const byId = new Map(model.nodes.map(n => [n.id, n]));
        const current = model.nodes.find(n => n.state === 'current');
        const here = current ? at(current) : null;

        this.#drawRings(center, half, model.nodes.filter(n => n.tier === 'seal').map(n => Math.atan2(at(n).y - center.y, at(n).x - center.x)));
        this.#drawClock(center, half, model.boss);

        // Нити: изогнуты, как жилы в породе; ход этого шага — янтарь с бегущей искрой, знакомые тропы — тусклый янтарь
        const curve = (a, b, key) => {
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
            const k = (seed(key) - 0.5) * 0.36;
            return { cx: mx - dy * k, cy: my + dx * k };
        };
        // Изгиб нити между двумя узлами — тот же, в какую сторону ни иди
        const bend = (ida, idb) => {
            const [x, y] = [ida, idb].sort();
            const e = model.edges.find(k => (k.a === x && k.b === y) || (k.a === y && k.b === x));
            const a = at(byId.get(ida)), b = at(byId.get(idb));
            if (!e) return { a, b, c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
            const { cx, cy } = curve(at(byId.get(e.a)), at(byId.get(e.b)), e.a + e.b);
            return { a, b, c: { x: cx, y: cy } };
        };
        const STYLE = { open: [AMBER, 2.4, 1], familiar: [DIM_AMBER, 2, 0.9], traversed: [0x7d6440, 1.8, 0.75], eaten: [0x23302e, 1.6, 0.6], ahead: [0x56616b, 1.3, 0.55] };
        // Путь Пожирателя — сами нити перекрашены в его чёрно-бирюзовый (переливаются по порядку пути);
        // следующий шаг — нить окрашена от него до середины
        const painted = new Map();
        const tr = model.trail ?? [];
        for (let i = 1; i < tr.length; i++) painted.set([tr[i - 1], tr[i]].sort().join('|'), i);
        const devNow = model.devourer ?? tr.at(-1);
        const nextKey = devNow && model.next ? [devNow, model.next].sort().join('|') : null;
        this.devLines = [];
        // Нить, окрашенная чёрно-бирюзовым: та же кривая, но вместо ровной линии — переливающаяся полоса (шейдер следа)
        const devShader = PIXI.Shader.from(VERT, TRAIL, { uTime: this.time, uReveal: 999, uHead: 0 });
        this.trails = [devShader];
        const devRibbon = (P0, C, P2, k = 1, head = false) => {
            const pts = [];
            for (let i = 0; i <= 18; i++) { const t = (i / 18) * k, u = 1 - t; pts.push({ x: u * u * P0.x + 2 * u * t * C.x + t * t * P2.x, y: u * u * P0.y + 2 * u * t * C.y + t * t * P2.y }); }
            const under = new PIXI.Graphics();
            under.lineStyle({ width: 14, color: 0x010808, alpha: 0.65, cap: "round" }).moveTo(pts[0].x, pts[0].y);
            for (const q of pts.slice(1)) under.lineTo(q.x, q.y);
            under.filters = [new PIXI.BlurFilter(3)];
            this.glows.addChild(under);
            const geometry = ribbon(pts, 9, 60);
            const shader = head ? PIXI.Shader.from(VERT, TRAIL, { uTime: this.time, uReveal: geometry.lengths.at(-1), uHead: 1 }) : devShader;
            if (head) this.creeps.push({ shader, reach: geometry.lengths.at(-1) });
            this.lines.addChild(new PIXI.Mesh(geometry, shader));
        };
        this.creeps = [];
        for (const e of model.edges) {
            const key = [e.a, e.b].sort().join('|');
            if (painted.has(key)) {
                const a = at(byId.get(e.a)), b = at(byId.get(e.b)), { cx, cy } = curve(a, b, e.a + e.b);
                devRibbon(a, { x: cx, y: cy }, b);
                continue;
            }
            if (key === nextKey) {
                const a = at(byId.get(e.a)), b = at(byId.get(e.b)), { cx, cy } = curve(a, b, e.a + e.b);
                const g = new PIXI.Graphics();
                g.lineStyle({ width: STYLE.ahead[1], color: STYLE.ahead[0], alpha: STYLE.ahead[2], cap: 'round' }).moveTo(a.x, a.y).quadraticCurveTo(cx, cy, b.x, b.y);
                // Половина от Пожирателя — окрашена, с яркой головой
                const fromDev = e.a === devNow, P0 = fromDev ? a : b, P2 = fromDev ? b : a;
                this.lines.addChild(g);
                devRibbon(P0, { x: cx, y: cy }, P2, 0.55, true);
                continue;
            }
            const a = at(byId.get(e.a)), b = at(byId.get(e.b));
            const { cx, cy } = curve(a, b, e.a + e.b);
            const [color, width, alpha] = STYLE[e.cls] ?? STYLE.ahead;
            const g = new PIXI.Graphics();
            g.lineStyle({ width, color, alpha, cap: 'round' }).moveTo(a.x, a.y).quadraticCurveTo(cx, cy, b.x, b.y);
            this.lines.addChild(g);
            // Нить прорастает от узла, что ближе к центру, наружу
            const da = Math.hypot(a.x - center.x, a.y - center.y), db = Math.hypot(b.x - center.x, b.y - center.y);
            this.edgeDraw.push({ g, a: da <= db ? a : b, b: da <= db ? b : a, c: { x: cx, y: cy }, width, color, alpha, x: Math.min(da, db) / half });
            // Знакомые тропы этого шага — лёгкая пульсация: по пройденному можно пройти снова
            if (e.cls === 'familiar') {
                const glow = new PIXI.Graphics();
                glow.lineStyle({ width: 7, color: DIM_AMBER, alpha: 0.6, cap: 'round' }).moveTo(a.x, a.y).quadraticCurveTo(cx, cy, b.x, b.y);
                glow.filters = [new PIXI.BlurFilter(4)];
                this.glows.addChild(glow);
                this.familiar.push({ glow, line: g, phase: seed(e.a + e.b) });
            }
            if (e.cls === 'open') {
                const glow = new PIXI.Graphics();
                glow.lineStyle({ width: 9, color: EMBER, alpha: 0.35, cap: 'round' }).moveTo(a.x, a.y).quadraticCurveTo(cx, cy, b.x, b.y);
                glow.filters = [new PIXI.BlurFilter(5)];
                this.glows.addChild(glow);
                // Искра бежит от отряда к узлу
                const from = byId.get(e.a).state === 'current' || byId.get(e.a).state === 'visited' ? [a, b] : [b, a];
                const spark = new PIXI.Graphics();
                spark.beginFill(0xfff1c9, 1).drawCircle(0, 0, 2.6).endFill();
                spark.beginFill(AMBER, 0.45).drawCircle(0, 0, 6).endFill();
                spark.filters = [new PIXI.BlurFilter(1.2)];
                this.lines.addChild(spark);
                this.sparks.push({ g: spark, p0: from[0], p1: from[1], c: { x: cx, y: cy }, phase: seed(e.b + e.a) });
            }
        }
        const devId = devNow;
        // Где он сейчас — тёмный вихрь крупнее прядей съеденного
        this.devourerAt = devId && byId.get(devId) ? at(byId.get(devId)) : null;

        this.reveal = null;

        // Фонарь отряда: тёплый ореол; при смене узла летит по нитям пути (знакомые тропы — через все узлы)
        if (here) {
            const halo = new PIXI.Graphics();
            halo.beginFill(AMBER, 0.22).drawCircle(0, 0, R * 5).endFill();
            halo.beginFill(EMBER, 0.25).drawCircle(0, 0, R * 2.4).endFill();
            halo.filters = [new PIXI.BlurFilter(R * 1.3)];
            this.lantern.addChild(halo);
            const moved = prev?.current && prev.current !== current.id;
            let legs = [];
            if (moved) {
                const path = prev.paths?.[current.id] ?? [current.id];
                let last = prev.current;
                for (const id of path) {
                    legs.push(byId.has(last) && byId.has(id) ? bend(last, id) : { a: prev.here, b: here, c: { x: (prev.here.x + here.x) / 2, y: (prev.here.y + here.y) / 2 } });
                    last = id;
                }
            } else if (prev?.here && !prev.current) legs = [];
            const start = legs[0]?.a ?? (this.flight?.to === current.id ? this.lantern.position : here);
            this.lantern.position.set(start.x, start.y);
            if (legs.length) {
                this.flight = { legs, start: performance.now(), leg: 420, to: current.id };
                playWeb('step', legs.length);
                this.lastLegs = legs.length;
            } else if (this.flight?.to !== current.id) this.flight = null;
        }

        // Кристаллы; новые съеденные — вспыхивают и обрастают прядями, когда до них дойдёт голова следа
        const wasEaten = new Set(prev?.eaten ?? []);
        this.biting ??= new Map();
        for (const [id, b] of this.biting) if (b.done) this.biting.delete(id);
        for (const n of model.nodes) if (n.eaten && prev && !wasEaten.has(n.id) && !this.biting.has(n.id)) {
            this.biting.set(n.id, { start: null, done: false });
            this.biteCount = (this.biteCount ?? 0) + 1;
        }
        for (const n of model.nodes) {
            const p = at(n);
            const scale = { boss: 1.5, seal: 1.12, major: 1.05, minor: 0.92 }[n.tier] ?? 1;
            const visited = !!n.visited && !n.eaten;
            const r = R * scale * (visited ? 0.82 : 1);
            // Свет фонаря: ближние кристаллы ясные, дальние тонут в Тумане
            const lit = here ? Math.max(0.5, 1 - Math.max(0, Math.hypot(p.x - here.x, p.y - here.y) - R * 6) / (size * 0.9)) : 0.85;
            const node = new PIXI.Container();
            node.position.set(p.x, p.y);
            const col = n.type === 'boss' ? BOSS_RED : n.tier === 'seal' ? BRASS : hex(n.color);
            const glow = new PIXI.Graphics();
            glow.beginFill(n.type === 'boss' ? BOSS_RED : AMBER, 1).drawCircle(0, 0, r * 1.5).endFill();
            glow.filters = [new PIXI.BlurFilter(r * 0.7)];
            glow.alpha = n.type === 'boss' ? 0.35 : n.state === 'reachable' && !visited ? 0.45 : 0;
            const shape = crystal(r);
            const gem = new PIXI.Graphics();
            const isBoss = n.type === 'boss' && !!model.boss;
            const body = isBoss ? 0xd8382a : visited ? mixc(shade(col, 0.45), 0x2a2724, 0.65) : n.state === 'locked' ? shade(col, 0.55) : shade(col, 0.8);
            gem.beginFill(0x000000, 0.45).drawPolygon(shape.map((v, i) => v + (i % 2 ? 3 : 1.5))).endFill();
            gem.beginFill(body, 1).lineStyle({ width: 1.4, color: visited ? 0x5d5547 : mixc(col, 0xffffff, 0.45), alpha: 0.9 }).drawPolygon(shape).endFill();
            gem.lineStyle(0);
            // Грани: левая светлее, правая темнее, верхний блик
            gem.beginFill(0xffffff, visited ? 0.04 : 0.16).drawPolygon([0, -1.2 * r, -0.78 * r, -0.42 * r, -0.78 * r, 0.5 * r, 0, 1.2 * r, -0.22 * r, 0.1 * r]).endFill();
            gem.beginFill(0x000000, 0.22).drawPolygon([0, -1.2 * r, 0.78 * r, -0.42 * r, 0.78 * r, 0.5 * r, 0, 1.2 * r, 0.22 * r, 0.1 * r]).endFill();
            if (!visited) gem.beginFill(0xffffff, 0.35).drawPolygon([0, -1.2 * r, -0.36 * r, -0.62 * r, 0, -0.5 * r, 0.3 * r, -0.66 * r]).endFill();
            if (n.eaten) gem.tint = 0x6f8382;
            // Пройденный — трещина через кристалл
            if (visited) gem.lineStyle({ width: 1.3, color: 0x15120f, alpha: 0.9 }).moveTo(-0.5 * r, -0.7 * r).lineTo(-0.1 * r, -0.2 * r).lineTo(-0.3 * r, 0.15 * r).lineTo(0.25 * r, 0.75 * r);
            const icon = new PIXI.Text(glyph(n.icon), {
                fontFamily: FA, fontWeight: '900', fontSize: Math.round(r * 0.8), fill: BONE,
                dropShadow: true, dropShadowColor: 0x000000, dropShadowBlur: 3, dropShadowDistance: 1, dropShadowAlpha: 0.9
            });
            icon.anchor.set(0.5);
            icon.alpha = visited ? 0.38 : n.eaten ? 0.7 : 1;
            // Куда можно — латунная оправа вокруг кристалла; отряд — светлая
            const rim = new PIXI.Graphics();
            if (n.state === 'reachable') rim.lineStyle({ width: visited ? 1.4 : 2.2, color: visited ? DIM_AMBER : AMBER, alpha: 1 }).drawPolygon(crystal(r * 1.22));
            if (n.state === 'current') rim.lineStyle({ width: 2.4, color: 0xfff1c9, alpha: 1 }).drawPolygon(crystal(r * 1.22));
            // Выбор: грани загораются по одной
            const facets = new PIXI.Graphics();
            node.addChild(glow, gem);
            if (isBoss) { this.#bossEye(node, r, model.boss, p, gem); icon.visible = false; }
            node.addChild(icon, rim, facets);
            node.alpha = (n.state === 'locked' ? 0.85 : 1) * lit;
            // Учуян Пожирателем: порча ползёт по кристаллу со стороны Пожирателя; 2 шага — до середины, 1 — почти доверху
            if (n.touched) this.#infect(node, n, p, r, model, at, byId);
            node.eventMode = 'static';
            node.cursor = 'pointer';
            node.hitArea = new PIXI.Polygon(crystal(r * 1.3));
            node.on('pointerover', () => { node.scale.set(1.1); this.onHover?.(n, p, r * 1.2); playWeb('hover', null, { throttle: 70 }); });
            node.on('pointerout', () => { node.scale.set(1); this.onHover?.(null); });
            node.on('pointertap', event => { event.stopPropagation(); this.#tap(n); });
            this.nodesLayer.addChild(node);
            this.nodes.set(n.id, { node, glow, facets, data: n, r, lit, base: node.alpha, x: Math.hypot(p.x - center.x, p.y - center.y) / half });
            // Пожиратель здесь: тёмная воронка и крупный быстрый вихрь прядей
            if (n.id === (model.devourer ?? model.trail?.at(-1)) && (model.devourer || model.trail?.length)) {
                const pit = new PIXI.Graphics();
                pit.beginFill(0x010605, 0.75).drawCircle(p.x, p.y, r * 2).endFill();
                pit.filters = [new PIXI.BlurFilter(r * 0.6)];
                this.glows.addChild(pit);
                const Q = r * 8;
                const vortex = new PIXI.Mesh(quad(Q, Q), PIXI.Shader.from(VERT, TENDRIL, { uTime: 0, uSeed: 0.37, uGrow: 1, uInner: (r * 1.1 / (Q / 2)) }));
                vortex.position.set(p.x - Q / 2, p.y - Q / 2);
                vortex.speed = 2.4;
                this.fogLayer.addChild(vortex);
                this.tendrils.push(vortex);
            }
            if (n.eaten) {
                const Q = r * 4.6;
                const mesh = new PIXI.Mesh(quad(Q, Q), PIXI.Shader.from(VERT, TENDRIL, { uTime: 0, uSeed: (p.x * 0.013 + p.y * 0.007) % 1, uGrow: 1, uInner: (r * 1.05 / (Q / 2)) }));
                mesh.position.set(p.x - Q / 2, p.y - Q / 2);
                this.fogLayer.addChild(mesh);
                this.tendrils.push(mesh);
                const bite = this.biting.get(n.id);
                if (bite) {
                    mesh.shader.uniforms.uGrow = 0;
                    const burst = new PIXI.Graphics();
                    burst.position.set(p.x, p.y);
                    this.glows.addChild(burst);
                    const i = this.reveal?.ids.lastIndexOf(n.id) ?? -1;
                    this.bursts.push({ mesh, burst, node, r, at: i >= 0 ? this.reveal.lengths[i] : 0, bite });
                }
            }
            // Подпись — только у отряда и Босса; остальное — подсказкой при наведении
            if (n.state === 'current') {
                const label = new PIXI.Text(n.label, { fontFamily: 'Modesto Condensed, Signika, serif', fontSize: Math.round(R * 0.85), fill: n.type === 'boss' ? 0xe8a49c : 0xffdca0, stroke: 0x000000, strokeThickness: 4, letterSpacing: 0.5 });
                label.anchor.set(0.5, 0);
                label.position.set(p.x, p.y + r * 1.3 + 4);
                this.labels.addChild(label);
            }
        }
        this.#remember(model, here);
    }

    /** Что было нарисовано — для анимации переходов при следующей перерисовке */
    #remember(model, here) {
        const current = model.nodes.find(n => n.state === 'current');
        this.prev = {
            current: current?.id ?? null, here,
            paths: Object.fromEntries(model.nodes.filter(n => n.path).map(n => [n.id, n.path])),
            trail: model.trail ?? [], eaten: model.nodes.filter(n => n.eaten).map(n => n.id),
            bossTicks: model.boss?.ticks, bossStage: model.boss?.stage
        };
    }

    /**
     * Заражение учуянного узла: тёмное пятно и бирюзово-чёрные прожилки внутри кристалла (маской по его форме) от края,
     * обращённого к Пожирателю; снизу — короткие пряди. Чем меньше шагов до поедания, тем дальше порча и гуще пряди;
     * в последний шаг кристалл подёргивается.
     */
    #infect(node, n, p, r, model, at, byId) {
        const left = Math.max(1, Math.min(2, n.touched)), k = left >= 2 ? 0.5 : 0.88;
        const dev = model.trail?.length ? byId.get(model.trail.at(-1)) : null;
        const dp = dev ? at(dev) : { x: p.x, y: p.y + r * 4 };
        const a = Math.atan2(dp.y - p.y, dp.x - p.x), ux = Math.cos(a), uy = Math.sin(a);
        const shape = crystal(r), mask = new PIXI.Graphics();
        mask.beginFill(0xffffff).drawPolygon(shape).endFill();
        const rot = new PIXI.Graphics();
        rot.mask = mask;
        // Тёмное пятно от края к центру
        const ex = ux * r * 0.9, ey = uy * r * 1.1;
        for (let i = 0; i < 5; i++) rot.beginFill(0x020e0d, 0.16 * k).drawCircle(ex * (1 - i * 0.12 * k), ey * (1 - i * 0.12 * k), r * (0.4 + i * 0.14 * k)).endFill();
        // Под значком, поверх тела кристалла
        node.addChildAt(mask, 2);
        node.addChildAt(rot, 2);
        // Короткие пряди — тот же шейдер, что у съеденного, но слабее
        const Q = r * 3.6;
        const mesh = new PIXI.Mesh(quad(Q, Q), PIXI.Shader.from(VERT, TENDRIL, { uTime: 0, uSeed: seed(n.id), uGrow: left >= 2 ? 0.4 : 0.65, uInner: (r * 1.05 / (Q / 2)) }));
        mesh.position.set(p.x - Q / 2, p.y - Q / 2);
        this.fogLayer.addChild(mesh);
        this.tendrils.push(mesh);
        if (left < 2) (this.twitch ??= []).push({ node, x: p.x, y: p.y, s: seed(n.id) * 10 });
    }

    /**
     * Глаз Босса в кристалле: без ступеней закрыт (спит, веко чуть дышит), с каждой ступенью приоткрывается,
     * на полной — открыт, зрачок горит. Зрачок следит за фонарём отряда (и во время его перелёта). Изредка моргает.
     * Новая ступень — веко поднимается после того, как долетят искры.
     */
    #bossEye(node, r, boss, pos, gem) {
        const max = Math.max(1, boss.stages.length), to = Math.min(1, boss.stage / max);
        // Грани: шесть треугольников от центра — у каждой свой тон (свет сверху слева), рёбра светлее
        const V = [[0, -1.2], [0.78, -0.42], [0.78, 0.5], [0, 1.2], [-0.78, 0.5], [-0.78, -0.42]].map(([x, y]) => [x * r, y * r]);
        const facets = new PIXI.Graphics(), cx = -0.06 * r, cy = -0.08 * r;
        const tones = [0.34, 0.08, -0.18, -0.34, -0.12, 0.2];
        V.forEach((a, i) => {
            const b = V[(i + 1) % 6], k = tones[i];
            facets.beginFill(k > 0 ? 0xffffff : 0x000000, Math.abs(k) * 0.55).drawPolygon([cx, cy, a[0], a[1], b[0], b[1]]).endFill();
        });
        facets.lineStyle({ width: 1, color: 0xffe0d0, alpha: 0.35 });
        for (const [x, y] of V) facets.moveTo(cx, cy).lineTo(x, y);
        // Блики на рёбрах верхней левой стороны
        facets.lineStyle({ width: 2, color: 0xffffff, alpha: 0.55, cap: 'round' }).moveTo(V[5][0] * 0.95, V[5][1] * 0.95).lineTo(V[0][0], V[0][1] * 0.95);
        facets.lineStyle({ width: 1.4, color: 0xffffff, alpha: 0.35, cap: 'round' }).moveTo(V[4][0] * 0.96, V[4][1] * 0.9).lineTo(V[5][0] * 0.96, V[5][1] * 0.9);
        // Свечение изнутри — за глазом, сильнее с пробуждением
        const inner = new PIXI.Graphics();
        inner.beginFill(0xff6a3a, 1).drawEllipse(0, 0.05 * r, 0.62 * r, 0.75 * r).endFill();
        inner.filters = [new PIXI.BlurFilter(r * 0.35)];
        inner.blendMode = PIXI.BLEND_MODES.ADD;
        // Бегущий отсвет по граням — полоса света, маской по форме кристалла
        const sheen = new PIXI.Graphics(), sheenMask = new PIXI.Graphics();
        sheenMask.beginFill(0xffffff).drawPolygon(V.flat()).endFill();
        sheen.mask = sheenMask;
        sheen.blendMode = PIXI.BLEND_MODES.ADD;
        const glow = new PIXI.Graphics(), lid = new PIXI.Graphics(), mask = new PIXI.Graphics(), iris = new PIXI.Graphics(), lines = new PIXI.Graphics();
        glow.filters = [new PIXI.BlurFilter(r * 0.25)];
        iris.mask = mask;
        node.addChild(facets, inner, sheen, sheenMask, glow, lid, iris, mask, lines);
        const from = Math.min(1, (this.prev?.bossStage ?? boss.stage) / max), rising = from < to;
        this.bossEye = { glow, lid, mask, iris, lines, r, pos, from: rising ? from : to, to, start: performance.now() + (rising ? 900 : 0), full: to >= 1, aura: node.children[0], gem, inner, sheen, sheenAt: performance.now() + 1500, blinkAt: performance.now() + 3000 + Math.random() * 4000 };
        this.#drawEye(rising ? from : to, 0);
    }

    #drawEye(open, blink) {
        const e = this.bossEye;
        if (!e || e.lid.destroyed) return;
        const r = e.r, w = 0.62 * r, h = Math.max(0.02, (0.06 + 0.94 * open) * (1 - blink)) * 0.42 * r;
        const almond = g => g.moveTo(-w, 0).quadraticCurveTo(0, -h * 2, w, 0).quadraticCurveTo(0, h * 2, -w, 0);
        e.lid.clear(); e.mask.clear(); e.iris.clear(); e.lines.clear(); e.glow.clear();
        const awake = open > 0.04 && h > 0.04 * r;
        if (awake) {
            e.lid.beginFill(0xf2d6b8, 0.95); almond(e.lid); e.lid.endFill();
            e.mask.beginFill(0xffffff); almond(e.mask); e.mask.endFill();
            // Взгляд — к фонарю отряда
            const lx = this.lantern.position.x - e.pos.x, ly = this.lantern.position.y - e.pos.y, d = Math.hypot(lx, ly) || 1;
            const reach = 0.24 * r * Math.min(1, d / (r * 4));
            const px = (lx / d) * reach, py = (ly / d) * reach * 0.5;
            const ir = 0.27 * r;
            e.iris.beginFill(0x8a1a12).drawCircle(px, py, ir).endFill();
            e.iris.beginFill(0xff5a30, 0.85).drawCircle(px - ir * 0.15, py - ir * 0.15, ir * 0.7).endFill();
            e.iris.beginFill(0x1a0504).drawEllipse(px, py, 0.065 * r, 0.21 * r).endFill();
            e.iris.beginFill(0xffffff, 0.7).drawCircle(px - ir * 0.4, py - ir * 0.45, ir * 0.18).endFill();
            if (e.full) { e.glow.beginFill(0xff5a30, 0.55 + 0.45 * Math.sin(performance.now() / 300)).drawCircle(px, py, ir * 1.4).endFill(); }
            e.lines.lineStyle({ width: 1.8, color: 0x5a0e0a, alpha: 1 }); almond(e.lines);
        } else {
            // Спит: сомкнутое веко с ресницами
            e.lines.lineStyle({ width: 2, color: 0xe8a090, alpha: 0.9, cap: 'round' }).moveTo(-w, 0).quadraticCurveTo(0, 0.14 * r, w, 0);
            for (const t of [-0.5, -0.15, 0.2, 0.55]) e.lines.moveTo(t * w, 0.05 * r).lineTo(t * w - 0.02 * r, 0.16 * r);
        }
        e.open = open;
    }

    /** Латунные кольца: обод с делениями, кольцо Застав с засовами, пунктир внутренней зоны, сердце у Босса */
    #drawRings(center, half, seals) {
        const ring = (radius, draw) => {
            const c = new PIXI.Container();
            c.position.set(center.x, center.y);
            const g = new PIXI.Graphics();
            draw(g, radius * half);
            c.addChild(g);
            this.rings.addChild(c);
            return c;
        };
        this.rim = ring(RINGS.rim, (g, r) => {
            g.lineStyle({ width: 1.6, color: BRASS, alpha: 0.42 }).drawCircle(0, 0, r);
            g.lineStyle({ width: 0.8, color: BRASS, alpha: 0.3 }).drawCircle(0, 0, r - 13);
        });
        this.outpostRing = ring(RINGS.outposts, (g, r) => {
            g.lineStyle({ width: 2.2, color: BRASS, alpha: 0.38 }).drawCircle(0, 0, r);
            g.lineStyle({ width: 0.8, color: BRASS, alpha: 0.25 }).drawCircle(0, 0, r + 5).drawCircle(0, 0, r - 5);
        });
        // Засовы Застав: на кольце, у каждой Заставы — две скобы (кольцо с засовами не вращается)
        const bolts = new PIXI.Graphics();
        bolts.position.set(center.x, center.y);
        for (const a of seals) for (const s of [-1, 1]) {
            const b = a + s * 0.11, r = RINGS.outposts * half;
            bolts.lineStyle({ width: 3, color: BRASS, alpha: 0.65, cap: 'round' })
                .moveTo(Math.cos(b) * (r - 9), Math.sin(b) * (r - 9)).lineTo(Math.cos(b) * (r + 9), Math.sin(b) * (r + 9));
        }
        this.rings.addChild(bolts);
        this.innerRing = ring(RINGS.inner, (g, r) => {
            for (let i = 0; i < 72; i++) {
                const a = i / 72 * Math.PI * 2;
                g.beginFill(BRASS, i % 6 === 0 ? 0.55 : 0.28).drawCircle(Math.cos(a) * r, Math.sin(a) * r, i % 6 === 0 ? 2 : 1.1).endFill();
            }
        });
        this.core = null;
    }

    /**
     * Часы этажа на ободе (всё — снаружи поля, щелчки проходят насквозь): гравированная шкала — по шагу на крупную
     * риску; пройденная часть раскалена (латунь в тишине, жар после); указатель — снаружи обода; медальоны ступеней —
     * за ободом (пройденные горят, следующий тлеет). Вокруг Босса — сегменты-ступени.
     */
    #drawClock(center, half, boss) {
        if (!boss) return;
        const clock = new PIXI.Container();
        clock.position.set(center.x, center.y);
        clock.eventMode = 'passive';
        this.rings.addChild(clock);
        // Полный круг — шаг последней ступени: дальше Босс в полной силе и считать нечего (указатель встаёт наверху)
        const last = boss.stages.at(-1)?.at ?? boss.calm + 1, R0 = RINGS.rim * half, N = Math.max(last, 4);
        const shown = Math.min(boss.ticks, N), full = boss.ticks >= N && boss.stages.length > 0;
        boss = { ...boss, ticks: shown };
        const ang = t => -Math.PI / 2 + (t / N) * Math.PI * 2;
        this.clock = { N, ang, R0, center, boss, full };
        const arc = (g, t0, t1, r) => { const a0 = ang(t0), a1 = ang(Math.max(t0, t1)); g.arc(0, 0, r, a0, a1); };
        // Жар под пройденной шкалой
        const heat = new PIXI.Graphics();
        heat.lineStyle({ width: 18, color: 0xe2b060, alpha: 0.3 }); arc(heat, 0, Math.min(boss.ticks, boss.calm), R0 - 6);
        if (boss.ticks > boss.calm) { heat.moveTo(Math.cos(ang(boss.calm)) * (R0 - 6), Math.sin(ang(boss.calm)) * (R0 - 6)); heat.lineStyle({ width: 24, color: 0xff4a20, alpha: 0.6 }); arc(heat, boss.calm, boss.ticks, R0 - 6); }
        heat.filters = [new PIXI.BlurFilter(8)];
        clock.addChild(heat);
        // Раскалённая линия по ободу — чёткая, поверх жара
        const hot = new PIXI.Graphics();
        hot.lineStyle({ width: 2.5, color: 0xf2c98a, alpha: 0.95 }); arc(hot, 0, Math.min(boss.ticks, boss.calm), R0);
        if (boss.ticks > boss.calm) { hot.moveTo(Math.cos(ang(boss.calm)) * R0, Math.sin(ang(boss.calm)) * R0); hot.lineStyle({ width: 3, color: 0xff7a3a, alpha: 1 }); arc(hot, boss.calm, boss.ticks, R0); }
        clock.addChild(hot);
        this.hotLine = hot;
        // Круг замкнулся — весь обод горит и медленно дышит
        if (full) {
            const ring = new PIXI.Graphics();
            ring.lineStyle({ width: 26, color: 0xff3a1a, alpha: 0.5 }).drawCircle(0, 0, R0 - 4);
            ring.filters = [new PIXI.BlurFilter(10)];
            clock.addChildAt(ring, 0);
            this.fullRing = ring;
        } else this.fullRing = null;
        // Шкала: 5 рисок на шаг, крупная — каждый шаг
        const scale = new PIXI.Graphics();
        for (let i = 0; i < N * 5; i++) {
            const t = i / 5, a = ang(t), step = i % 5 === 0, l = step ? 11 : 5, passed = t <= boss.ticks;
            const k = Math.min(1, Math.max(0, (t - boss.calm) / Math.max(1, boss.every * boss.stages.length)));
            const col = !passed ? 0x5a5045 : t < boss.calm ? 0xe2b874 : mixc(0xff9a50, 0xff3a1a, k);
            scale.lineStyle({ width: step ? 2.6 : 1.4, color: col, alpha: passed ? 1 : 0.6, cap: 'round' })
                .moveTo(Math.cos(a) * R0, Math.sin(a) * R0).lineTo(Math.cos(a) * (R0 - l), Math.sin(a) * (R0 - l));
        }
        clock.addChild(scale);
        // Указатель — латунная метка снаружи обода, с угольком у шкалы
        const pointer = new PIXI.Container();
        const pg = new PIXI.Graphics();
        pg.beginFill(0xc9a063).lineStyle({ width: 1.2, color: 0x5a4020 }).drawPolygon([R0 + 2, 0, R0 + 15, 8, R0 + 27, 6, R0 + 27, -6, R0 + 15, -8]).endFill();
        const ember = new PIXI.Graphics();
        ember.beginFill(0xff8a50, 1).drawCircle(R0 - 2, 0, 5).endFill();
        ember.filters = [new PIXI.BlurFilter(3)];
        pointer.addChild(ember, pg);
        const fromTicks = Math.min(this.prev?.bossTicks ?? boss.ticks, N);
        pointer.rotation = ang(fromTicks);
        clock.addChild(pointer);
        this.pointer = { g: pointer, from: ang(fromTicks), to: ang(boss.ticks), start: performance.now() };
        // Медальоны ступеней за ободом
        this.medals = [];
        this.medalBox = [];
        boss.stages.forEach((st, i) => {
            const a = ang(st.at), on = i < boss.stage, next = i === boss.stage, rr = R0 + 44, mr = Math.max(13, this.R * 0.7);
            const m = new PIXI.Container();
            m.position.set(Math.cos(a) * rr, Math.sin(a) * rr);
            const g = new PIXI.Graphics();
            g.lineStyle({ width: 1.5, color: on ? 0xffb070 : 0x6b5634, alpha: 1 }).moveTo(Math.cos(a) * -(rr - R0), Math.sin(a) * -(rr - R0)).lineTo(Math.cos(a) * -mr, Math.sin(a) * -mr);
            if (on) { const glow = new PIXI.Graphics(); glow.beginFill(0xff4a20, 0.4).drawCircle(0, 0, mr + 7).endFill(); glow.filters = [new PIXI.BlurFilter(6)]; m.addChild(glow); }
            g.beginFill(on ? 0x6a1408 : 0x1e1a17).lineStyle({ width: on ? 2 : 1.4, color: on ? 0xffb070 : next ? 0xc86a40 : 0x6b5634 }).drawCircle(0, 0, mr).endFill();
            const icon = new PIXI.Text(glyph(st.icon), { fontFamily: FA, fontWeight: '900', fontSize: Math.round(mr * 0.85), fill: on ? 0xffe0c8 : next ? 0xc88a6a : 0x6b5f52 });
            icon.anchor.set(0.5);
            m.addChild(g, icon);
            m.eventMode = 'static';
            m.cursor = 'help';
            m.hitArea = new PIXI.Circle(0, 0, mr + 2);
            const screen = { x: center.x + m.position.x, y: center.y + m.position.y };
            m.on('pointerover', () => this.onHover?.({ medal: true, label: st.name, text: st.text, on, next, toNext: boss.toNext, gm: boss.gm, at: st.at }, screen, mr));
            m.on('pointerout', () => this.onHover?.(null));
            clock.addChild(m);
            if (next) this.medals.push(g);
            (this.medalBox ??= [])[i] = m;
        });
        this.heartGlow = null;
        this.heartFx = null;
        // Новая ступень с прошлого раза — волна от Босса по фону и удар
        if (this.prev && (this.prev.bossStage ?? boss.stage) < boss.stage) {
            const k = boss.stage - 1, medal = this.medalBox[k];
            const flash = new PIXI.Graphics(), sparks = new PIXI.Graphics(), seg = new PIXI.Graphics();
            flash.filters = [new PIXI.BlurFilter(6)]; seg.filters = [new PIXI.BlurFilter(4)];
            clock.addChild(seg, sparks, flash);
            const from = medal ? { x: medal.position.x, y: medal.position.y } : { x: 0, y: -R0 };
            const R = { range: (a, b) => a + Math.random() * (b - a) };
            const embers = Array.from({ length: 14 }, () => ({ d: R.range(0, 0.25), s: R.range(0.7, 1.3), off: R.range(-1, 1) * R0 * 0.18 }));
            this.ignite = { start: performance.now(), medal, from, flash, sparks, seg, k, embers };
            playWeb('stage');
        }
    }

    /** Щелчок: первый — выбрать (кристалл загорается), второй по тому же — шаг */
    #tap(n) {
        if (!this.canStep?.(n)) { playWeb('denied'); return this.onStep?.(n.id, false); }
        if (this.selected === n.id) { this.#select(null); return this.onStep?.(n.id, true); }
        this.#select(n.id);
    }

    #select(id) {
        if (this.selected) this.nodes.get(this.selected)?.facets.clear();
        this.selected = id;
        this.selectStart = performance.now();
        if (id) playWeb('select');
        this.onSelect?.(id ? this.nodes.get(id)?.data : null);
    }

    /**
     * Появление слоя: Туман наползает слева (0–0.8 с), кольца проступают, кристаллы всплывают от Босса к ободу
     * (0.45–1.4 с), затем нити прорастают от центра наружу (1.2–2.2 с). Искры и свечение хода — после.
     */
    #introFrame(now) {
        const T = now - this.intro.start;
        const clamp = v => Math.max(0, Math.min(1, v));
        const ease = k => 1 - (1 - k) ** 3;
        const back = k => 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;
        this.fog.shader.uniforms.uSlide = -0.1 + 1.6 * ease(clamp(T / 800));
        this.rings.alpha = ease(clamp((T - 250) / 700));
        for (const [id, { node, base, x }] of this.nodes) {
            const k = clamp((T - 450 - Math.min(1, x) * 650) / 320);
            if (k > 0 && !this.intro.popped.has(id)) { this.intro.popped.add(id); playWeb('pop', x, { throttle: 55 }); }
            node.alpha = base * k;
            node.scale.set(k ? back(k) : 0.01);
        }
        if (T > 1200 && !this.intro.threads) { this.intro.threads = true; playWeb('threads'); }
        const nodesIn = clamp((T - 900) / 400);
        this.fogLayer.alpha = nodesIn;
        this.labels.alpha = nodesIn;
        this.lantern.alpha = nodesIn;
        for (const e of this.edgeDraw) {
            const k = ease(clamp((T - 1200 - Math.min(1, e.x) * 500) / 520));
            const { g, a, b, c } = e;
            g.clear();
            if (!k) continue;
            // Кривая до доли k: контрольная точка и конец по де Кастельжо
            const c1 = { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k };
            const u = 1 - k;
            const end = { x: u * u * a.x + 2 * u * k * c.x + k * k * b.x, y: u * u * a.y + 2 * u * k * c.y + k * k * b.y };
            g.lineStyle({ width: e.width, color: e.color, alpha: e.alpha, cap: 'round' }).moveTo(a.x, a.y).quadraticCurveTo(c1.x, c1.y, end.x, end.y);
        }
        const after = clamp((T - 1900) / 500);
        this.glows.alpha = after;
        for (const sp of this.sparks) sp.g.visible = after > 0;
        for (const mesh of this.lines.children) if (mesh instanceof PIXI.Mesh) mesh.alpha = after;
        if (T > 2500) {
            this.intro = null;
            for (const e of this.edgeDraw) e.g.clear().lineStyle({ width: e.width, color: e.color, alpha: e.alpha, cap: 'round' }).moveTo(e.a.x, e.a.y).quadraticCurveTo(e.c.x, e.c.y, e.b.x, e.b.y);
            for (const { node, base } of this.nodes.values()) { node.alpha = base; node.scale.set(1); }
            for (const layer of [this.rings, this.glows, this.fogLayer, this.labels, this.lantern]) layer.alpha = 1;
            for (const sp of this.sparks) sp.g.visible = true;
            for (const mesh of this.lines.children) if (mesh instanceof PIXI.Mesh) mesh.alpha = 1;
            this.fog.shader.uniforms.uSlide = 1.5;
        }
    }

    /** Закрытие — появление наоборот: нити втягиваются к центру, кристаллы гаснут от обода к Боссу, Туман уползает влево */
    outro() {
        if (this.still || !this.model) return Promise.resolve();
        this.intro = null;
        playWeb('close');
        return new Promise(resolve => { this.leaving = { start: performance.now(), resolve }; });
    }

    #outroFrame(now) {
        const T = now - this.leaving.start;
        const clamp = v => Math.max(0, Math.min(1, v));
        const ease = k => k * k * (3 - 2 * k);
        // Свечение хода, искры, фонарь, пряди, подписи — гаснут первыми
        const glow = 1 - clamp(T / 300);
        for (const layer of [this.glows, this.lantern, this.labels, this.fogLayer]) layer.alpha = glow;
        for (const sp of this.sparks) sp.g.visible = glow > 0;
        for (const mesh of this.lines.children) if (mesh instanceof PIXI.Mesh) mesh.alpha = glow;
        // Нити втягиваются к узлу, что ближе к центру: дальние — раньше
        for (const e of this.edgeDraw ?? []) {
            const k = 1 - ease(clamp((T - (1 - Math.min(1, e.x)) * 220) / 300));
            const { g, a, b, c } = e;
            g.clear();
            if (k <= 0) continue;
            const c1 = { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k };
            const u = 1 - k;
            const end = { x: u * u * a.x + 2 * u * k * c.x + k * k * b.x, y: u * u * a.y + 2 * u * k * c.y + k * k * b.y };
            g.lineStyle({ width: e.width, color: e.color, alpha: e.alpha, cap: 'round' }).moveTo(a.x, a.y).quadraticCurveTo(c1.x, c1.y, end.x, end.y);
        }
        // Кристаллы гаснут от обода к Боссу
        for (const { node, base, x } of this.nodes.values()) {
            const k = 1 - clamp((T - 380 - (1 - Math.min(1, x)) * 420) / 240);
            node.alpha = base * k;
            node.scale.set(0.4 + 0.6 * ease(k));
        }
        this.rings.alpha = 1 - ease(clamp((T - 750) / 400));
        // Туман уползает влево рваным краем
        this.fog.shader.uniforms.uSlide = 1.5 - 1.6 * ease(clamp((T - 850) / 650));
        if (T > 1550) {
            const { resolve } = this.leaving;
            this.leaving = null;
            this.left = true;
            resolve();
        }
    }

    #frame(dt) {
        if (!this.still) this.time += dt;
        const t = this.time;
        if (this.left) return;
        if (this.intro) this.#introFrame(this.still ? this.intro.start + 99999 : performance.now());
        this.fog.shader.uniforms.uTime = t;
        for (const m of this.tendrils) m.shader.uniforms.uTime = t * (m.speed ?? 1);
        for (const shader of this.trails ?? []) shader.uniforms.uTime = t;
        for (const l of this.devLines ?? []) {
            if (l.g.destroyed) continue;
            const k = 0.5 + 0.5 * Math.sin(t * 1.8 - l.phase * 0.8);
            l.g.tint = mixc(0x1c4644, 0xffffff, k);
            l.g.alpha = l.next ? 0.6 + 0.4 * Math.sin(t * 2.6) : 0.75 + 0.25 * k;
        }
        for (const c of this.creeps ?? []) { c.shader.uniforms.uTime = t; c.shader.uniforms.uHead = 0.6 + 0.4 * Math.sin(t * 2.6); c.shader.uniforms.uReveal = c.reach + Math.sin(t * 1.3) * 0.06; }
        // Кольца вращаются медленно, в разные стороны
        if (this.outpostRing) this.outpostRing.rotation = -t * 0.02;
        if (this.innerRing) this.innerRing.rotation = t * 0.035;
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
        for (const { glow, data } of this.nodes.values()) if (data.state === 'reachable' && !data.visited) glow.alpha = 0.25 + 0.3 * pulse;
        if (this.pointer) {
            const k = Math.min(1, (performance.now() - this.pointer.start) / 900), e = 1 - (1 - k) ** 3;
            this.pointer.g.rotation = this.pointer.from + (this.pointer.to - this.pointer.from) * e;
        }
        const stage = this.model?.boss?.stage ?? 0;
        // Последний шаг до поедания — кристалл подёргивается: короткие рывки раз в пару секунд
        for (const tw of this.twitch ?? []) {
            if (tw.node.destroyed) continue;
            const ph = (t + tw.s) % 2.4, amp = ph < 0.25 ? 1.6 * Math.sin(ph / 0.25 * Math.PI) : 0;
            tw.node.position.set(tw.x + Math.sin(t * 60 + tw.s) * amp, tw.y + Math.cos(t * 47) * amp * 0.5);
        }
        if (this.bossEye && !this.bossEye.lid.destroyed) {
            const e = this.bossEye, now = performance.now();
            const k = Math.max(0, Math.min(1, (now - e.start) / 1100)), ease = 1 - (1 - k) ** 3;
            const open = e.from + (e.to - e.from) * ease;
            // Моргание: раз в несколько секунд, 0.18 с; во сне — веко чуть «дышит»
            let blink = 0;
            if (open > 0.04) {
                const b = (now - e.blinkAt) / 180;
                if (b >= 0 && b <= 1) blink = Math.sin(b * Math.PI);
                if (b > 1) e.blinkAt = now + 2500 + Math.random() * 5000;
            }
            this.#drawEye(open, blink);
            const lv = open;
            // Кристалл с пробуждением краснеет: от тёмного пепельно-бурого до яркого алого
            e.gem.tint = mixc(0x3c2a28, 0xffffff, Math.min(1, lv));
            e.inner.alpha = (0.08 + 0.55 * lv) * (e.full ? 0.75 + 0.25 * Math.sin(t * 3.2) : 0.9 + 0.1 * Math.sin(t * 1.7));
            const sk = (now - e.sheenAt) / 900, r0 = e.r;
            e.sheen.clear();
            if (sk >= 0 && sk <= 1) {
                const x = -1.3 * r0 + sk * 2.6 * r0;
                e.sheen.beginFill(0xffffff, 0.35 * Math.sin(sk * Math.PI) * (0.4 + 0.6 * lv)).drawPolygon([x - 0.12 * r0, -1.3 * r0, x + 0.12 * r0, -1.3 * r0, x - 0.4 * r0, 1.3 * r0, x - 0.64 * r0, 1.3 * r0]).endFill();
            } else if (sk > 1) e.sheenAt = now + 3500 + Math.random() * 3000;
            e.aura.alpha = e.full ? 0.65 + 0.35 * Math.sin(t * 3.2) : 0.12 + 0.45 * lv * (0.85 + 0.15 * Math.sin(t * (1.4 + lv * 2)));
            e.aura.scale.set(e.full ? 1.15 + 0.12 * Math.sin(t * 3.2) : 1);
        }
        if (this.fullRing && !this.fullRing.destroyed) this.fullRing.alpha = 0.6 + 0.4 * Math.sin(t * 1.1);
        for (const g of this.medals ?? []) g.alpha = 0.7 + 0.3 * Math.sin(t * 2.2);
        if (this.ignite?.flash.destroyed) this.ignite = null;
        if (this.ignite) {
            const fx = this.ignite, T = (performance.now() - fx.start) / 1000;
            const clamp = v => Math.max(0, Math.min(1, v));
            // Медальон вспыхивает и подпрыгивает (0–0.5 с)
            const m1 = clamp(T / 0.5);
            if (fx.medal) fx.medal.scale.set(1 + 0.45 * Math.sin(m1 * Math.PI));
            fx.flash.clear();
            if (m1 < 1) fx.flash.beginFill(0xffc080, 0.8 * (1 - m1)).drawCircle(fx.from.x, fx.from.y, 18 + 26 * m1).endFill();
            // Искры летят от медальона к Боссу по дуге (0.2–1.1 с)
            fx.sparks.clear();
            for (const e of fx.embers) {
                const k = clamp((T - 0.2 - e.d) / (0.7 * e.s)); if (k <= 0 || k >= 1) continue;
                const u = 1 - k, cx = fx.from.x * 0.4 + e.off, cy = fx.from.y * 0.4 - e.off;
                const x = u * u * fx.from.x + 2 * u * k * cx, y = u * u * fx.from.y + 2 * u * k * cy;
                fx.sparks.beginFill(0xffd9a0, 1 - k * 0.5).drawCircle(x, y, 2.4).endFill();
                fx.sparks.beginFill(0xff6a30, 0.35).drawCircle(x, y, 6).endFill();
            }
            // Кристалл Босса вспыхивает, когда искры долетают, и остывает (0.9–2.0 с)
            const s1 = clamp((T - 0.9) / 1.1), br = this.bossEye?.r ?? 20;
            fx.seg.clear();
            if (T > 0.9 && s1 < 1) fx.seg.beginFill(0xffe0c0, 0.7 * (1 - s1)).drawPolygon(crystal(br * (1.15 + 0.4 * s1))).endFill();
            // Босс вздрагивает (0.9–1.3 с)
            const boss = [...this.nodes.values()].find(v => v.data.type === 'boss');
            if (boss) {
                if (!fx.bossPos) fx.bossPos = { x: boss.node.position.x, y: boss.node.position.y };
                const q = clamp((T - 0.9) / 0.4), amp = q > 0 && q < 1 ? 4 * (1 - q) : 0;
                boss.node.position.set(fx.bossPos.x + Math.sin(T * 90) * amp, fx.bossPos.y + Math.cos(T * 70) * amp * 0.6);
            }
            if (T > 2.3) { fx.flash.destroy(); fx.sparks.destroy(); fx.seg.destroy(); if (fx.medal) fx.medal.scale.set(1); this.ignite = null; }
        }
        // Искры бегут по нитям хода
        for (const s of this.sparks) {
            const k = ((t * 0.45 + s.phase) % 1);
            const u = 1 - k;
            s.g.position.set(u * u * s.p0.x + 2 * u * k * s.c.x + k * k * s.p1.x, u * u * s.p0.y + 2 * u * k * s.c.y + k * k * s.p1.y);
            s.g.alpha = Math.sin(k * Math.PI);
        }
        // Фонарь летит по нитям: нога за ногой, по изгибу каждой
        if (this.flight) {
            const { legs, start, leg } = this.flight;
            const k = Math.min(legs.length, (performance.now() - start) / leg);
            const i = Math.min(legs.length - 1, Math.floor(k)), f = k - i, e = f * f * (3 - 2 * f), u = 1 - e;
            const { a, b, c } = legs[i];
            this.lantern.position.set(u * u * a.x + 2 * u * e * c.x + e * e * b.x, u * u * a.y + 2 * u * e * c.y + e * e * b.y);
            if (k >= legs.length) this.flight = null;
        }
        // Знакомые тропы дышат: медленно, чтобы не спорить с янтарём нового хода
        for (const f of this.familiar ?? []) {
            const k = 0.5 + 0.5 * Math.sin(t * 1.6 + f.phase * 6);
            f.glow.alpha = 0.15 + 0.45 * k;
            f.line.alpha = 0.7 + 0.3 * k;
        }
        // След Пожирателя дорастает; съеденный узел вспыхивает, когда голова следа дошла до него
        if (this.reveal) {
            const { shader, base } = this.reveal;
            const { value, head, base: under } = revealAt(this.reveal, performance.now());
            shader.uniforms.uReveal = value;
            shader.uniforms.uHead = head;
            base.alpha = under;
            for (const b of this.bursts ?? []) if (b.bite.start === null && value - 0.12 >= b.at) { b.bite.start = performance.now(); playWeb('bite', null, { throttle: 600 }); }
        } else for (const b of this.bursts ?? []) if (b.bite.start === null) { b.bite.start = performance.now(); playWeb('bite', null, { throttle: 600 }); }
        for (const b of this.bursts ?? []) {
            if (b.bite.start === null) continue;
            if (b.bite.done) { b.mesh.shader.uniforms.uGrow = 1; continue; }
            const k = Math.min(1, (performance.now() - b.bite.start) / 900);
            b.mesh.shader.uniforms.uGrow = 1 - (1 - k) ** 3;
            // Кристалл сжимается под укусом и отпускает; бирюзовое кольцо разбегается
            b.node.scale.set(1 - 0.22 * Math.sin(Math.min(1, k * 2.2) * Math.PI));
            b.burst.clear().lineStyle({ width: 3 * (1 - k), color: 0x2ee6d6, alpha: 1 - k }).drawCircle(0, 0, b.r * (1.2 + 2.6 * k));
            if (k >= 1) { b.bite.done = true; b.burst.clear(); b.node.scale.set(1); }
        }
        if (this.lantern.children[0]) this.lantern.children[0].alpha = 0.85 + 0.15 * Math.sin(t * 5.3) * Math.sin(t * 3.1);
        // Выбранный кристалл: грани загораются по одной и держат свет
        if (this.selected) {
            const sel = this.nodes.get(this.selected);
            if (sel) {
                const lit = Math.min(6, Math.floor((performance.now() - this.selectStart) / 70) + 1);
                const r = sel.r * 1.22, pts = crystal(r);
                sel.facets.clear();
                for (let i = 0; i < lit; i++) {
                    const j = (i + 1) % 6;
                    sel.facets.beginFill(AMBER, 0.32).drawPolygon([0, 0, pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1]]).endFill();
                }
                sel.facets.lineStyle({ width: 2.4, color: 0xfff1c9, alpha: 0.6 + 0.4 * pulse }).drawPolygon(pts);
            }
        }
        if (this.leaving) this.#outroFrame(performance.now());
    }
}
