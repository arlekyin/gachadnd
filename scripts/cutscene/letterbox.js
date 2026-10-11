/**
 * Катсцены — кинополосы сверху и снизу. Поверх всего, не наклоняются с камерой.
 */

/** @param {number} fraction  Доля высоты экрана на каждую полосу. */
export function letterbox(fraction = 0.11) {
    const bars = ['top', 'bottom'].map(side => {
        const bar = document.createElement('div');
        bar.className = `gd-letterbox gd-letterbox-${side}`;
        bar.style.height = `${fraction * 100}vh`;
        document.body.append(bar);
        return bar;
    });
    const show = k => bars.forEach((bar, i) => bar.style.transform = `translateY(${(i ? 1 : -1) * (1 - k) * 100}%)`);
    show(0);
    return { show, remove: () => bars.forEach(bar => bar.remove()) };
}
