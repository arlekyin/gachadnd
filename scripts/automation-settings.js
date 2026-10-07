/**
 * Gacha Roguelike dnd5e — Окно «Срабатывания» в настройках модуля
 *
 * Личные галочки игрока для каждого автоматического срабатывания, как у реакций в Baldur's Gate 3:
 * «Вкл.» — срабатывает ли оно; «Спрашивать» — спрашивать ли перед срабатыванием.
 * Список — все синергии и навыки модуля с полем trigger: настраивать можно заранее, до получения навыка.
 * Сохраняется сразу, перезапуск не нужен: триггеры читают настройку при каждом срабатывании.
 */

import { MODULE_ID } from "./constants.js";
import { getSynergyDictionary } from "./synergy-data.js";
import { getSkillPack } from "./crystals.js";
import { readPrefs, getPref, savePrefs, KIND_LABELS, TRIGGER_EVENTS } from "./triggers.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class AutomationSettings extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: 'gachadnd-automation-settings',
        tag: 'form',
        classes: ['gachadnd-automation-settings'],
        window: { title: 'Срабатывания синергий и навыков', icon: 'fas fa-bolt', resizable: true },
        position: { width: 560, height: 640 },
        form: { handler: AutomationSettings.#onSubmit, submitOnChange: false, closeOnSubmit: true },
        actions: { reset: AutomationSettings.#onReset }
    };

    static PARTS = { form: { template: `modules/${MODULE_ID}/templates/automation-settings.hbs`, scrollable: ['.gd-auto-list'] } };

    // Все срабатывания модуля: пороги синергий и навыки компендиума
    static async sources() {
        const synergies = [];
        for (const config of Object.values(getSynergyDictionary())) {
            for (const tier of config.thresholds) {
                if (TRIGGER_EVENTS.includes(tier.trigger?.on)) synergies.push({ prefKey: `syn-${config.key}-${tier.count}`, name: tier.name, trigger: tier.trigger });
            }
        }
        const skills = [];
        const pack = getSkillPack();
        if (pack) {
            const index = await pack.getIndex({ fields: [`flags.${MODULE_ID}.trigger`, `flags.${MODULE_ID}.skill_id`] });
            for (const entry of index) {
                const flags = entry.flags?.[MODULE_ID] ?? {};
                if (TRIGGER_EVENTS.includes(flags.trigger?.on)) skills.push({ prefKey: `skill-${flags.skill_id ?? entry._id}`, name: entry.name, trigger: flags.trigger });
            }
        }
        skills.sort((a, b) => a.name.localeCompare(b.name));
        return { synergies, skills };
    }

    async _prepareContext() {
        const { synergies, skills } = await AutomationSettings.sources();
        const row = source => ({ ...source, kind: KIND_LABELS[source.trigger.on](source.trigger), ...getPref(source) });
        return {
            groups: [
                { title: 'Синергии', rows: synergies.map(row) },
                { title: 'Навыки', rows: skills.map(row) }
            ].filter(g => g.rows.length),
            masterOff: !game.settings.get(MODULE_ID, 'automation')
        };
    }

    // Снятая галочка «Вкл.» приглушает строку; «Спрашивать» сохраняется на случай повторного включения
    _onRender(context, options) {
        super._onRender(context, options);
        this.element.querySelectorAll('input[data-field="enabled"]').forEach(input => {
            const sync = () => input.closest('.gd-auto-row')?.classList.toggle('off', !input.checked);
            input.addEventListener('change', sync);
            sync();
        });
    }

    static async #onSubmit(event, form, formData) {
        const values = foundry.utils.expandObject(formData.object);
        const prefs = { ...readPrefs() };
        for (const [key, value] of Object.entries(values)) {
            prefs[key] = { enabled: !!value.enabled, ask: !!value.ask };
        }
        await savePrefs(prefs);
        ui.notifications.info('Срабатывания сохранены.');
    }

    static async #onReset() {
        await savePrefs({});
        this.render();
    }
}

export function registerAutomationMenu() {
    game.settings.registerMenu(MODULE_ID, 'automationMenu', {
        name: 'Срабатывания синергий и навыков',
        label: 'Настроить',
        hint: 'Личные галочки «Вкл.» и «Спрашивать» для каждого автоматического срабатывания — как у реакций в Baldur\'s Gate 3. У каждого игрока свои, перезапуск не нужен.',
        icon: 'fas fa-bolt',
        type: AutomationSettings,
        restricted: false
    });
}
