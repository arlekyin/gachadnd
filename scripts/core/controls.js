/**
 * Gacha Roguelike dnd5e — Кнопки модуля на панели токенов
 *
 * Память и Лабиринт добавляют свои кнопки независимо. Структура панели отличается между
 * версиями Foundry (массив, Map/Collection, словарь) — добавление учитывает все три.
 */

function tokenGroup(controls) {
    if (Array.isArray(controls)) return controls.find(c => c.name === 'token');
    if (controls && typeof controls === 'object') {
        return controls.token || controls.tokens || Object.values(controls).find(c => c?.name === 'token' || c?.name === 'tokens');
    }
    return null;
}

export function addTokenTools(controls, tools) {
    const group = tokenGroup(controls);
    if (!group) return;
    group.tools ??= [];
    for (const tool of tools) {
        if (Array.isArray(group.tools)) {
            if (!group.tools.some(t => t.name === tool.name)) group.tools.push(tool);
        } else if (group.tools instanceof Map || (typeof Collection !== 'undefined' && group.tools instanceof Collection)) {
            if (!group.tools.has(tool.name)) group.tools.set(tool.name, tool);
        } else if (typeof group.tools === 'object') {
            if (!Object.values(group.tools).some(t => t?.name === tool.name)) group.tools[tool.name] = tool;
        }
    }
}
