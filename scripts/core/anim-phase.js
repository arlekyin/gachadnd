/**
 * Gacha Roguelike dnd5e — непрерывные анимации при перерисовке
 *
 * Перерисовка окна создаёт элементы заново, и их CSS-анимации начинаются с нуля: вращающееся
 * кольцо рун прыгает к начальному углу. После перерисовки бесконечные анимации ставятся на общие
 * часы страницы — кольцо продолжает с того же места, будто перерисовки не было. Однократные
 * анимации (вспышка новой руны, отблеск) не трогаются.
 */

export function keepPhase(root) {
    if (!root?.getAnimations || !document.timeline) return;
    const now = document.timeline.currentTime;
    for (const animation of root.getAnimations({ subtree: true })) {
        if (animation.effect?.getTiming?.().iterations === Infinity) animation.currentTime = now;
    }
}

/**
 * Плавное включение и выключение после перерисовки. Перерисовка создаёт элементы заново, и класс
 * «горит» меняется мгновенно — CSS-переходы не успевают сработать. Здесь элементы сравниваются с
 * прошлой перерисовкой по порядку: у изменившихся вид плавно идёт от прежнего к новому.
 * @param {Element[]} elements   Элементы в постоянном порядке (например, все части круга ритуала).
 * @param {boolean[]|null} previous  Что горело в прошлый раз (результат прошлого вызова).
 * @param {(el: Element) => string} litClass  Каким классом этот элемент показывает «горит».
 * @returns {boolean[]}  Что горит сейчас — передать в следующий вызов.
 */
export function softenToggles(elements, previous, litClass, { duration = 700 } = {}) {
    const state = elements.map(el => el.classList.contains(litClass(el)));
    if (!previous || previous.length !== state.length || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return state;
    const read = el => {
        const s = getComputedStyle(el);
        return { opacity: s.opacity, strokeWidth: s.strokeWidth, filter: s.filter };
    };
    elements.forEach((el, i) => {
        if (previous[i] === state[i]) return;
        // На время замера CSS-переходы выключены: иначе прежний вид прочитался бы как начало перехода
        const transition = el.style.transition;
        el.style.transition = 'none';
        const cls = litClass(el), to = read(el);
        el.classList.toggle(cls, previous[i]);
        const from = read(el);
        el.classList.toggle(cls, state[i]);
        read(el);
        el.style.transition = transition;
        el.animate([from, to], { duration, easing: 'ease-in-out' });
    });
    return state;
}
