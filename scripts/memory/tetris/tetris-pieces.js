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

/** Сколько врагов должно быть в группе, чтобы она сдетонировала (союзники только связывают) */
export const ENEMIES_TO_BLAST = 2;

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
 * Группа фигуры: клетки, связанные с новой фигурой по сторонам (без диагоналей), через блоки
 * и клетки под существами. Как в Puyo Puyo: группа лопается целиком.
 * @param {string[]} seed          Клетки новой фигуры, ключи «x,y» в клетках сетки.
 * @param {Set<string>} blocks     Клетки всех блоков (включая новую фигуру).
 * @param {Map<string, string>} creatures  Клетка → id существа, которое её занимает.
 * @returns {{cells: Set<string>, creatures: Set<string>}}
 */
export function findGroup(seed, blocks, creatures) {
    const cells = new Set(), found = new Set();
    const queue = [...seed];
    while (queue.length) {
        const k = queue.pop();
        if (cells.has(k) || !(blocks.has(k) || creatures.has(k))) continue;
        cells.add(k);
        if (creatures.has(k)) found.add(creatures.get(k));
        const [x, y] = k.split(',').map(Number);
        queue.push(`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`);
    }
    return { cells, creatures: found };
}
