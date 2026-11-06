/**
 * Gacha Roguelike dnd5e — Биомы этажей
 *
 * У этажа свой биом; на длинном этаже Застава делит его надвое: до неё — одно место, после — другое
 * (лес и болота → город в глуши; катакомбы → пещеры). По биому выбираются события, их зарисовки и тексты.
 * Этажи без описанного биома — «Лабиринт».
 */

import { MODULE_ID } from "../core/constants.js";
import { mapScene } from "./scene-travel.js";
import { getFloor } from "./economy.js";
import { t } from "../core/i18n.js";

export const BIOMES = {
    swamp: { name: t('Лес и болота') },
    town: { name: t('Город в глуши') },
    sea: { name: t('Море и острова') },
    storm: { name: t('Море в шторм') },
    deep: { name: t('Глубины') },
    sky: { name: t('Небесные острова') },
    crypt: { name: t('Катакомбы') },
    caves: { name: t('Пещеры') },
    labyrinth: { name: t('Лабиринт') }
};

/**
 * Набросок местности под паутиной (слой паутины, web-overlay.js): assets/sketches/biome-<биом>.webp — монохромный
 * набросок на белом (промты — docs/sketch-prompts.md). Пока рисунка нет, у болота — зарисовка «Огоньки над трясиной».
 */
export const BIOME_ART = {
    swamp: 'modules/gachadnd/assets/sketches/swamp-lights.webp'
};
export const biomeArt = biome => BIOME_ART[biome] ?? `modules/gachadnd/assets/sketches/biome-${biome}.webp`;

// Этаж → [до Заставы, после Заставы]
const FLOORS = {
    1: ['swamp', 'town'],
    // Подземелья (docs/dungeon-floor.md); море и шторм — куда переедут, решим позже
    2: ['crypt', 'caves'],
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
    const here = map?.nodes?.find(n => n.id === map.currentNodeId);
    if (map?.mode === 'web') return ['inner', 'boss'].includes(here?.ring);
    const outpost = map?.nodes?.find(n => n.type === 'outpost');
    return !!(outpost && here && here.row > outpost.row);
}

/** Биом там, где сейчас отряд */
export function currentBiome(map = mapScene()?.getFlag(MODULE_ID, 'floorMap'), floor = getFloor()) {
    return floorBiome(floor, pastOutpost(map));
}
