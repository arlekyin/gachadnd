/**
 * Катсцены — окна Foundry на время сцены сворачиваются, после неё разворачиваются.
 * Трогаются только окна с рамкой, открытые и не свёрнутые: свёрнутые раньше остаются свёрнутыми,
 * интерфейс без рамки (боковая панель, панель макросов) не меняется.
 */

function openWindows() {
    const apps = new Set([...(foundry.applications?.instances?.values?.() ?? []), ...Object.values(globalThis.ui?.windows ?? {})]);
    return [...apps].filter(app => {
        if (!app?.rendered) return false;
        // ApplicationV2: hasFrame и minimized; прежние окна: popOut и _minimized
        const framed = 'hasFrame' in app ? app.hasFrame : app.popOut;
        const minimized = 'minimized' in app ? app.minimized : app._minimized;
        return framed && !minimized && typeof app.minimize === 'function';
    });
}

/** Свернуть открытые окна. @returns {Function}  Вернуть их как были (повторный вызов ничего не делает). */
export function stowWindows() {
    let stowed = [];
    try {
        stowed = openWindows();
        for (const app of stowed) Promise.resolve(app.minimize()).catch(() => {});
    } catch (error) {
        console.warn('gachadnd | окна на время катсцены', error);
    }
    let done = false;
    return () => {
        if (done) return;
        done = true;
        for (const app of stowed) {
            if (app.rendered) Promise.resolve(app.maximize?.()).catch(() => {});
        }
    };
}
