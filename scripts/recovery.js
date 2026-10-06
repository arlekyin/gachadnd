/**
 * Gacha Roguelike dnd5e — Периоды восстановления зарядов
 *
 * Общий файл для сборки (build.mjs) и для клиента Foundry.
 * Не использует глобальные объекты Foundry на уровне модуля.
 */

// Собственные периоды модуля, регистрируются в CONFIG.DND5E.limitedUsePeriods.
// gachaFloor оставлен для навыков, собранных до перехода «этажа» на долгий отдых.
export const GACHA_PERIODS = {
    gachaFloor: { label: 'Этаж', abbreviation: 'этаж' },
    gachaRun: { label: 'Забег', abbreviation: 'забег' },
    gachaScene: { label: 'Сцена', abbreviation: 'сцена' }
};

// Значения поля `recovery` в YAML → период dnd5e
export const RECOVERY_VALUES = {
    short: { period: 'sr', label: 'короткий отдых' },
    long: { period: 'lr', label: 'длинный отдых' },
    day: { period: 'day', label: 'день' },
    turn: { period: 'turn', label: 'ход' },
    round: { period: 'turnStart', label: 'раунд' },
    combat: { period: 'initiative', label: 'бой' },
    // Долгий отдых — только после босса, поэтому «раз за этаж» = «раз за долгий отдых»
    floor: { period: 'lr', label: 'этаж' },
    run: { period: 'gachaRun', label: 'забег' },
    scene: { period: 'gachaScene', label: 'сцена' },
    none: { period: null, label: 'без восстановления' }
};

export function registerGachaPeriods() {
    const periods = CONFIG.DND5E?.limitedUsePeriods;
    if (!periods) return console.warn('[GachaDND] CONFIG.DND5E.limitedUsePeriods не найден, периоды не зарегистрированы.');
    for (const [key, config] of Object.entries(GACHA_PERIODS)) {
        if (!(key in periods)) periods[key] = { ...config };
    }
}

/**
 * Восстанавливает заряды предметов с указанным периодом у переданных актёров.
 * @param {string} period      Ключ периода (например, 'gachaFloor').
 * @param {Actor[]} actors     Актёры. По умолчанию — персонажи игроков.
 * @returns {Promise<number>}  Количество обновлённых предметов.
 */
export async function recoverPeriodUses(period, actors) {
    actors ??= game.actors.filter(a => a.type === 'character' && a.hasPlayerOwner);
    let updated = 0;

    for (const actor of actors) {
        if (!actor.isOwner) continue;
        const updates = [];
        for (const item of actor.items) {
            if (typeof item.system.recoverUses !== 'function') continue;
            const { updates: itemUpdates } = await item.system.recoverUses([period], item.getRollData());
            if (!foundry.utils.isEmpty(itemUpdates)) updates.push({ _id: item.id, ...itemUpdates });
        }
        if (updates.length) {
            await actor.updateEmbeddedDocuments('Item', updates);
            updated += updates.length;
        }
    }
    return updated;
}
