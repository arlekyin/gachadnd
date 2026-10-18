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

const VERT = `precision mediump float;
attribute vec2 aVertexPosition; attribute vec2 aUvs;
uniform mat3 translationMatrix; uniform mat3 projectionMatrix;
varying vec2 vUv;
void main() { vUv = aUvs; gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0); }`;

const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }`;

// Туман: сизый, клубится медленно; у астролябии — тёплый латунный отсвет; к правому краю и углам тает клубами
const FOG = `precision mediump float;
varying vec2 vUv; uniform float uTime; uniform float uAspect; uniform vec2 uCenter; uniform float uRadius; uniform float uSlide;
${NOISE}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y) * 2.2;
  float t = uTime * 0.03;
  float warp = fbm(p * 0.7 - vec2(t, t * 0.5));
  float n = fbm(p + vec2(t * 1.2, -t * 0.6) + warp * 1.6);
  vec3 col = mix(vec3(0.03, 0.04, 0.05), vec3(0.15, 0.17, 0.19), smoothstep(0.3, 0.9, n));
  vec2 d = vec2((vUv.x - uCenter.x) * uAspect, vUv.y - uCenter.y);
  float glow = exp(-dot(d, d) / (uRadius * uRadius * 0.7));
  col += vec3(0.16, 0.1, 0.035) * glow * (0.6 + 0.4 * n);
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

const quad = (w, h) => new PIXI.Geometry()
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
        this.fog = new PIXI.Mesh(quad(1, 1), PIXI.Shader.from(VERT, FOG, { uTime: 0, uAspect: 1, uCenter: [0.35, 0.5], uRadius: 0.4, uSlide: 1.5 }));
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
        const STYLE = { open: [AMBER, 2.4, 1], familiar: [DIM_AMBER, 2, 0.9], traversed: [0x7d6440, 1.8, 0.75], eaten: [0x0d4743, 1.8, 0.8], ahead: [0x56616b, 1.3, 0.55] };
        for (const e of model.edges) {
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
        // След Пожирателя: тёмная подложка и полоса с чёрно-бирюзовыми переливами
        this.trails = [];
        if (model.trail?.length > 1) {
            const pts = model.trail.map(id => byId.get(id)).filter(Boolean).map(at);
            const base = new PIXI.Graphics();
            base.lineStyle({ width: 15, color: 0x010808, alpha: 0.7, cap: 'round', join: 'round' });
            pts.forEach((p, i) => (i ? base.lineTo(p.x, p.y) : base.moveTo(p.x, p.y)));
            base.filters = [new PIXI.BlurFilter(5)];
            this.glows.addChild(base);
            const geometry = ribbon(pts, 10, 60);
            const total = geometry.lengths.at(-1);
            // Пожиратель прошёл дальше — след дорастает от прежней длины (если след тот же, а не новый)
            const old = prev?.trail ?? [];
            const same = old.length && old.length < model.trail.length && old.every((id, i) => model.trail[i] === id);
            const from = same ? geometry.lengths[old.length - 1] : total;
            // Перерисовка посреди анимации (флаг, предвестия, чат) — проявление продолжается, а не начинается заново
            const going = this.reveal && this.reveal.ids.join() === model.trail.join() ? this.reveal : null;
            const reveal = going ? { ...going } : { from: from + 0.12, to: total + 0.12, start: performance.now(), ms: Math.max(1, total - from) * 260, ids: model.trail };
            const state = revealAt(reveal, performance.now());
            const shader = PIXI.Shader.from(VERT, TRAIL, { uTime: this.time, uReveal: state.value, uHead: state.head });
            base.alpha = state.base;
            this.lines.addChild(new PIXI.Mesh(geometry, shader));
            this.trails.push(shader);
            this.reveal = { ...reveal, shader, base, lengths: geometry.lengths };
        } else this.reveal = null;

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
            const body = visited ? mixc(shade(col, 0.45), 0x2a2724, 0.65) : n.state === 'locked' ? shade(col, 0.55) : shade(col, 0.8);
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
            node.addChild(glow, gem, icon, rim, facets);
            node.alpha = (n.state === 'locked' ? 0.85 : 1) * lit;
            if (n.touched) {
                const claw = new PIXI.Graphics();
                claw.lineStyle({ width: 2.2, color: 0x12a89e, alpha: 0.95, cap: 'round' });
                for (const dx of [-6, 0, 6]) claw.moveTo(dx - 2, -1.2 * r - 14).quadraticCurveTo(dx + 2, -1.2 * r - 9, dx - 1, -1.2 * r - 4);
                node.addChild(claw);
            }
            node.eventMode = 'static';
            node.cursor = 'pointer';
            node.hitArea = new PIXI.Polygon(crystal(r * 1.3));
            node.on('pointerover', () => { node.scale.set(1.1); this.onHover?.(n, p, r * 1.2); playWeb('hover', null, { throttle: 70 }); });
            node.on('pointerout', () => { node.scale.set(1); this.onHover?.(null); });
            node.on('pointertap', event => { event.stopPropagation(); this.#tap(n); });
            this.nodesLayer.addChild(node);
            this.nodes.set(n.id, { node, glow, facets, data: n, r, lit, base: node.alpha, x: Math.hypot(p.x - center.x, p.y - center.y) / half });
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
            if (n.state === 'current' || n.type === 'boss') {
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
            trail: model.trail ?? [], eaten: model.nodes.filter(n => n.eaten).map(n => n.id)
        };
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
            g.lineStyle({ width: 0.8, color: BRASS, alpha: 0.3 }).drawCircle(0, 0, r - 9);
            for (let i = 0; i < 120; i++) {
                const a = i / 120 * Math.PI * 2, long = i % 10 === 0, mid = i % 5 === 0;
                const l = long ? 9 : mid ? 6 : 3.5;
                g.lineStyle({ width: long ? 1.4 : 0.8, color: BRASS, alpha: long ? 0.5 : 0.3 })
                    .moveTo(Math.cos(a) * r, Math.sin(a) * r).lineTo(Math.cos(a) * (r - l), Math.sin(a) * (r - l));
                // Знаки на обод: ромб, точка, черта — по очереди
                if (long) {
                    const k = (i / 10) % 3, x = Math.cos(a) * (r + 10), y = Math.sin(a) * (r + 10);
                    g.lineStyle({ width: 1.1, color: BRASS, alpha: 0.5 });
                    if (k === 0) g.drawPolygon([x, y - 4, x + 3, y, x, y + 4, x - 3, y]);
                    else if (k === 1) g.beginFill(BRASS, 0.5).drawCircle(x, y, 1.8).endFill();
                    else g.drawCircle(x, y, 3.2);
                }
            }
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
        this.core = ring(RINGS.core, (g, r) => {
            g.lineStyle({ width: 1.2, color: BOSS_RED, alpha: 0.45 }).drawCircle(0, 0, r);
            for (let i = 0; i < 8; i++) {
                const a = i / 8 * Math.PI * 2;
                g.lineStyle({ width: 1.2, color: BOSS_RED, alpha: 0.45 }).moveTo(Math.cos(a) * r, Math.sin(a) * r).lineTo(Math.cos(a) * (r + 7), Math.sin(a) * (r + 7));
            }
        });
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
        for (const m of this.tendrils) m.shader.uniforms.uTime = t;
        for (const shader of this.trails ?? []) shader.uniforms.uTime = t;
        // Кольца вращаются медленно, в разные стороны
        if (this.rim) this.rim.rotation = t * 0.012;
        if (this.outpostRing) this.outpostRing.rotation = -t * 0.02;
        if (this.innerRing) this.innerRing.rotation = t * 0.035;
        if (this.core) this.core.rotation = -t * 0.06;
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
        for (const { glow, data } of this.nodes.values()) if (data.state === 'reachable' && !data.visited) glow.alpha = 0.25 + 0.3 * pulse;
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
