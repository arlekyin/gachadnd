// Ручное время для стендов: requestAnimationFrame копит кадры, performance.now отдаёт заданное время.
// window.start() — нулевой момент анимации; window.step(ms) — продвинуть время до ms и отрисовать кадр.
(() => {
    let queue = [];
    window.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
    window.cancelAnimationFrame = () => {};
    const realNow = performance.now.bind(performance);
    let base = null, fake = 0;
    performance.now = () => (base === null ? realNow() : base + fake);
    window.start = () => { base = realNow(); fake = 0; };
    window.step = t => {
        fake = t;
        const q = queue;
        queue = [];
        q.forEach(cb => cb(base + t));
        window.canvas?.app?.render();
    };
    window.clockNow = () => fake;
})();
