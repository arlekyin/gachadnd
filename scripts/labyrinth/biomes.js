/**
 * Gacha Roguelike dnd5e — Биомы этажей
 *
 * У этажа свой биом; на длинном этаже Застава делит его надвое: до неё — одно место, после — другое
 * (лес и болота → город в глуши; море → море в шторм). По биому выбираются события, их зарисовки и тексты.
 * Этажи без описанного биома — «Лабиринт».
 */

import { MODULE_ID } from "../core/constants.js";
import { mapScene } from "./scene-travel.js";
import { getFloor } from "./economy.js";

export const BIOMES = {
    swamp: { name: 'Лес и болота' },
    town: { name: 'Город в глуши' },
    sea: { name: 'Море и острова' },
    storm: { name: 'Море в шторм' },
    deep: { name: 'Глубины' },
    sky: { name: 'Небесные острова' },
    labyrinth: { name: 'Лабиринт' }
};

// Этаж → [до Заставы, после Заставы]
const FLOORS = {
    1: ['swamp', 'town'],
    2: ['sea', 'storm'],
    3: ['deep', 'deep'],
    4: ['sky', 'sky']
};

/** Биом этажа: before — до Заставы (или на этаже без неё), after — после */
export function floorBiome(floor = getFloor(), after = false) {
    const pair = FLOORS[floor];
    return pair ? pair[after ? 1 : 0] : 'labyrinth';
}

/** Отряд за Заставой: узел отряда в ряду дальше Заставы */
export function pastOutpost(map = mapScene()?.getFlag(MODULE_ID, 'floorMap')) {
    const outpost = map?.nodes?.find(n => n.type === 'outpost');
    const here = map?.nodes?.find(n => n.id === map.currentNodeId);
    return !!(outpost && here && here.row > outpost.row);
}

/** Биом там, где сейчас отряд */
export function currentBiome(map = mapScene()?.getFlag(MODULE_ID, 'floorMap'), floor = getFloor()) {
    return floorBiome(floor, pastOutpost(map));
}
