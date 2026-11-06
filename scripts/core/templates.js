/**
 * Шаблоны областей в двух версиях Foundry.
 *
 * v13 (dnd5e 5): активность ставит MeasuredTemplate — x, y, direction, distance в футах, angle, width.
 * v14 (dnd5e 6): MeasuredTemplate влит в Регион — активность ставит Регион с фигурой (cone, circle,
 * line, rectangle) в пикселях. Навыкам нужна только геометрия, её и отдаёт shapeOf().
 */

import { t } from "./i18n.js";

/** v14: шаблоны — это Регионы */
export const regionTemplates = () => (game.release?.generation ?? 13) >= 14;

const isTemplate = doc => doc?.documentName === 'MeasuredTemplate' || doc?.documentName === 'Region';

/** Шаблон, поставленный активностью (results из dnd5e.postUseActivity) */
export function placedTemplate(results) {
    return [results?.templates ?? []].flat(2).find(isTemplate) ?? null;
}

/** Шаблоны сцены: в v14 — её Регионы (Scene#templates там устарел) */
export function sceneTemplates(scene) {
    if (!scene) return [];
    return [...(regionTemplates() ? scene.regions : scene.templates) ?? []];
}

/** Шаблон есть на сцене (ещё не удалён) */
export function hasTemplate(doc) {
    const collection = doc?.documentName === 'Region' ? doc.parent?.regions : doc?.parent?.templates;
    return !!collection?.has(doc.id);
}

/**
 * Геометрия шаблона: { x, y, direction (°), distance (фт), angle (°), width (фт), t } — как у MeasuredTemplate.
 * t: cone | circle | ray | rect.
 */
export function shapeOf(doc) {
    if (!doc) return null;
    if (doc.documentName === 'MeasuredTemplate') {
        return { x: doc.x, y: doc.y, direction: doc.direction ?? 0, distance: doc.distance, angle: doc.angle, width: doc.width, t: doc.t };
    }
    const s = doc.shapes?.[0];
    const grid = doc.parent?.grid;
    if (!s || !grid) return null;
    const ft = px => px / grid.size * grid.distance;
    switch (s.type) {
        case 'cone': return { x: s.x, y: s.y, direction: s.rotation ?? 0, distance: ft(s.radius), angle: s.angle, t: 'cone' };
        case 'circle': return { x: s.x, y: s.y, direction: 0, distance: ft(s.radius), t: 'circle' };
        case 'line': return { x: s.x, y: s.y, direction: s.rotation ?? 0, distance: ft(s.length), width: ft(s.width), t: 'ray' };
        case 'rectangle': return { x: s.x, y: s.y, direction: s.rotation ?? 0, distance: ft(Math.hypot(s.width, s.height)), width: ft(s.width), t: 'rect' };
        default: return null;
    }
}

/** Повернуть шаблон (направление в градусах) */
export function turnTemplate(doc, direction, extra = {}) {
    if (doc.documentName === 'MeasuredTemplate') return doc.update({ direction, ...extra });
    const shapes = doc.shapes.map((s, i) => i ? s.toObject() : { ...s.toObject(), rotation: direction });
    return doc.update({ shapes, ...extra });
}

/** Хук удаления шаблона в обеих версиях */
export function onDeleteTemplate(fn) {
    Hooks.on('deleteMeasuredTemplate', fn);
    Hooks.on('deleteRegion', fn);
}

/** Круглая зона на сцене: v13 — MeasuredTemplate, v14 — Регион с кругом. distance — радиус в футах */
export function createCircle(scene, { x, y, distance, fillColor, borderColor, name = t('Зона'), flags = {} }) {
    if (!regionTemplates()) {
        return scene.createEmbeddedDocuments('MeasuredTemplate', [{ t: 'circle', x, y, distance, direction: 0, fillColor, borderColor, flags }]);
    }
    const radius = distance / scene.grid.distance * scene.grid.size;
    return scene.createEmbeddedDocuments('Region', [{
        name, color: fillColor, shapes: [{ type: 'circle', x, y, radius }],
        visibility: CONST.REGION_VISIBILITY.ALWAYS, flags
    }]);
}

/** Удалить шаблоны сцены, подходящие под условие; вернуть их число */
export async function deleteTemplates(scene, filter) {
    const ids = sceneTemplates(scene).filter(filter).map(t => t.id);
    if (ids.length) await scene.deleteEmbeddedDocuments(regionTemplates() ? 'Region' : 'MeasuredTemplate', ids);
    return ids.length;
}
