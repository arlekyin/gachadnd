// Минимум Foundry для стендов: настройки, хуки, сокет, уведомления.
// В адресе: ?calm — спокойный режим, ?slow=N — замедление кадров в N раз (настройка impactSlow).
(() => {
    const query = new URLSearchParams(location.search);
    const store = {
        impactFrames: true, impactCalm: query.has('calm'), impactSlow: Number(query.get('slow')) || 1, impactSound: '', impactSoundFolder: '',
        soundsEnabled: false, soundsVolume: 0.5
    };
    const hooks = {};
    window.Hooks = {
        events: hooks,
        on: (name, fn) => { (hooks[name] ??= []).push(fn); return fn; },
        off: (name, fn) => { hooks[name] = (hooks[name] ?? []).filter(f => f !== fn); },
        once: (name, fn) => (hooks[name] ??= []).push(fn),
        call: (name, ...args) => hooks[name]?.forEach(fn => fn(...args)),
        callAll: (name, ...args) => hooks[name]?.forEach(fn => fn(...args))
    };
    window.game = {
        settings: { register() {}, get: (module, key) => store[key], set: (module, key, value) => { store[key] = value; } },
        socket: { emit: (...args) => { window.sent = args; }, on() {} },
        user: { id: 'u', isGM: true },
        users: { activeGM: { id: 'u' } },
        playlists: { playing: [] },
        actors: { get: () => null }
    };
    // Окна модуля импортируются вместе с кодом сцен: классы-заглушки, чтобы модули загрузились
    const Application = class { static DEFAULT_OPTIONS = {}; };
    window.foundry = {
        utils: { randomID: () => Math.random().toString(36).slice(2, 18), deepClone: v => structuredClone(v), mergeObject: (a, b) => Object.assign(a, b), hasProperty: () => false },
        applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: Base => class extends Base {}, DialogV2: {} }, instances: new Map() }
    };
    window.ui = { notifications: { warn: console.warn, info: console.log, error: console.error } };
})();
