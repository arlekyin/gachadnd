/**
 * Gacha Roguelike dnd5e — Сокет модуля
 *
 * Игроки не могут менять флаги сцены и чужие документы, поэтому их действия в Магазине и Риске
 * уходят Мастеру: сообщение { action, ... } обрабатывает зарегистрированный обработчик.
 */

import { MODULE_ID } from "./constants.js";

const SOCKET = `module.${MODULE_ID}`;
const handlers = {};

export function isActiveGM() {
    return game.user.isActiveGM ?? (game.user.isGM && game.users.activeGM?.id === game.user.id);
}

export function onSocket(action, handler) {
    handlers[action] = handler;
}

export function emit(action, data = {}) {
    game.socket.emit(SOCKET, { action, ...data });
}

export function registerSocket() {
    game.socket.on(SOCKET, message => handlers[message.action]?.(message));
}

// Предупреждение конкретному пользователю: сокет не доставляет сообщение отправителю
export function notifyUser(userId, text) {
    if (userId === game.user.id) ui.notifications.warn(text);
    else emit('notify', { userId, text });
}
onSocket('notify', message => {
    if (message.userId === game.user.id) ui.notifications.warn(message.text);
});

/**
 * Действие игрока, которое выполняет Мастер. У Мастера выполняется сразу.
 * @param {string} action   Имя обработчика, зарегистрированного через onSocket у Мастера.
 */
export function requestGM(action, payload) {
    payload = { ...payload, userId: game.user.id };
    if (isActiveGM()) return handlers[action]?.({ action, payload: { ...payload } });
    if (!game.users.activeGM) return ui.notifications.warn('Действие выполняет Мастер — дождитесь его в игре.');
    emit(action, { payload });
}
