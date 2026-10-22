/**
 * Gacha Roguelike dnd5e — Подменю настроек
 *
 * Частные настройки не лежат в общем списке Foundry: каждая группа — кнопка, которая открывает окно
 * с полями этой группы. Поля строятся из самих зарегистрированных настроек (имя, подсказка, тип,
 * выбор, диапазон, выбор файла); настройки мира видит и меняет только Мастер.
 */

import { MODULE_ID } from "./constants.js";
import { HINTS } from "./prefs.js";

const { ApplicationV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML?.(String(text ?? '')) ?? String(text ?? '');

/** Группы подменю: ключи настроек по порядку */
export const MENUS = {
    economyMenu: {
        label: 'Экономика забега', icon: 'fas fa-coins', restricted: true,
        hint: 'Золото, цены Магазина, кровь Погибели, компендиумы товаров.',
        keys: ['goldBase', 'goldGrowth', 'crystalPrices', 'cleansePrice', 'rerollPrice', 'doomHorseBlood', 'doomCurseBlood', 'shopConsumables', 'shopMagicItems']
    },
    soundsMenu: {
        label: 'Звуки и эффекты', icon: 'fas fa-volume-high', restricted: false,
        hint: 'Звуки Терминала и их файлы, звук импакт-кадров, тема героя, замедление кадров, звуки паутины.',
        keys: ['soundsEnabled', 'soundsVolume', 'sound_equip', 'sound_unequip', 'sound_merge', 'impactSound', 'auraTheme', 'auraMusicVolume', 'impactSlow', 'webSounds']
    },
    hintsMenu: {
        label: 'Подсказки Мастеру', icon: 'fas fa-ear-listen', restricted: true,
        hint: 'Какие шёпоты и строки атмосферы присылать.',
        keys: Object.keys(HINTS)
    },
    namesMenu: {
        label: 'Свои названия навыков', icon: 'fas fa-signature', restricted: true,
        hint: 'Вернуть столу любимые названия: «Название из модуля = Своё». Хранится в мире, с модулем не уходит.',
        keys: ['skillNames']
    },
    riskMenu: {
        label: 'Испытания Риска', icon: 'fas fa-dice', restricted: true,
        hint: 'Свой файл испытаний и только свои испытания.',
        keys: ['riskCustomFile', 'riskOnlyCustom']
    }
};

const configOf = key => game.settings.settings.get(`${MODULE_ID}.${key}`);
const typeName = config => config.type?.name ?? (typeof config.type === 'function' ? config.type.name : String(config.type));

function field(key) {
    const config = configOf(key);
    if (!config) return '';
    const value = game.settings.get(MODULE_ID, key);
    const name = `${MODULE_ID}.${key}`;
    const type = typeName(config);
    let input;
    if (config.choices) {
        const options = Object.entries(config.choices).map(([k, label]) => `<option value="${esc(k)}" ${k === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
        input = `<select name="${name}">${options}</select>`;
    } else if (type === 'Boolean') {
        input = `<input type="checkbox" name="${name}" ${value ? 'checked' : ''}>`;
    } else if (type === 'Number' && config.range) {
        const { min, max, step } = config.range;
        input = `<range-picker name="${name}" value="${value}" min="${min}" max="${max}" step="${step}"></range-picker>`;
    } else if (type === 'Number') {
        input = `<input type="number" name="${name}" value="${esc(value)}" step="any">`;
    } else if (config.multiline) {
        input = `<textarea name="${name}" rows="10" placeholder="Серия обычных ударов = Сайтама">${esc(value)}</textarea>`;
    } else if (config.filePicker) {
        input = `<file-picker name="${name}" type="${config.filePicker === true ? 'any' : config.filePicker}" value="${esc(value)}"></file-picker>`;
    } else {
        input = `<input type="text" name="${name}" value="${esc(value)}">`;
    }
    return `<div class="form-group"><label>${esc(config.name ?? key)}</label><div class="form-fields">${input}</div>${config.hint ? `<p class="hint">${esc(config.hint)}</p>` : ''}</div>`;
}

/** Окно группы подменю — класс на каждую группу (registerMenu требует класс) */
function menuClass(id, menu) {
    return class extends ApplicationV2 {
        static DEFAULT_OPTIONS = {
            id: `gachadnd-${id}`,
            tag: 'form',
            classes: ['gachadnd-settings-menu', 'standard-form'],
            window: { title: menu.label, icon: menu.icon, resizable: true },
            position: { width: 560, height: 'auto' },
            form: { handler: (event, form) => this.save(form), submitOnChange: false, closeOnSubmit: true }
        };

        /** Ключи, которые этот пользователь видит: настройки мира — только Мастеру */
        static visibleKeys() {
            return menu.keys.filter(key => configOf(key) && (game.user.isGM || configOf(key).scope !== 'world'));
        }

        async _renderHTML() {
            const keys = this.constructor.visibleKeys();
            return `<div class="gd-settings-body">${keys.map(field).join('') || '<p class="hint">Здесь нет настроек, доступных вам.</p>'}</div>
                <footer class="form-footer"><button type="submit"><i class="fas fa-save"></i> Сохранить</button></footer>`;
        }

        _replaceHTML(html, content) {
            content.innerHTML = html;
        }

        static async save(form) {
            for (const key of this.visibleKeys()) {
                const config = configOf(key);
                const input = form.elements[`${MODULE_ID}.${key}`] ?? form.querySelector(`[name="${MODULE_ID}.${key}"]`);
                if (!input) continue;
                const type = typeName(config);
                let value = type === 'Boolean' ? !!input.checked : input.value;
                if (type === 'Number') value = Number(value);
                if (value !== game.settings.get(MODULE_ID, key)) await game.settings.set(MODULE_ID, key, value);
            }
            ui.notifications.info(`${menu.label}: сохранено.`);
        }
    };
}

export function registerSettingsMenus() {
    for (const [id, menu] of Object.entries(MENUS)) {
        game.settings.registerMenu(MODULE_ID, id, {
            name: menu.label, label: menu.label, hint: menu.hint, icon: menu.icon,
            type: menuClass(id, menu), restricted: menu.restricted
        });
    }
}
