/**
 * Gacha Roguelike dnd5e — Тетрис: головоломка сборки
 *
 * Как ремонт модулей в Arknights: Endfield — смесь пазла и японского кроссворда. Поле 5×5, у каждой
 * строки и столбца число: сколько клеток в нём должно быть занято. Нужно поставить все детали
 * (тетрамино, их можно поворачивать) так, чтобы совпали все числа. Запрещённые клетки занимать нельзя.
 *
 * Головоломка всегда решаема: детали сначала раскладываются случайно, и числа считаются по этой
 * раскладке. Подходит любое решение с теми же числами, не обязательно исходное.
 *
 * Без Foundry: только данные, чтобы файл проверялся отдельно.
 */

export const SIZE = 5;
export const PIECE_COUNT = 4;

// Тетрамино в исходном положении (x вправо, y вниз)
export const SHAPES = {
    I: [[0, 0], [1, 0], [2, 0], [3, 0]],
    O: [[0, 0], [1, 0], [0, 1], [1, 1]],
    T: [[0, 0], [1, 0], [2, 0], [1, 1]],
    S: [[1, 0], [2, 0], [0, 1], [1, 1]],
    Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
    L: [[0, 0], [0, 1], [0, 2], [1, 2]],
    J: [[1, 0], [1, 1], [1, 2], [0, 2]]
};

/** Клетки сдвинуты к началу координат и упорядочены: одинаковые фигуры дают одинаковый список */
export function normalize(cells) {
    const minX = Math.min(...cells.map(c => c[0])), minY = Math.min(...cells.map(c => c[1]));
    return cells.map(([x, y]) => [x - minX, y - minY]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** Поворот на 90° по часовой rot раз */
export function rotate(cells, rot = 0) {
    let out = cells;
    for (let i = 0; i < ((rot % 4) + 4) % 4; i++) out = out.map(([x, y]) => [-y, x]);
    return normalize(out);
}

/** Клетки детали на поле: поворот и сдвиг */
export function pieceCells(piece, { rot = 0, x = 0, y = 0 }) {
    return rotate(piece.cells, rot).map(([cx, cy]) => [cx + x, cy + y]);
}

const key = (x, y) => `${x},${y}`;

/** Детерминированный генератор: одна и та же головоломка по одному и тому же зерну */
function random(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

/**
 * Новая головоломка.
 * @param {number} seed
 * @returns {{seed, size, blocked: number[][], rows: number[], cols: number[], pieces: {id, type, cells}[], placed: {}, solved: false}}
 */
export function generate(seed = Math.floor(Math.random() * 2 ** 31)) {
    const rand = random(seed);
    const pick = list => list[Math.floor(rand() * list.length)];
    for (let attempt = 0; attempt < 500; attempt++) {
        const blocked = [];
        const blockedCount = 1 + Math.floor(rand() * 2);
        while (blocked.length < blockedCount) {
            const cell = [Math.floor(rand() * SIZE), Math.floor(rand() * SIZE)];
            if (!blocked.some(b => b[0] === cell[0] && b[1] === cell[1])) blocked.push(cell);
        }
        const taken = new Set(blocked.map(([x, y]) => key(x, y)));
        const pieces = [];
        for (let n = 0; n < PIECE_COUNT; n++) {
            const type = pick(Object.keys(SHAPES));
            const piece = { id: `p${n}`, type, cells: normalize(SHAPES[type]) };
            // Все положения детали, которые помещаются в свободные клетки
            const options = [];
            for (let rot = 0; rot < 4; rot++) {
                for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
                    const cells = pieceCells(piece, { rot, x, y });
                    if (cells.every(([cx, cy]) => cx < SIZE && cy < SIZE && !taken.has(key(cx, cy)))) options.push(cells);
                }
            }
            if (!options.length) break;
            for (const [cx, cy] of pick(options)) taken.add(key(cx, cy));
            pieces.push(piece);
        }
        if (pieces.length < PIECE_COUNT) continue;
        const filled = [...taken].filter(k => !blocked.some(([x, y]) => key(x, y) === k)).map(k => k.split(',').map(Number));
        const rows = Array.from({ length: SIZE }, (_, y) => filled.filter(c => c[1] === y).length);
        const cols = Array.from({ length: SIZE }, (_, x) => filled.filter(c => c[0] === x).length);
        // Пустая строка или столбец — слишком лёгкая подсказка; полная — тоже
        if ([...rows, ...cols].filter(v => v === 0 || v === SIZE).length > 2) continue;
        return { seed, size: SIZE, blocked, rows, cols, pieces, placed: {}, solved: false };
    }
    throw new Error('Тетрис: не удалось сложить головоломку');
}

/** Занятые клетки: ключ клетки → id детали */
export function occupancy(puzzle) {
    const map = new Map();
    for (const piece of puzzle.pieces) {
        const at = puzzle.placed[piece.id];
        if (at) for (const [x, y] of pieceCells(piece, at)) map.set(key(x, y), piece.id);
    }
    return map;
}

/** Можно ли поставить деталь сюда (сама деталь при проверке не учитывается) */
export function canPlace(puzzle, piece, at) {
    const busy = occupancy(puzzle);
    const blocked = new Set(puzzle.blocked.map(([x, y]) => key(x, y)));
    return pieceCells(piece, at).every(([x, y]) => x >= 0 && y >= 0 && x < puzzle.size && y < puzzle.size
        && !blocked.has(key(x, y)) && (!busy.has(key(x, y)) || busy.get(key(x, y)) === piece.id));
}

/** Сколько клеток занято в каждой строке и столбце сейчас */
export function counts(puzzle) {
    const rows = Array(puzzle.size).fill(0), cols = Array(puzzle.size).fill(0);
    for (const k of occupancy(puzzle).keys()) {
        const [x, y] = k.split(',').map(Number);
        rows[y]++; cols[x]++;
    }
    return { rows, cols };
}

/** Собрано: все детали стоят, все числа совпали */
export function isSolved(puzzle) {
    if (puzzle.pieces.some(p => !puzzle.placed[p.id])) return false;
    const { rows, cols } = counts(puzzle);
    return rows.every((v, i) => v === puzzle.rows[i]) && cols.every((v, i) => v === puzzle.cols[i]);
}

/** Фигура собранной головоломки: занятые клетки поля */
export function figure(puzzle) {
    return [...occupancy(puzzle).keys()].map(k => k.split(',').map(Number));
}
