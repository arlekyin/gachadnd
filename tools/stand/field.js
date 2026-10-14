// Сцена для стендов навыков на поле: окна ApplicationV2 без шаблонов, документы сцены (плитки
// рисуются спрайтами, токены двигаются и вызывают updateToken), персонаж с навыком.
// Подключать после foundry-mock.js, pixi и scene.js:
//   import { field } from './field.js'; const { actor, item } = field({ tetris: true }, { uses: 3 });
// window.WALLS = [[x1, y1, x2, y2], ...] — стены движения (пиксели сцены).
export function field(flags, { uses = null, range = 60 } = {}) {

    // ApplicationV2 без шаблонов: _prepareContext → _renderHTML → _replaceHTML, окно в DOM
    class ApplicationV2 {
        static DEFAULT_OPTIONS = {};
        constructor(options = {}) { this.options = { ...this.constructor.DEFAULT_OPTIONS, ...options }; this.id = options.id; this.rendered = false; }
        get title() { return this.options.window?.title ?? ''; }
        async render() {
            const context = await this._prepareContext({});
            const html = await this._renderHTML(context, {});
            if (!this.rendered) {
                this.element = document.createElement('div');
                this.element.className = `application ${(this.options.classes ?? []).join(' ')}`;
                this.element.innerHTML = `<header class="window-header">${this.title}</header><section class="window-content"></section>`;
                document.body.append(this.element);
                foundry.applications.instances.set(this.id, this);
            }
            this._replaceHTML(html, this.element.querySelector('.window-content'), {});
            this.rendered = true;
            return this;
        }
        async _prepareContext() { return {}; }
        async close() { this._onClose?.({}); this.element.remove(); this.rendered = false; foundry.applications.instances.delete(this.id); }
    }
    foundry.applications.api.ApplicationV2 = ApplicationV2;
    foundry.utils.escapeHTML = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const setPath = (obj, path, value) => { const keys = path.split('.'); let o = obj; keys.slice(0, -1).forEach(k => o = o[k] ??= {}); o[keys.at(-1)] = value; };
    const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
    // Сцена Foundry: плитки рисуются спрайтами, токены двигаются вместе с картинкой
    const size = 50;
    const scene = {
        id: 'S', grid: { size }, dimensions: { width: 1134, height: 1192 }, flags: {}, tiles: [], sprites: {},
        // Токены стоят по сетке, как в Foundry
        tokens: Object.values(toks).map(t => ({ id: t.id, name: t.id, actorId: t.id === 'caster' ? 'A' : t.id, disposition: DISPOSITION[t.id] ?? -1,
            x: Math.round((t.center.x - t.w / 2) / size) * size, y: Math.round((t.center.y - t.h / 2) / size) * size, width: t.document.width, height: t.document.height })),
        getFlag(m, k) { return getPath(this.flags[m] ?? {}, k); },
        async setFlag(m, k, v) { setPath(this.flags[m] ??= {}, k, structuredClone(v)); },
        async unsetFlag(m, k) { const keys = k.split('.'); const o = getPath(this.flags[m] ?? {}, keys.slice(0, -1).join('.')) ?? this.flags[m]; if (keys.length === 1) delete this.flags[m][k]; else delete o?.[keys.at(-1)]; },
        async createEmbeddedDocuments(type, list) {
            return list.map(data => {
                const doc = { ...structuredClone(data), id: foundry.utils.randomID() };
                this.tiles.push(doc);
                const sprite = PIXI.Sprite.from(data.texture.src.replace('modules/gachadnd/', '/'));
                sprite.position.set(data.x, data.y); sprite.width = data.width; sprite.height = data.height; if (data.texture.tint) sprite.tint = Number.parseInt(data.texture.tint.slice(1), 16);
                canvas.stage.addChildAt(sprite, 2);
                this.sprites[doc.id] = sprite;
                return doc;
            });
        },
        async deleteEmbeddedDocuments(type, ids) {
            for (const id of ids) { this.sprites[id]?.destroy(); delete this.sprites[id]; }
            this.tiles = this.tiles.filter(t => !ids.includes(t.id));
        },
        async updateEmbeddedDocuments(type, list, options = {}) {
            for (const u of list) {
                const doc = this.tokens.find(t => t.id === u._id); Object.assign(doc, u);
                const t = toks[u._id], cx = u.x + t.w / 2, cy = u.y + t.h / 2;
                t.mesh.position.set(cx, cy); t.effects.position.set(cx - t.center.x, cy - t.center.y);
                t.center = { x: cx, y: cy };
                window.moved = [...(window.moved ?? []), u];
                const { _id, ...changes } = u;
                Hooks.call('updateToken', doc, changes, options, 'u');
            }
        }
    };
    scene.tokens.get = id => scene.tokens.find(t => t.id === id);
    Object.values(toks).forEach(t => { const d = scene.tokens.find(x => x.id === t.id); t.document = d; });
    canvas.scene = scene;
    // Как в Foundry: сцена ловит указатель
    canvas.stage.eventMode = 'static'; canvas.stage.hitArea = new PIXI.Rectangle(-1e5, -1e5, 2e5, 2e5);
    canvas.grid = { size, isSquare: true, getOffset: ({ x, y }) => ({ i: Math.floor(y / size), j: Math.floor(x / size) }), getTopLeftPoint: ({ i, j }) => ({ x: j * size, y: i * size }) };
    canvas.controls = new PIXI.Container(); canvas.stage.addChild(canvas.controls);
    canvas.templates = { activate() {} }; canvas.activeLayer = { activate() {} };
    canvas.tokens.placeables.forEach(t => { t.visible = true; });
    game.scenes = { get: () => scene, [Symbol.iterator]: function* () { yield scene; } };
    game.user.updateTokenTargets = ids => { window.targets = ids; };
    window.ChatMessage = { create: async data => { window.chat = data.content; }, getSpeaker: () => ({}) };

    for (const doc of scene.tokens) {
        doc.parent = scene;
        doc.update = (data, options) => scene.updateEmbeddedDocuments('Token', [{ _id: doc.id, ...data }], options);
        // window.V13 — механизм движения Foundry v13: move() и хук moveToken (движение закончено сразу)
        if (window.V13) doc.move = async (waypoint, options = {}) => {
            const origin = { x: doc.x, y: doc.y };
            await scene.updateEmbeddedDocuments('Token', [{ _id: doc.id, x: waypoint.x, y: waypoint.y }], options);
            window.moves = [...(window.moves ?? []), { id: doc.id, ...waypoint }];
            Hooks.call('moveToken', doc, { origin, passed: { waypoints: [{ x: waypoint.x, y: waypoint.y, action: waypoint.action ?? 'walk' }] }, pending: { waypoints: [] } }, options, { id: 'u' });
            return true;
        };
    }
    scene.grid.distance = 5;
    // Стены движения: пересечение отрезков
    const cross = (a, b, c, d) => {
        const det = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
        if (!det) return false;
        const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / det, u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / det;
        return t > 0 && t < 1 && u > 0 && u < 1;
    };
    window.CONFIG = { ...(window.CONFIG ?? {}), Canvas: { polygonBackends: { move: { testCollision: (a, b) => (window.WALLS ?? []).some(([x1, y1, x2, y2]) => cross(a, b, { x: x1, y: y1 }, { x: x2, y: y2 })) } } } };
    const wallLines = new PIXI.Graphics();
    for (const [x1, y1, x2, y2] of window.WALLS ?? []) wallLines.lineStyle(6, 0xdddddd, 1).moveTo(x1, y1).lineTo(x2, y2);
    canvas.stage.addChild(wallLines);
    // Персонаж с навыком
    const item = { flags: { gachadnd: { ...flags, is_active: true } }, system: { uses: { max: uses ?? 0, spent: 0, get value() { return (uses ?? 0) - this.spent; } }, range: { value: range } },
        async update(data) { if ('system.uses.spent' in data) this.system.uses.spent = data['system.uses.spent']; } };
    const actor = { id: 'A', name: 'Конь', isOwner: true, flags: {}, items: [item],
        getActiveTokens: () => [toks.caster],
        getFlag(m, k) { return getPath(this.flags[m] ?? {}, k); },
        async update(data) { for (const [k, v] of Object.entries(data)) setPath(this, k, structuredClone(v)); } };
    item.actor = actor;
    game.actors = { get: () => actor };
    window.actor = actor; window.item = item; window.scene = scene;
    window.useSkill = () => {
        const activity = { item, range: { value: range } };
        if ((Hooks.events['dnd5e.preUseActivity'] ?? []).some(fn => fn(activity) === false)) return false;
        if (uses) item.system.uses.spent++;
        (Hooks.events['dnd5e.postUseActivity'] ?? []).forEach(fn => fn(activity));
        return true;
    };
    // Ход ручной: обычный requestAnimationFrame
    (function tick() { canvas.app.render(); requestAnimationFrame(tick); })();
    Hooks.call('canvasReady', canvas);
    return { actor, item, scene };
}
