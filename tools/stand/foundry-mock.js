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
        on: (name, fn) => (hooks[name] ??= []).push(fn),
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
    window.foundry = { utils: { randomID: () => Math.random().toString(36).slice(2, 18) } };
    window.ui = { notifications: { warn: console.warn, info: console.log, error: console.error } };
})();
