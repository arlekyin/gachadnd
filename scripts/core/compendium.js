/**
 * Gacha Roguelike dnd5e — Интеграция фильтров в окно компендиума
 */

import { MODULE_ID } from "./constants.js";

Hooks.on('renderCompendium', async (app, html, data) => {
    const compendium = app.collection;
    
    // 1. Применяем ко ВСЕМ компендиумам, в ID или названии которых есть 'gacha'
    const idMatch = compendium.metadata.id.toLowerCase().includes('gacha');
    const labelMatch = compendium.metadata.label.toLowerCase().includes('gacha');
    if (!idMatch && !labelMatch) return;

    const element = html instanceof jQuery ? html[0] : html;

    // 2. Жёсткая защита от дублирования (проверяем ДО асинхронного запроса)
    if (element.querySelector('.gachadnd-compendium-filters')) return;

    // Создаем контейнер-заглушку, чтобы "застолбить" место и предотвратить дублирование
    const header = element.querySelector('.directory-header');
    if (!header) return;

    const filterDiv = document.createElement('div');
    filterDiv.className = 'gachadnd-compendium-filters';
    filterDiv.style.cssText = 'display: flex; gap: 6px; padding: 6px 8px; background: rgba(0, 0, 0, 0.3); border-bottom: 1px solid var(--color-border-light-primary); flex-wrap: wrap; align-items: center;';
    filterDiv.innerHTML = `<div style="color: #888; font-size: 12px; width: 100%; text-align: center; font-style: italic;">Анализ Тумана...</div>`;
    header.insertAdjacentElement('afterend', filterDiv);

    // 3. Запрашиваем индекс и флаги
    const index = await compendium.getIndex({ 
        fields: [`flags.${MODULE_ID}.tags`, `flags.${MODULE_ID}.category`, `flags.${MODULE_ID}.rarity`] 
    });

    // 4. Собираем уникальные значения
    const tags = new Set();
    const categories = new Set();
    const rarities = new Set();
    
    index.forEach(item => {
        const flags = item.flags?.[MODULE_ID] || {};
        if (flags.category) categories.add(flags.category);
        if (flags.rarity) rarities.add(flags.rarity);
        if (Array.isArray(flags.tags)) {
            flags.tags.forEach(t => tags.add(t.toLowerCase().trim()));
        }
    });

    // 5. Отрисовываем фильтры (убираем фильтр редкости, если в компендиуме её нет)
    const hasRarity = rarities.size > 0;

    filterDiv.innerHTML = `
        <select id="gacha-filter-cat" style="flex: 1; min-width: 80px; height: 26px; font-size: 13px; background: rgba(0,0,0,0.6); color: #f0f0e0; border: 1px solid #555; border-radius: 3px; cursor: pointer; outline: none;">
            <option value="all">Все категории</option>
            ${Array.from(categories).sort().map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <select id="gacha-filter-tag" style="flex: 1; min-width: 80px; height: 26px; font-size: 13px; background: rgba(0,0,0,0.6); color: #f0f0e0; border: 1px solid #555; border-radius: 3px; cursor: pointer; outline: none;">
            <option value="all">Все теги</option>
            ${Array.from(tags).sort().map(t => `<option value="${t}">[${t}]</option>`).join('')}
        </select>
        ${hasRarity ? `
        <select id="gacha-filter-rarity" style="flex: 1; min-width: 80px; height: 26px; font-size: 13px; background: rgba(0,0,0,0.6); color: #f0f0e0; border: 1px solid #555; border-radius: 3px; cursor: pointer; outline: none;">
            <option value="all">Все редкости</option>
            <option value="gray" style="color: #9d9d9d;">Серые</option>
            <option value="green" style="color: #1eff00;">Зеленые</option>
            <option value="blue" style="color: #0070dd;">Синие</option>
            <option value="purple" style="color: #a335ee;">Фиолетовые</option>
            <option value="red" style="color: #ff003c;">Красные</option>
            <option value="orange" style="color: #ff8000;">Оранжевые</option>
        </select>
        ` : ''}
    `;

    // 6. Функция моментальной фильтрации
    const applyFilters = () => {
        const catSelect = element.querySelector('#gacha-filter-cat');
        const tagSelect = element.querySelector('#gacha-filter-tag');
        const raritySelect = element.querySelector('#gacha-filter-rarity');

        const cat = catSelect ? catSelect.value : 'all';
        const tag = tagSelect ? tagSelect.value : 'all';
        const rarity = raritySelect ? raritySelect.value : 'all';

        element.querySelectorAll('.directory-list .directory-item').forEach(li => {
            const id = li.dataset.documentId || li.dataset.entryId;
            const itemMeta = index.get(id);
            if (!itemMeta) return;

            const flags = itemMeta.flags?.[MODULE_ID] || {};
            const itemCat = flags.category || '';
            const itemRarity = flags.rarity || 'gray';
            const itemTags = (flags.tags || []).map(t => t.toLowerCase().trim());

            let match = true;
            if (cat !== 'all' && itemCat !== cat) match = false;
            if (tag !== 'all' && !itemTags.includes(tag)) match = false;
            if (rarity !== 'all' && itemRarity !== rarity) match = false;

            // Принудительное скрытие, которое Foundry не сможет перебить обычными стилями
            if (match) {
                li.style.setProperty('display', '', 'important');
            } else {
                li.style.setProperty('display', 'none', 'important');
            }
        });
    };

    // 7. Мгновенная реакция на любое изменение в выпадающих списках
    element.querySelectorAll('.gachadnd-compendium-filters select').forEach(select => {
        select.addEventListener('change', applyFilters);
    });

    // 8. Совместимость с базовым текстовым поиском Foundry
    const searchInput = element.querySelector('input[name="search"]');
    if (searchInput) {
        // Когда Foundry применяет свой поиск, мы даем ему 50мс и сверху накладываем свои фильтры
        searchInput.addEventListener('keyup', () => setTimeout(applyFilters, 50));
        searchInput.addEventListener('search', () => setTimeout(applyFilters, 50));
    }
});
// Компендиум навыков и правила открыты всем игрокам. Права из module.json — лишь значение по умолчанию:
// Foundry хранит права компендиумов в настройках мира, и сохранённое там значение их перекрывает.
// При запуске Мастер поднимает права до Наблюдателя, если у Игрока или Доверенного они ниже
const OPEN_PACKS = ['gacha-skills', 'gacha-rules'];
Hooks.once('ready', async () => {
    if (!game.user.isGM || !(game.user.isActiveGM ?? true)) return;
    const levels = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    for (const name of OPEN_PACKS) {
        const pack = game.packs.get(`${MODULE_ID}.${name}`);
        if (!pack?.configure) continue;
        const ownership = { ...(pack.ownership ?? pack.config?.ownership ?? {}) };
        let changed = false;
        for (const role of ['PLAYER', 'TRUSTED']) {
            if ((levels[ownership[role]] ?? -1) < levels.OBSERVER) {
                ownership[role] = 'OBSERVER';
                changed = true;
            }
        }
        if (!changed) continue;
        await pack.configure({ ownership });
        console.log(`${MODULE_ID} | ${pack.metadata.label}: игрокам открыт просмотр`);
    }
});
