/**
 * Gacha Roguelike dnd5e — Подписка на отрисовку сообщений чата
 *
 * Foundry v13 передаёт HTMLElement в renderChatMessageHTML, а renderChatMessage (jQuery) устарел;
 * v12 знает только renderChatMessage. Подписка выбирается по версии при инициализации,
 * обработчик всегда получает HTMLElement.
 */

export function onRenderChatMessage(handler) {
    Hooks.once('init', () => {
        if ((game.release?.generation ?? 12) >= 13) Hooks.on('renderChatMessageHTML', (message, html) => handler(message, html));
        else Hooks.on('renderChatMessage', (message, html) => handler(message, html?.[0] ?? html));
    });
}
