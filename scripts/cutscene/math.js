/**
 * Катсцены — кривые времени, случайность с зерном и шум.
 */

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = t => Math.min(1, Math.max(0, t));
export const smooth = t => t * t * (3 - 2 * t);
export const easeIn = t => t * t * t;
export const easeOut = t => 1 - (1 - t) ** 3;
export const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
// Пружина: 0 → 1 с перелётом и затухающими колебаниями
export const springTo = t => t >= 1 ? 1 : 1 - Math.exp(-5 * t) * Math.cos(t * Math.PI * 2.6);
// Затухающее колебание около нуля после толчка: x — время в долях, 0 → 1; decay — затухание,
// cycles — сколько колебаний
export const wobble = (x, decay = 4.5, cycles = 2.5) => x >= 1 || x < 0 ? 0 : Math.exp(-decay * x) * Math.cos(x * Math.PI * 2 * cycles);

/** Случайные числа 0…1 с зерном: один и тот же рисунок при каждом показе */
export function seeded(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Шум значений: плавные пятна на квадрате −0,75…0,75 — для клочьев, волн и неровностей */
export function valueNoise(seed, cells = 9) {
    const rnd = seeded(seed), grid = Array.from({ length: (cells + 1) ** 2 }, () => rnd());
    return (u, v) => {
        const x = (u + 0.75) / 1.5 * cells, y = (v + 0.75) / 1.5 * cells;
        const ix = Math.max(0, Math.min(cells - 1, Math.floor(x))), iy = Math.max(0, Math.min(cells - 1, Math.floor(y)));
        const fx = x - ix, fy = y - iy, at = (a, b) => grid[(iy + b) * (cells + 1) + ix + a];
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        return (at(0, 0) * (1 - sx) + at(1, 0) * sx) * (1 - sy) + (at(0, 1) * (1 - sx) + at(1, 1) * sx) * sy;
    };
}
