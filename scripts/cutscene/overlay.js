/**
 * Катсцены — холсты поверх экрана (рисованные кадры) в пикселях устройства и негатив кадра.
 */

/** Холст во весь экран поверх всего. @returns {{canvas, ctx, W, H, remove: Function}} */
export function overlay({ hidden = false } = {}) {
    const canvas = document.createElement('canvas');
    canvas.className = 'gd-impact';
    canvas.width = Math.round(innerWidth * devicePixelRatio);
    canvas.height = Math.round(innerHeight * devicePixelRatio);
    if (hidden) canvas.style.display = 'none';
    document.body.append(canvas);
    return { canvas, ctx: canvas.getContext('2d'), W: canvas.width, H: canvas.height, remove: () => canvas.remove() };
}

/** Негатив всего кадра — и рисунка на холсте, и сцены под ним */
export function setNegative(elements, on) {
    for (const el of elements) {
        if (!el) continue;
        el.style.filter = on ? 'invert(1)' : '';
        el.style.backdropFilter = on ? 'invert(1)' : '';
    }
}

/** Убрать всё, что сцена могла оставить, если она оборвалась: холсты, кинополосы, скрытые токены */
export function cleanupOverlays() {
    document.querySelectorAll('.gd-impact, .gd-letterbox').forEach(el => el.remove());
    for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
        if (token.mesh?.gdAlpha !== undefined) { token.mesh.alpha = token.mesh.gdAlpha; delete token.mesh.gdAlpha; }
    }
}
