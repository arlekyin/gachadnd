/**
 * Gacha Roguelike dnd5e — Формулы в описаниях навыков
 *
 * [[gacha 2d4 + @prof]] показывает формулу с подставленными значениями персонажа:
 * детерминированная часть сворачивается в число (2 * @prof + @details.level → 6),
 * кости остаются (2d4 + 2). Без данных персонажа (компендиум) выводится словесная запись.
 */

const SYMBOLIC = [
    [/@prof/g, 'БМ'],
    [/@details\.level/g, 'ур.'],
    [/@abilities\.(\w+)\.mod/g, (_, a) => `мод. ${CONFIG.DND5E?.abilities?.[a]?.abbreviation ?? a}`]
];

export function formatGachaFormula(formula, rollData) {
    if (!rollData?.prof) {
        return SYMBOLIC.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), formula);
    }

    const resolved = Roll.replaceFormulaData(formula, rollData, { missing: '0' });
    try {
        const roll = new Roll(resolved);
        if (roll.isDeterministic) {
            const total = roll.evaluateSync ? roll.evaluateSync().total : roll.evaluate({ async: false }).total;
            return String(total);
        }
        return dnd5e?.dice?.simplifyRollFormula?.(resolved) || resolved;
    } catch (err) {
        console.warn(`[GachaDND] Не удалось обработать формулу «${formula}»:`, err);
        return resolved;
    }
}

export function registerGachaEnrichers() {
    CONFIG.TextEditor.enrichers.push({
        pattern: /\[\[gacha (?<formula>[^\]]+)]]/gi,
        enricher: async (match, options) => {
            const rollData = options?.rollData ?? options?.relativeTo?.getRollData?.() ?? null;
            const span = document.createElement('span');
            span.className = 'gachadnd-formula';
            span.textContent = formatGachaFormula(match.groups.formula.trim(), rollData);
            return span;
        }
    });
}
