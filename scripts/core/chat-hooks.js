/**
 * Gacha Roguelike dnd5e — Подписка на отрисовку сообщений чата
 *
 * Foundry v13 передаёт HTMLElement в renderChatMessageHTML, а renderChatMessage (jQuery) устарел;
 * v12 знает только renderChatMessage. Подписка выбирается по версии при инициализации,
 * обработчик всегда получает HTMLElement.
 */

export function onRenderChatMessage(handler) {
    // Ошибка одного обработчика не мешает остальным и видна в журнале с местом, где случилась
    const safe = (message, html) => {
        try { return handler(message, html); }
        catch (error) { console.error(`gachadnd | отрисовка сообщения чата`, error); }
    };
    Hooks.once('init', () => {
        if ((game.release?.generation ?? 12) >= 13) Hooks.on('renderChatMessageHTML', (message, html) => safe(message, html));
        else Hooks.on('renderChatMessage', (message, html) => safe(message, html?.[0] ?? html));
    });
}

/**
 * Предмет и активность сообщения dnd5e. Если предмета уже нет (навык сгорел, карточку сделал модуль),
 * dnd5e 6 падает внутри getAssociatedItem — тогда просто null
 */
export function messageItem(message) {
    try { return message?.getAssociatedItem?.() ?? null; } catch { return null; }
}
export function messageActivity(message) {
    try { return message?.getAssociatedActivity?.() ?? null; } catch { return null; }
}
