/**
 * Броски по формулам dnd5e без Foundry: «2d8 + @abilities.str.mod», «(@prof + 1)d8», «max(@abilities.dex.mod, 1)».
 * Ссылки @путь берутся из данных персонажа, метки урона [fire] отбрасываются. Неизвестная ссылка — 0.
 */

const FUNCTIONS = { floor: Math.floor, ceil: Math.ceil, round: Math.round, max: Math.max, min: Math.min, abs: Math.abs };
const SAFE = /^[0-9+\-*/(). ,]*$/;

const getPath = (data, path) => path.split('.').reduce((value, key) => value?.[key], data);

function substitute(formula, data) {
    return String(formula ?? '0')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/@([A-Za-z_][\w.]*)/g, (_, path) => {
            const value = getPath(data, path);
            return Number.isFinite(Number(value)) ? ` ${Number(value)} ` : ' 0 ';
        });
}

function evaluate(expression) {
    const text = expression.trim() || '0';
    // Кроме чисел и знаков допустимы только имена функций из списка
    if (!SAFE.test(text.replace(/\b(floor|ceil|round|max|min|abs)\b/g, ''))) throw new Error(`Формула не поддерживается: ${text}`);
    const names = Object.keys(FUNCTIONS);
    return Number(new Function(...names, `return (${text});`)(...names.map(n => FUNCTIONS[n]))) || 0;
}

/**
 * @param {string} formula
 * @param {object} data           Данные для @ссылок.
 * @param {object} [options]
 * @param {'roll'|'avg'} [options.mode]  Бросок или среднее.
 * @param {boolean} [options.crit]       Крит: кости удваиваются.
 * @param {Function} [options.rng]
 */
export function rollFormula(formula, data = {}, { mode = 'roll', crit = false, rng = Math.random } = {}) {
    let text = substitute(formula, data);
    const dice = (count, faces) => {
        count = Math.max(0, Math.floor(count)) * (crit ? 2 : 1);
        if (mode === 'avg') return count * (faces + 1) / 2;
        let total = 0;
        for (let i = 0; i < count; i++) total += 1 + Math.floor(rng() * faces);
        return total;
    };
    // Число костей в скобках: (3 + 1)d8
    text = text.replace(/\(([^()]*)\)\s*d\s*(\d+)/g, (_, count, faces) => `(${dice(evaluate(count), Number(faces))})`);
    text = text.replace(/(\d*)\s*d\s*(\d+)/g, (_, count, faces) => `(${dice(count === '' ? 1 : Number(count), Number(faces))})`);
    return evaluate(text);
}

export const average = (formula, data, crit = false) => rollFormula(formula, data, { mode: 'avg', crit });

export const d20 = (rng = Math.random) => 1 + Math.floor(rng() * 20);

/** Бросок к20 с преимуществом (1), помехой (−1) или без (0) */
export function rollD20(edge = 0, rng = Math.random) {
    const a = d20(rng);
    if (!edge) return a;
    const b = d20(rng);
    return edge > 0 ? Math.max(a, b) : Math.min(a, b);
}

/** Вероятность попасть атакой с бонусом по КД (натуральная 20 — всегда, 1 — никогда) */
export function hitChance(bonus, ac, edge = 0) {
    const p = Math.min(0.95, Math.max(0.05, (21 - (ac - bonus)) / 20));
    if (edge > 0) return 1 - (1 - p) ** 2;
    if (edge < 0) return p * p;
    return p;
}

/** Вероятность провалить спасбросок с бонусом против Сл */
export function failChance(bonus, dc) {
    return Math.min(1, Math.max(0, (dc - bonus - 1) / 20));
}
