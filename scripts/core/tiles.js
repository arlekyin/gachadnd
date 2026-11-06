/**
 * Плитки по левому верхнему углу на обеих версиях Foundry. В v13 x, y плитки — её угол; в v14 — точка привязки
 * текстуры (по умолчанию центр), и плитка с x, y угла встаёт на полразмера влево и вверх. Модуль считает x, y углом:
 * в v14 привязка текстуры ставится в угол, тогда x, y документа — снова угол
 */

/**
 * @param {object} data  данные плитки: x, y — левый верхний угол
 * @returns {object}     данные для createEmbeddedDocuments
 */
export function tileData(data) {
    if ((game.release?.generation ?? 13) < 14) return data;
    return { ...data, texture: { ...data.texture, anchorX: 0, anchorY: 0 } };
}
