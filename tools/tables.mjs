/**
 * Сборка таблиц встреч: src/tables/encounters.yaml → dist/packs/gacha-tables/*.json (случайные таблицы Foundry).
 *
 * По таблице на стаю: «Встречи: <биом>: <стая>», папка — биом. Строка — монстр SRD (ссылка на компендиум
 * dnd5e.monsters) с весом. Модуль читает таблицы из компендиума, а таблица мира с тем же названием её заменяет
 * (scripts/labyrinth/encounters.js) — так Мастер правит стаи без кода.
 */

import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

// Названия биомов — как в scripts/labyrinth/biomes.js (BIOMES): по ним модуль находит таблицы
export const BIOME_NAMES = { swamp: 'Лес и болота', town: 'Город в глуши', sea: 'Море и острова', storm: 'Море в шторм', deep: 'Глубины', sky: 'Небесные острова', labyrinth: 'Лабиринт' };
export const TABLE_PREFIX = 'Встречи';
const SRC = './src/tables/encounters.yaml';
const SRD = 'Compendium.dnd5e.monsters.Actor';
const COLORS = { swamp: '#2f4a2f', town: '#4a3a2a' };

export function buildTables({ distDir, stableId }) {
    const out = path.join(distDir, 'gacha-tables');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const data = yaml.load(fs.readFileSync(SRC, 'utf8')) ?? {};
    const tables = [];
    let sortFolder = 100;
    for (const [biome, groups] of Object.entries(data)) {
        const biomeName = BIOME_NAMES[biome];
        if (!biomeName) throw new Error(`${SRC}: неизвестный биом «${biome}» (${Object.keys(BIOME_NAMES).join(', ')})`);
        const folderId = stableId('tables', 'folder', biome);
        const folder = {
            _id: folderId, name: biomeName, type: 'RollTable', folder: null, sorting: 'a', sort: sortFolder += 100, color: COLORS[biome] ?? null,
            description: '', flags: {}, _key: `!folders!${folderId}`
        };
        fs.writeFileSync(path.join(out, `_folder_${biomeName}_${folderId}.json`), JSON.stringify(folder, null, 2) + '\n', 'utf8');
        let sort = 0;
        for (const [group, members] of Object.entries(groups ?? {})) {
            if (!Array.isArray(members) || !members.length) throw new Error(`${SRC}: стая «${group}» (${biome}) пуста`);
            const id = stableId('tables', biome, group);
            let from = 1;
            const results = members.map((m, i) => {
                if (!m?.name || !m?.srd) throw new Error(`${SRC}: «${group}» — у строки ${i + 1} нет name или srd`);
                const weight = Math.max(1, Number(m.weight) || 1);
                const rid = stableId('tables', biome, group, m.name);
                const r = {
                    _id: rid, type: 'document', name: m.name, img: m.img ?? 'icons/svg/mystery-man.svg', description: '',
                    documentUuid: `${SRD}.${m.srd}`, weight, range: [from, from + weight - 1], drawn: false, flags: {},
                    _key: `!tables.results!${id}.${rid}`
                };
                from += weight;
                return r;
            });
            const table = {
                _id: id, name: `${TABLE_PREFIX}: ${biomeName}: ${group}`, img: 'icons/svg/skull.svg', folder: folderId, sort: sort += 100,
                description: `<p>Стая встреч на боевых узлах (биом «${biomeName}»). Строки — монстры и их веса: чаще встаёт тот, у кого вес больше; вожака модуль выбирает по силе. Чтобы изменить стаю, импортируйте таблицу в мир и правьте копию — название оставьте тем же. Новая таблица с названием «${TABLE_PREFIX}: ${biomeName}: …» добавит стаю.</p>`,
                formula: `1d${from - 1}`, replacement: true, displayRoll: true, results,
                flags: { gachadnd: { encounter: { biome, group } } }, _key: `!tables!${id}`
            };
            fs.writeFileSync(path.join(out, `${table.name.replace(/[:\\/]/g, ' -')}_${id}.json`), JSON.stringify(table, null, 2) + '\n', 'utf8');
            tables.push(table);
        }
    }
    return tables;
}
