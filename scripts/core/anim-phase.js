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
