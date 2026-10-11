/**
 * Gacha Roguelike dnd5e — Катсцены: общая основа для рисованных сцен в Foundry.
 *
 *  math.js        — кривые времени, пружины, случайность с зерном, шум.
 *  camera.js      — камера сцены: наезд, поворот, сдвиг, вписывание точек в кадр, тряска.
 *  letterbox.js   — кинополосы.
 *  stage.js       — фильтры всей сцены (ч/б), копии токенов, скрытие токенов и их значков.
 *  overlay.js     — холсты поверх экрана, негатив кадра, уборка за оборвавшейся сценой.
 *  ripple.js      — волны на воде по кадру (шейдер WebGL).
 *  audio.js       — синтез звука: шина с басом и ревербацией, реестр звуков сцен, приглушение
 *                   музыки, провалы в тишину.
 *  instruments.js — инструменты синтеза: удары, бас, треск, стекло, свист.
 *
 * Сцены строятся из этих частей; пример — удар Сайтамы (memory/effects/impact-knock.js,
 * impact-fists.js, звуки — impact-sound.js).
 */

export * from "./math.js";
export * from "./camera.js";
export * from "./letterbox.js";
export * from "./stage.js";
export * from "./overlay.js";
export * from "./ripple.js";
export * from "./audio.js";
export * from "./instruments.js";
