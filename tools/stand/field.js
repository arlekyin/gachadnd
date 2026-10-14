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
    foundry.utils.setProperty = (obj, path, value) => { const keys = path.split('.'); let o = obj; keys.slice(0, -1).forEach(k => o = o[k] ??= {}); o[keys.at(-1)] = value; };
    foundry.utils.escapeHTML = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // Путь с «-=ключ» удаляет ключ, как в обновлениях Foundry
    const setPath = (obj, path, value) => {
        const keys = path.split('.'); let o = obj; keys.slice(0, -1).forEach(k => o = o[k] ??= {});
        const last = keys.at(-1);
        if (last.startsWith('-=')) delete o[last.slice(2)]; else o[last] = value;
    };
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
            if (type === 'Token') return list.map(data => addToken({ ...structuredClone(data), id: foundry.utils.randomID() }));
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
            if (type === 'Token') {
                for (const id of ids) {
                    const t = toks[id];
                    t?.mesh.destroy(); t?.effects.destroy();
                    delete toks[id];
                    const i = this.tokens.findIndex(d => d.id === id);
                    if (i >= 0) this.tokens.splice(i, 1);
                }
                canvas.tokens.placeables = Object.values(toks);
                window.deleted = [...(window.deleted ?? []), ...ids];
                return;
            }
            for (const id of ids) { this.sprites[id]?.destroy(); delete this.sprites[id]; }
            this.tiles = this.tiles.filter(t => !ids.includes(t.id));
        },
        async updateEmbeddedDocuments(type, list, options = {}) {
            for (const u of list) {
                const doc = this.tokens.find(t => t.id === u._id);
                for (const [k, v] of Object.entries(u)) if (k !== '_id') setPath(doc, k, v);
                const t = toks[u._id];
                if ('alpha' in u) { t.mesh.alpha = u.alpha; t.effects.alpha = u.alpha; }
                if ('x' in u || 'y' in u) {
                    const cx = doc.x + t.w / 2, cy = doc.y + t.h / 2;
                    t.mesh.position.set(cx, cy); t.effects.position.set(cx - t.center0.x, cy - t.center0.y);
                    t.center = { x: cx, y: cy };
                    window.moved = [...(window.moved ?? []), u];
                }
                const { _id, ...changes } = u;
                Hooks.call('updateToken', doc, changes, options, 'u');
            }
        }
    };
    scene.tokens.get = id => scene.tokens.find(t => t.id === id);
    Object.values(toks).forEach(t => { const d = scene.tokens.find(x => x.id === t.id); t.document = d; t.center0 = { ...t.center }; });
    // Существа: ПЗ из window.HP = { id: [текущие, максимум] }, по умолчанию 20/20
    const actorOf = (id, name) => {
        const [value, max] = window.HP?.[id] ?? [20, 20];
        return { id, name, statuses: new Set(), flags: {}, system: { attributes: { hp: { value, max, effectiveMax: max, temp: 0 } } },
            testUserPermission: () => true,
            async update(data) { for (const [k, v] of Object.entries(data)) setPath(this, k, structuredClone(v)); },
            async applyDamage(damage) {
                const amount = Array.isArray(damage) ? damage.reduce((sum, d) => sum + d.value, 0) : damage;
                if (Hooks.call('dnd5e.preApplyDamage', this, amount, {}, {}) === false) return this;
                this.system.attributes.hp.value = Math.max(0, this.system.attributes.hp.value - amount);
                window.damaged = [...(window.damaged ?? []), [this.id, amount]];
                return this;
            } };
    };
    const actors = {};
    // Документ токена: методы как у TokenDocument
    const dress = doc => {
        doc.parent = scene;
        doc.alpha ??= 1;
        doc.flags ??= {};
        doc.actor = actors[doc.actorId] ??= actorOf(doc.actorId, doc.name);
        doc.toObject = () => { const { parent, actor, update, move, toObject, ...rest } = doc; return structuredClone({ ...rest, _id: doc.id }); };
        doc.update = (data, options) => scene.updateEmbeddedDocuments('Token', [{ _id: doc.id, ...data }], options);
        return doc;
    };
    // Новый токен (копия): картинка — как у исходного
    const addToken = doc => {
        dress(doc);
        const src = Object.values(toks).find(t => t.document.actorId === doc.actorId);
        const mesh = new PIXI.Sprite(src.mesh.texture); mesh.anchor.set(0.5); mesh.scale.copyFrom(src.mesh.scale);
        const w = (doc.width || 1) * size, cx = doc.x + w / 2, cy = doc.y + w / 2;
        mesh.position.set(cx, cy); mesh.alpha = doc.alpha;
        src.mesh.parent.addChild(mesh);
        const effects = new PIXI.Graphics(); effects.alpha = doc.alpha;
        canvas.stage.addChild(effects);
        toks[doc.id] = { id: doc.id, mesh, effects, center: { x: cx, y: cy }, center0: { x: cx, y: cy }, visible: true, w: src.w, h: src.h, document: doc, renderFlags: { set() {} } };
        scene.tokens.push(doc);
        canvas.tokens.placeables = Object.values(toks);
        return doc;
    };
    canvas.tokens.get = id => toks[id];
    canvas.tokens.controlled = [];
    game.user.targets = new Set();
    game.users = { activeGM: game.users?.activeGM ?? { id: 'u' }, find: () => null, get: () => null };
    window.Roll = class { constructor(formula) { this.formula = formula; } async evaluate() { this.total = 7; return this; } };
    foundry.applications.api.DialogV2 = { wait: async () => window.DIALOG_ANSWER ?? null, confirm: async () => true };
    window.ChatMessage = { create: async data => { window.chat = data.content; window.chats = [...(window.chats ?? []), data.content]; }, getSpeaker: () => ({}) };
    canvas.scene = scene;
    // Как в Foundry: сцена ловит указатель
    canvas.stage.eventMode = 'static'; canvas.stage.hitArea = new PIXI.Rectangle(-1e5, -1e5, 2e5, 2e5);
    canvas.grid = { size, isSquare: true, getOffset: ({ x, y }) => ({ i: Math.floor(y / size), j: Math.floor(x / size) }), getTopLeftPoint: ({ i, j }) => ({ x: j * size, y: i * size }) };
    canvas.controls = new PIXI.Container(); canvas.stage.addChild(canvas.controls);
    canvas.templates = { activate() {} }; canvas.activeLayer = { activate() {} };
    canvas.tokens.placeables.forEach(t => { t.visible = true; });
    game.scenes = { get: () => scene, [Symbol.iterator]: function* () { yield scene; } };
    game.user.updateTokenTargets = ids => { window.targets = ids; };

    for (const doc of scene.tokens) {
        dress(doc);
        // window.V13 — механизм движения Foundry v13: move() и хук moveToken (движение закончено сразу)
        // Как в Foundry 13.351: moveToken приходит, пока документ ещё в начале пути, и встаёт
        // в конец позже (здесь — через 200 мс)
        if (window.V13) doc.move = async (waypoint, options = {}) => {
            const origin = { x: doc.x, y: doc.y };
            const destination = { x: waypoint.x, y: waypoint.y };
            window.moves = [...(window.moves ?? []), { id: doc.id, ...waypoint }];
            Hooks.call('moveToken', doc, { origin, destination, passed: { waypoints: [{ ...destination, action: waypoint.action ?? 'walk' }] }, pending: { waypoints: [] } }, options, { id: 'u' });
            await new Promise(resolve => setTimeout(resolve, 200));
            await scene.updateEmbeddedDocuments('Token', [{ _id: doc.id, ...destination }], options);
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
    const item = { name: 'Навык', getFlag(m, k) { return this.flags[m]?.[k]; }, flags: { gachadnd: { ...flags, is_active: true } }, system: { uses: { max: uses ?? 0, spent: 0, get value() { return (uses ?? 0) - this.spent; } }, range: { value: range } },
        async update(data) { if ('system.uses.spent' in data) this.system.uses.spent = data['system.uses.spent']; } };
    const actor = Object.assign(actors.A ??= actorOf('A', 'Конь'), { isOwner: true, items: [item],
        getActiveTokens: () => [toks.caster],
        getFlag(m, k) { return getPath(this.flags[m] ?? {}, k); },
        async update(data) { for (const [k, v] of Object.entries(data)) setPath(this, k, structuredClone(v)); } });
    item.actor = actor;
    game.actors = { get: id => actors[id] ?? actor };
    window.actors = actors;
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
