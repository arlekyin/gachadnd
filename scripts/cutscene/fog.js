/**
 * Катсцены — густой туман Предела: тёмная бирюза с чёрными провалами. Наползает от краёв к центру и
 * отступает обратно; при полном покрытии закрывает экран целиком (под ним можно сменить сцену).
 *
 * Туман считается на маленьком холсте (192×108) и растягивается браузером с размытием: клубы мягкие,
 * а кадр стоит пару миллисекунд. Холст — элемент страницы поверх всего, смену сцены Foundry переживает.
 */

const GW = 192, GH = 108;

// Шум значений на решётке с перестановкой: плавные пятна без швов
const PERM = (() => {
    const p = Array.from({ length: 256 }, (_, i) => i);
    let s = 1234567;
    for (let i = 255; i > 0; i--) {
        s = (s * 16807) % 2147483647;
        const j = s % (i + 1);
        [p[i], p[j]] = [p[j], p[i]];
    }
    return [...p, ...p];
})();
const VALUES = PERM.map(v => v / 255);
const lattice = (x, y) => VALUES[PERM[(x & 255) + PERM[y & 255]]];
function noise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lattice(ix, iy), b = lattice(ix + 1, iy), c = lattice(ix, iy + 1), d = lattice(ix + 1, iy + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}
function fbm(x, y) {
    let v = 0, amp = 0.5;
    for (let o = 0; o < 4; o++) { v += amp * noise(x, y); x *= 2.03; y *= 2.03; amp *= 0.5; }
    return v / 0.9375;
}

/**
 * Нарисовать туман в данные картинки: покрытие cover (0…1), время seconds для дрейфа клубов.
 * Туман приходит с краёв картинки к центру.
 */
export function paintFog(image, cover, seconds = 0) {
    const { width: w, height: h, data: px } = image, aspect = w / h, t = seconds;
    const reach = Math.hypot(0.5 * aspect, 0.5);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const u = x / w, v = y / h;
            const edge = Math.min(1, Math.hypot((u - 0.5) * aspect, v - 0.5) / reach);
            const n = fbm(u * 5 + t * 0.12, v * 5 - t * 0.05);
            const m = fbm(u * 2.2 - t * 0.04 + 9.1, v * 2.2 + t * 0.03 + 3.7);
            const a = Math.max(0, Math.min(1, cover * 1.9 - 0.95 + edge * 0.8 + (n - 0.5) * 0.9));
            // Цвет: бирюзовая глубина, светлее в густых клубах, местами провалы в черноту
            const lift = Math.max(0, n - 0.45) * 1.6, black = Math.max(0, Math.min(1, (m - 0.52) * 3.2));
            const k = (1 - black) * (0.35 + lift);
            const i = (y * w + x) * 4;
            px[i] = 2 * k;
            px[i + 1] = 105 * k + 6 * (1 - black);
            px[i + 2] = 100 * k + 6 * (1 - black);
            px[i + 3] = a * 255;
        }
    }
}

/**
 * Слой тумана во весь экран.
 * @returns {{render: (cover: number, seconds: number) => void, remove: Function}}
 *   cover — 0 нет тумана, 1 экран закрыт полностью; seconds — время для дрейфа клубов.
 */
export function fogLayer() {
    const canvas = document.createElement('canvas');
    canvas.width = GW; canvas.height = GH;
    canvas.className = 'gd-impact gd-fog';
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(GW, GH);
    return {
        render(cover, seconds = 0) {
            paintFog(image, cover, seconds);
            ctx.putImageData(image, 0, 0);
        },
        remove: () => canvas.remove()
    };
}
