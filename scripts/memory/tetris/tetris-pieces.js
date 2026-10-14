/**
 * Gacha Roguelike dnd5e — Тетрис: фигуры, очередь и линии
 *
 * Без Foundry: только данные, чтобы файл проверялся отдельно.
 */

// Тетрамино в исходном положении (x вправо, y вниз) и классические цвета
export const SHAPES = {
    I: [[0, 0], [1, 0], [2, 0], [3, 0]],
    O: [[0, 0], [1, 0], [0, 1], [1, 1]],
    T: [[0, 0], [1, 0], [2, 0], [1, 1]],
    S: [[1, 0], [2, 0], [0, 1], [1, 1]],
    Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
    L: [[0, 0], [0, 1], [0, 2], [1, 2]],
    J: [[1, 0], [1, 1], [1, 2], [0, 2]]
};
export const COLORS = { I: '#3fd6e8', O: '#ffd43b', T: '#b265ff', S: '#5fdc5a', Z: '#ff4d5e', L: '#ff9a3c', J: '#4d7dff' };
export const TYPES = Object.keys(SHAPES);

/** Сколько блоков подряд по прямой сгорают линией */
export const LINE = 5;

/** Клетки сдвинуты к началу координат */
export function normalize(cells) {
    const minX = Math.min(...cells.map(c => c[0])), minY = Math.min(...cells.map(c => c[1]));
    return cells.map(([x, y]) => [x - minX, y - minY]);
}

/**
 * Клетки фигуры относительно клетки под курсором, с поворотом на 90° rot раз.
 * Поворот — вокруг середины фигуры: под курсором остаётся её центр, фигура не «прыгает».
 */
export function shapeCells(type, rot = 0) {
    let cells = SHAPES[type].map(([x, y]) => [x, y]);
    for (let i = 0; i < ((rot % 4) + 4) % 4; i++) cells = cells.map(([x, y]) => [-y, x]);
    cells = normalize(cells);
    const w = Math.max(...cells.map(c => c[0])), h = Math.max(...cells.map(c => c[1]));
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    return cells.map(([x, y]) => [x - cx, y - cy]);
}

/**
 * Следующая фигура из «мешка»: семь разных фигур в случайном порядке, потом новый мешок —
 * как в современном тетрисе, без долгих серий одной фигуры.
 * @returns {{type: string, bag: string[]}}
 */
export function draw(bag = [], random = Math.random) {
    let rest = [...bag];
    if (!rest.length) {
        rest = [...TYPES];
        for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }
    }
    const type = rest.shift();
    return { type, bag: rest };
}

/**
 * Линии: LINE и больше блоков подряд по строке или столбцу. Горят и горизонтальные, и вертикальные.
 * @param {Iterable<string>} keys  Клетки блоков, ключи «x,y» в клетках сетки.
 * @returns {Set<string>} клетки, которые сгорают
 */
export function findLines(keys) {
    const set = new Set(keys);
    const burn = new Set();
    const cells = [...set].map(k => k.split(',').map(Number));
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
        for (const [x, y] of cells) {
            // Начало ряда: перед клеткой блока нет
            if (set.has(`${x - dx},${y - dy}`)) continue;
            const run = [];
            for (let n = 0; set.has(`${x + dx * n},${y + dy * n}`); n++) run.push(`${x + dx * n},${y + dy * n}`);
            if (run.length >= LINE) run.forEach(k => burn.add(k));
        }
    }
    return burn;
}
