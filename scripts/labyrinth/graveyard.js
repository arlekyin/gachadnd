/**
 * Gacha Roguelike dnd5e — Кладбище в Пределе
 *
 * Смерть и воскрешение — по правилам dnd5e. Но тело погибшего персонажа игрока нужно нести: когда отряд
 * уходит с узла, Мастер решает, забирают ли тело. Оставленное тело Предел пожирает — токен исчезает,
 * персонаж помечается флагом devoured (лист не удаляется), а у Якоря встаёт надгробие: имя, класс,
 * уровень, число навыков в Памяти и этаж. Надгробия — настройка мира, переживают все забеги.
 */

import { MODULE_ID } from "../core/constants.js";
import { isMemorySkill } from "../memory/synergy/synergy.js";
import { getFloor } from "./economy.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const WINDOW_ID = 'gachadnd-graveyard';

export function registerGraveyardSettings() {
    game.settings.register(MODULE_ID, 'graveyard', {
        scope: 'world', config: false, type: Array, default: [],
        onChange: () => {
            const app = foundry.applications.instances?.get(WINDOW_ID);
            if (app?.rendered) app.render();
        }
    });
}

export function getGraves() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, 'graveyard') ?? []);
}

export function isDevoured(actor) {
    return !!actor?.getFlag(MODULE_ID, 'devoured');
}

/** Мёртв по правилам dnd5e: состояние «Мёртв» или три проваленных спасброска от смерти на 0 ПЗ */
export function isDead(actor) {
    if (actor.statuses?.has('dead')) return true;
    const attr = actor.system.attributes ?? {};
    return (attr.hp?.value ?? 1) <= 0 && (attr.death?.failure ?? 0) >= 3;
}

/** Погибшие персонажи игроков, чьё тело ещё не пожрано */
export function deadBodies() {
    return game.actors.filter(a => a.type === 'character' && a.hasPlayerOwner && !isDevoured(a) && isDead(a));
}

function graveOf(actor) {
    const classes = Object.values(actor.classes ?? {})
        .map(c => `${c.name}${c.subclass ? ` (${c.subclass.name})` : ''}`)
        .join(' / ');
    return {
        id: foundry.utils.randomID(),
        actorId: actor.id,
        name: actor.name,
        img: actor.img,
        classes: classes || '—',
        level: actor.system.details?.level ?? 0,
        skills: actor.items.filter(isMemorySkill).length,
        floor: getFloor(),
        at: Date.now()
    };
}

/** Предел пожирает тело: надгробие, метка на листе, токены уходят со сцены */
export async function devour(actor) {
    if (!game.user.isGM || isDevoured(actor)) return;
    const grave = graveOf(actor);
    await game.settings.set(MODULE_ID, 'graveyard', [...getGraves(), grave]);
    await actor.setFlag(MODULE_ID, 'devoured', { floor: grave.floor, grave: grave.id });
    const tokens = canvas.scene?.tokens.filter(t => t.actorId === actor.id).map(t => t.id) ?? [];
    if (tokens.length) await canvas.scene.deleteEmbeddedDocuments('Token', tokens);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ alias: 'Предел' }),
        content: `<div class="gd-scent-chat"><i class="fas fa-cross"></i> Тело <strong>${foundry.utils.escapeHTML(actor.name)}</strong> осталось на узле. Туман смыкается над ним, и Предел забирает своё. У Якоря встаёт новое надгробие.</div>`
    });
}

/** Отряд уходит с узла: Мастер решает судьбу каждого тела. Закрытое окно — тело забрали */
export async function leaveBodies() {
    if (!game.user.isGM) return;
    for (const actor of deadBodies()) {
        const name = foundry.utils.escapeHTML(actor.name);
        const choice = await foundry.applications.api.DialogV2.wait({
            window: { title: 'Тело на узле', icon: 'fas fa-cross' },
            content: `<p>Тело <strong>${name}</strong> осталось на узле. Отряд забирает его?</p><p><small>Оставленное тело Предел пожирает: воскресить персонажа будет нельзя, у Якоря встанет надгробие.</small></p>`,
            buttons: [
                { action: 'carry', label: 'Забрать тело', icon: 'fas fa-people-carry-box', default: true },
                { action: 'leave', label: 'Оставить', icon: 'fas fa-cross' }
            ],
            rejectClose: false
        });
        if (choice === 'leave') await devour(actor);
    }
}

/** Мастер убирает надгробие */
async function removeGrave(id) {
    if (!game.user.isGM) return;
    await game.settings.set(MODULE_ID, 'graveyard', getGraves().filter(g => g.id !== id));
}

export class GraveyardWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: WINDOW_ID,
        classes: ['gachadnd-graveyard'],
        tag: 'div',
        window: { title: 'Кладбище Предела', icon: 'fas fa-cross', resizable: true },
        position: { width: 640, height: 560 },
        actions: {
            remove: GraveyardWindow.#onRemove
        }
    };

    static PARTS = { body: { template: 'modules/gachadnd/templates/graveyard/body.hbs', scrollable: ['.gd-graves'] } };

    static open() {
        const existing = foundry.applications.instances?.get(WINDOW_ID);
        if (existing) return existing.render({ force: true });
        return new GraveyardWindow().render({ force: true });
    }

    async _prepareContext() {
        // Свежие надгробия — первыми
        const graves = getGraves().sort((a, b) => b.at - a.at);
        return { graves, gm: game.user.isGM };
    }

    static async #onRemove(event, target) {
        const grave = getGraves().find(g => g.id === target.dataset.id);
        if (!grave) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: 'Убрать надгробие' },
            content: `<p>Убрать надгробие <strong>${foundry.utils.escapeHTML(grave.name)}</strong>?</p>`,
            rejectClose: false
        });
        if (ok) await removeGrave(grave.id);
    }
}
