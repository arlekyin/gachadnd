/**
 * Катсцены — сцена Foundry: фильтры всей сцены, копии токенов, скрытие токенов и их значков.
 * Всё, что меняется, возвращается: у каждой функции — своё восстановление.
 */

/** Фильтр поверх всей сцены (ч/б, негатив, разрез). @returns {{filter, remove: Function}} */
export function stageFilter(filter) {
    const stage = canvas.stage, savedArea = stage.filterArea;
    stage.filters = [...(stage.filters ?? []), filter];
    stage.filterArea = canvas.app.renderer.screen;
    let on = true;
    return {
        filter,
        // Снимается только свой фильтр: другие (предвестия Пожирателя) могли появиться или уйти за это время
        remove() {
            if (!on) return;
            on = false;
            const rest = (stage.filters ?? []).filter(f => f !== filter);
            stage.filters = rest.length ? rest : null;
            if (!rest.length) stage.filterArea = savedArea ?? null;
        }
    };
}

/** Ч/б с поднятым контрастом */
export function grayFilter(contrast = 0.35) {
    const gray = new PIXI.ColorMatrixFilter();
    gray.desaturate();
    gray.contrast(contrast, true);
    return gray;
}

/** Копия картинки токена: на месте токена, с его масштабом и поворотом; по умолчанию — ч/б */
export function tokenCopy(token, { gray = true } = {}) {
    const mesh = token?.mesh;
    if (!mesh?.texture) return null;
    const sprite = new PIXI.Sprite(mesh.texture);
    sprite.anchor.set(mesh.anchor?.x ?? 0.5, mesh.anchor?.y ?? 0.5);
    sprite.position.set(mesh.position.x, mesh.position.y);
    sprite.scale.set(mesh.scale.x, mesh.scale.y);
    sprite.rotation = mesh.rotation;
    if (gray) sprite.filters = [grayFilter(0.5)];
    return sprite;
}

/**
 * Рамка, повёрнутая на angle, с копией внутри: растяжение и сжатие рамки идут вдоль angle,
 * а не по осям картинки.
 */
export function rotatedFrame(copy, angle) {
    const frame = new PIXI.Container();
    frame.rotation = angle;
    if (copy) {
        frame.position.set(copy.position.x, copy.position.y);
        copy.position.set(0, 0);
        copy.rotation -= angle;
        frame.addChild(copy);
    }
    return frame;
}

/** Скрыть токен на время сцены: двигается его копия. Прежняя прозрачность — в mesh.gdAlpha */
export function hideToken(token) {
    if (token?.mesh) { token.mesh.gdAlpha ??= token.mesh.alpha; token.mesh.alpha = 0; }
}

export function showToken(token) {
    const mesh = token?.mesh;
    if (mesh?.gdAlpha !== undefined) { mesh.alpha = mesh.gdAlpha; delete mesh.gdAlpha; }
}

/** Значки состояний, полосы и имена всех токенов — скрыть; возвращает восстановление */
export function hideTokenMarks() {
    const hidden = [];
    for (const token of canvas.tokens?.placeables ?? []) {
        for (const part of [token.effects, token.bars, token.nameplate, token.tooltip, token.targetArrows, token.border]) {
            if (part?.visible) { part.visible = false; hidden.push(part); }
        }
    }
    return () => hidden.forEach(part => part.visible = true);
}
