/**
 * Gacha Roguelike dnd5e — Алтарь Погибели (узел карты «Погибель»)
 *
 * Жертвенный постамент: персонаж отдаёт ПЗ, равные своему уровню, и получает случайный кристалл
 * с тегом «проклятье». Кровь всего отряда копится в общий счёт; при 3, 6, 9 и 12 × средний уровень
 * отряда пасть открывает очередной конь с кристаллом всадника в зубах. Когда персонаж забирает
 * всадника, пасти остальных коней закрываются. Управляет алтарём Мастер.
 *
 * Состояние алтаря хранится в узле карты этажа (флаг сцены floorMap): { blood, order, taken }.
 */

import { MODULE_ID } from "./main.js";
import { randomCrystal, buildCrystalData } from "./crystals.js";
import { HORSEMEN, partyActors, getHorseman, hasTakenHorseman } from "./horsemen.js";

const { ApplicationV2 } = foundry.applications.api;

const THRESHOLD_STEP = 3;
const RARITY_WEIGHTS = { gray: 600, green: 250, blue: 100, purple: 40, red: 9 };

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function rollRarity() {
    let roll = Math.random() * Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
    for (const [rarity, weight] of Object.entries(RARITY_WEIGHTS)) {
        if ((roll -= weight) < 0) return rarity;
    }
    return 'gray';
}

function averageLevel() {
    const actors = partyActors();
    if (!actors.length) return 1;
    return Math.max(1, Math.round(actors.reduce((sum, a) => sum + (a.system.details?.level ?? 1), 0) / actors.length));
}

// Текущий узел карты, если это Погибель
function currentDoomNode(scene = canvas.scene) {
    const map = scene?.getFlag(MODULE_ID, 'floorMap');
    const node = map?.nodes?.find(n => n.id === map.currentNodeId);
    return node?.type === 'doom' ? { map, node } : null;
}

async function saveDoom(map, nodeId, doom) {
    const copy = foundry.utils.deepClone(map);
    copy.nodes.find(n => n.id === nodeId).doom = doom;
    await canvas.scene.setFlag(MODULE_ID, 'floorMap', copy);
}

async function chat(content) {
    await ChatMessage.create({
        speaker: { alias: 'Алтарь Погибели' },
        content: `<div class="gachadnd-doom-chat">${content}</div>`
    });
}

export class DoomAltar extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: 'gachadnd-doom-altar',
        classes: ['gachadnd-doom'],
        tag: 'div',
        window: { title: 'Алтарь Погибели', icon: 'fas fa-horse-head', resizable: true },
        position: { width: 720, height: 640 },
        actions: {
            sacrifice: DoomAltar.#onSacrifice,
            take: DoomAltar.#onTake
        }
    };

    static async open() {
        if (!game.user.isGM) return ui.notifications.warn('Алтарём управляет Мастер.');
        const found = currentDoomNode();
        if (!found) return ui.notifications.warn('Отряд не стоит на узле Погибели.');
        // Порядок, в котором кони открывают пасти, случаен для каждого алтаря и фиксируется при первом открытии
        if (!found.node.doom) {
            await saveDoom(found.map, found.node.id, { blood: 0, order: Object.keys(HORSEMEN).sort(() => Math.random() - 0.5), taken: null });
        }
        const existing = foundry.applications.instances?.get('gachadnd-doom-altar');
        if (existing) return existing.render({ force: true });
        return new DoomAltar().render({ force: true });
    }

    #state() {
        const found = currentDoomNode();
        if (!found) return null;
        const doom = foundry.utils.deepClone(found.node.doom ?? {});
        doom.blood ??= 0;
        doom.order ??= Object.keys(HORSEMEN);
        doom.taken ??= null;
        return { ...found, doom };
    }

    async _renderHTML() {
        const state = this.#state();
        if (!state) return '<p class="gd-doom-empty">Отряд покинул узел Погибели.</p>';
        const { doom } = state;
        const level = averageLevel();
        const party = partyActors();
        // Всадник, который уже есть у кого-то из отряда, на алтаре не появляется
        const held = new Set(party.map(a => getHorseman(a)?.flags[MODULE_ID].horseman ?? a.getFlag(MODULE_ID, 'horseman')).filter(Boolean));

        const horses = doom.order.map((key, i) => {
            const threshold = THRESHOLD_STEP * (i + 1) * level;
            const taken = doom.taken?.key === key;
            let status;
            if (held.has(key) && !taken) status = 'absent';
            else if (taken) status = 'taken';
            else if (doom.taken) status = 'closed';
            else status = doom.blood >= threshold ? 'open' : 'locked';
            const label = {
                absent: 'Конь без кристалла — этот всадник уже в отряде',
                taken: `Забран: ${esc(game.actors.get(doom.taken?.actorId)?.name ?? '')}`,
                closed: 'Пасть сомкнута',
                locked: `Откроется при ${threshold} крови`,
                open: 'Пасть открыта'
            }[status];
            const candidates = party.filter(a => !hasTakenHorseman(a));
            return `
                <div class="gd-horse ${status}">
                    <i class="fas fa-horse-head"></i>
                    <div class="gd-horse-name">${HORSEMEN[key]}</div>
                    <div class="gd-horse-status">${label}</div>
                    ${status === 'open' ? `
                        <select data-horse="${key}">${candidates.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
                        <button type="button" data-action="take" data-horse="${key}" ${candidates.length ? '' : 'disabled'}>Забрать</button>` : ''}
                </div>`;
        }).join('');

        const rows = party.map(a => {
            const lvl = a.system.details?.level ?? 1;
            const hp = a.system.attributes?.hp?.value ?? 0;
            return `
                <div class="gd-doom-row">
                    <span>${esc(a.name)}</span>
                    <span class="gd-doom-hp">${hp} ПЗ</span>
                    <button type="button" data-action="sacrifice" data-actor-id="${a.id}" ${hp > lvl ? '' : 'disabled'} title="Отдать ${lvl} ПЗ и получить кристалл с тегом «проклятье»">Жертва · −${lvl} ПЗ</button>
                </div>`;
        }).join('');

        return `
            <div class="gd-doom-blood">Кровь на постаменте: <strong>${doom.blood}</strong> · средний уровень отряда ${level}</div>
            <div class="gd-horses">${horses}</div>
            <div class="gd-doom-party">${rows || '<p>В отряде нет персонажей игроков.</p>'}</div>`;
    }

    _replaceHTML(result, content) {
        content.innerHTML = result;
    }

    static async #onSacrifice(event, target) {
        const state = this.#state();
        const actor = game.actors.get(target.dataset.actorId);
        if (!state || !actor) return;
        const level = actor.system.details?.level ?? 1;
        const hp = actor.system.attributes.hp.value;
        if (hp <= level) return ui.notifications.warn(`${actor.name}: не хватает ПЗ для жертвы.`);

        await actor.update({ 'system.attributes.hp.value': hp - level });
        const crystal = await randomCrystal(rollRarity(), 'проклят');
        if (crystal) await actor.createEmbeddedDocuments('Item', [crystal]);
        state.doom.blood += level;
        await saveDoom(state.map, state.node.id, state.doom);
        await chat(`<strong>${esc(actor.name)}</strong> отдаёт постаменту ${level} ПЗ${crystal ? ` и получает <strong>${esc(crystal.name)}</strong>` : ''}. Кровь: ${state.doom.blood}.`);
        this.render();
    }

    static async #onTake(event, target) {
        const state = this.#state();
        const key = target.dataset.horse;
        const actorId = this.element.querySelector(`select[data-horse="${key}"]`)?.value;
        const actor = game.actors.get(actorId);
        if (!state || !actor || state.doom.taken) return;
        if (hasTakenHorseman(actor)) return ui.notifications.warn(`У персонажа ${actor.name} уже есть всадник.`);

        const pack = game.packs.get(`${MODULE_ID}.gacha-skills`);
        const index = await pack?.getIndex({ fields: [`flags.${MODULE_ID}.horseman`] });
        const entry = index?.find(e => e.flags?.[MODULE_ID]?.horseman === key);
        if (!entry) return ui.notifications.error(`Кристалл всадника «${HORSEMEN[key]}» не найден в компендиуме навыков.`);

        await actor.createEmbeddedDocuments('Item', [buildCrystalData(await pack.getDocument(entry._id))]);
        await actor.setFlag(MODULE_ID, 'horseman', key);
        state.doom.taken = { key, actorId: actor.id };
        await saveDoom(state.map, state.node.id, state.doom);
        await chat(`Конь отдаёт кристалл <strong>${HORSEMEN[key]}</strong> персонажу <strong>${esc(actor.name)}</strong>. Пасти остальных коней смыкаются.`);
        this.render();
    }
}

// Алтарь перерисовывается, когда меняется карта этажа или ПЗ персонажей
Hooks.on('updateScene', (scene, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) foundry.applications.instances?.get('gachadnd-doom-altar')?.render();
});
Hooks.on('updateActor', () => foundry.applications.instances?.get('gachadnd-doom-altar')?.render());
