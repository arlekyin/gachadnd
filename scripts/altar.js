/**
 * Gacha Roguelike dnd5e — Алтарь Погибели (узел карты «Погибель»)
 *
 * Жертвенный постамент: персонаж отдаёт ПЗ, равные своему уровню. Кровь всего отряда копится в общий счёт.
 * Каждые doomCurseBlood × средний уровень крови постамент отдаёт кристалл с тегом «проклятье» тому, чья жертва
 * добрала до отметки. Конь № N открывает пасть при N × doomHorseBlood × средний уровень (по умолчанию 12 и 3). Когда персонаж забирает
 * всадника, пасти остальных коней закрываются. Управляет алтарём Мастер.
 *
 * Состояние алтаря хранится в узле карты этажа (флаг сцены floorMap): { blood, order, taken, last }.
 * Окно видят все: игроки смотрят, как копится кровь и раскрываются пасти, действует Мастер.
 */

import { MODULE_ID } from "./constants.js";
import { randomCrystal, buildCrystalData } from "./crystals.js";
import { HORSEMEN, partyActors, getHorseman, hasTakenHorseman } from "./horsemen.js";
import { emit, onSocket } from "./socket.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Доли настраиваются в параметрах модуля (Экономика)
const horseBlood = () => Math.max(1, Number(game.settings.get(MODULE_ID, 'doomHorseBlood')) || 12);
const curseBlood = () => Math.max(1, Number(game.settings.get(MODULE_ID, 'doomCurseBlood')) || 3);
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

// ==========================================
// ОКНО АЛТАРЯ
// ==========================================
//
// Место самого Лабиринта — противоположность лавки Торговца: густой туман, красный свет, ни одного тёплого огня.
// Части: backdrop — туман, камень, свечение (рисуется один раз); horses — четыре силуэта коней по диагоналям;
// chalice — постамент с кровью и рисками порогов; party — отряд с ПЗ и жертвой.

const TEMPLATES = 'modules/gachadnd/templates/doom';
const LIVE_PARTS = ['horses', 'chalice', 'party'];
// Кони стоят по диагоналям вокруг постамента и смотрят на него: левые — вправо, правые — влево
const HORSE_SEATS = [
    { x: 17, y: 24, facing: 'right' }, { x: 83, y: 24, facing: 'left' },
    { x: 17, y: 64, facing: 'right' }, { x: 83, y: 64, facing: 'left' }
];
const STATUS_LABELS = {
    absent: () => 'Пасть пуста — этот всадник уже в отряде',
    closed: () => 'Пасть сомкнута',
    open: () => 'Пасть открыта',
    taken: doom => `Забран: ${game.actors.get(doom.taken?.actorId)?.name ?? ''}`,
    locked: (doom, threshold) => `Откроется при ${threshold} крови`
};

export class DoomAltar extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: 'gachadnd-doom-altar',
        classes: ['gachadnd-doom'],
        tag: 'div',
        window: { title: 'Алтарь Погибели', icon: 'fas fa-horse-head', resizable: true },
        position: { width: 900, height: 780 },
        actions: {
            sacrifice: DoomAltar.#onSacrifice,
            take: DoomAltar.#onTake
        }
    };

    static PARTS = Object.fromEntries(['backdrop', ...LIVE_PARTS].map(id => [id, { template: `${TEMPLATES}/${id}.hbs` }]));

    // Мастер открывает алтарь — окно появляется у всех
    static async open() {
        if (!game.user.isGM) return ui.notifications.warn('Алтарём управляет Мастер.');
        const found = currentDoomNode();
        if (!found) return ui.notifications.warn('Отряд не стоит на узле Погибели.');
        // Порядок, в котором кони открывают пасти, случаен для каждого алтаря и фиксируется при первом открытии
        if (!found.node.doom) {
            await saveDoom(found.map, found.node.id, { blood: 0, order: Object.keys(HORSEMEN).sort(() => Math.random() - 0.5), taken: null });
        }
        emit('openDoom');
        return DoomAltar.show();
    }

    static show() {
        const existing = foundry.applications.instances?.get('gachadnd-doom-altar');
        if (existing) return existing.render({ force: true, parts: LIVE_PARTS }).then(() => existing.bringToFront?.());
        return new DoomAltar().render({ force: true });
    }

    /** Перерисовать всё, кроме тумана и камня */
    refresh() {
        if (this.rendered) return this.render({ parts: LIVE_PARTS });
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

    async _prepareContext() {
        const state = this.#state();
        const party = partyActors();
        const context = { isGM: game.user.isGM, active: !!state };
        if (!state) return context;
        const { doom } = state;
        const level = averageLevel();
        const step = horseBlood() * level;
        const max = step * doom.order.length;
        // Всадник, который уже есть у кого-то из отряда, на алтаре не появляется
        const held = new Set(party.map(a => getHorseman(a)?.flags[MODULE_ID].horseman ?? a.getFlag(MODULE_ID, 'horseman')).filter(Boolean));
        const candidates = party.filter(a => !hasTakenHorseman(a)).map(a => ({ id: a.id, name: a.name }));

        context.horses = doom.order.map((key, i) => {
            const threshold = step * (i + 1);
            const taken = doom.taken?.key === key;
            let status;
            if (held.has(key) && !taken) status = 'absent';
            else if (taken) status = 'taken';
            else if (doom.taken) status = 'closed';
            else status = doom.blood >= threshold ? 'open' : 'locked';
            // Глаза разгораются, пока кровь подбирается к порогу этого коня
            const heat = status === 'locked' ? Math.max(0, Math.min(1, (doom.blood - (threshold - step)) / step)) : status === 'open' ? 1 : 0;
            return {
                key, name: HORSEMEN[key], status, heat: heat.toFixed(2), ...HORSE_SEATS[i],
                label: STATUS_LABELS[status](doom, threshold),
                canTake: status === 'open' && game.user.isGM && candidates.length > 0
            };
        });
        context.candidates = candidates;

        const next = context.horses.find(h => h.status === 'locked');
        context.chalice = {
            blood: doom.blood, level,
            fill: Math.min(1, doom.blood / max).toFixed(3),
            next: next ? step * (doom.order.indexOf(next.key) + 1) : null,
            marks: doom.order.map((key, i) => ({ at: ((i + 1) / doom.order.length * 100).toFixed(1), roman: ['I', 'II', 'III', 'IV'][i], reached: doom.blood >= step * (i + 1) })),
            done: !!doom.taken
        };
        // До следующего проклятого кристалла
        const per = curseBlood() * level;
        context.chalice.curseIn = per - (doom.blood % per);
        context.last = doom.last ?? null;

        context.party = party.map(a => {
            const lvl = a.system.details?.level ?? 1;
            const hp = a.system.attributes?.hp?.value ?? 0;
            const hpMax = a.system.attributes?.hp?.max || 1;
            const horseman = getHorseman(a)?.flags[MODULE_ID].horseman ?? null;
            return {
                id: a.id, name: a.name, img: a.img, hp, hpMax, cost: lvl,
                hpPct: Math.max(0, Math.min(100, hp / hpMax * 100)).toFixed(0),
                canSacrifice: game.user.isGM && hp > lvl,
                horseman, horsemanName: horseman ? HORSEMEN[horseman] : null
            };
        });
        return context;
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const parts = options.parts ?? [];
        const first = options.isFirstRender;

        // Пробуждение, отказ и закрытие коней играются только при смене состояния, не при каждом открытии окна
        if (parts.includes('horses')) {
            const before = this.#statuses;
            for (const horse of context.horses ?? []) {
                const was = before?.[horse.key];
                const el = this.element.querySelector(`.gd-horse[data-key="${horse.key}"]`);
                if (!el || !was || was === horse.status) continue;
                if (horse.status === 'open') el.classList.add('opening');
                else if (horse.status === 'closed' && was === 'open') el.classList.add('closing');
                else if (horse.status === 'taken') el.classList.add('giving');
            }
            this.#statuses = Object.fromEntries((context.horses ?? []).map(h => [h.key, h.status]));
        }

        // Кровь в постаменте поднимается от прежнего уровня; новая жертва — капли и всплывающий проклятый кристалл
        if (parts.includes('chalice') && context.chalice) {
            const fill = this.element.querySelector('.gd-chalice');
            const now = Number(context.chalice.fill);
            if (fill && this.#fill !== null && this.#fill !== now) {
                fill.style.setProperty('--fill', this.#fill);
                fill.getBoundingClientRect();
                requestAnimationFrame(() => fill.style.setProperty('--fill', now));
            }
            this.#fill = now;
            const at = context.last?.at ?? null;
            if (!first && at && at !== this.#lastAt) {
                this.element.querySelector('.gd-chalice')?.classList.add('offering');
                this.element.querySelector(`.gd-offerer[data-actor-id="${context.last.actorId}"]`)?.classList.add('bleeding');
            }
            this.#lastAt = at;
        }
    }

    #statuses = null;
    #fill = null;
    #lastAt = null;

    static async #onSacrifice(event, target) {
        if (!game.user.isGM) return;
        const state = this.#state();
        const actor = game.actors.get(target.dataset.actorId);
        if (!state || !actor) return;
        const level = actor.system.details?.level ?? 1;
        const hp = actor.system.attributes.hp.value;
        if (hp <= level) return ui.notifications.warn(`${actor.name}: не хватает ПЗ для жертвы.`);

        await actor.update({ 'system.attributes.hp.value': hp - level });
        // Кристаллы — за каждую отметку крови, которую перешла эта жертва
        const per = curseBlood() * averageLevel();
        const before = state.doom.blood;
        state.doom.blood += level;
        const crystals = [];
        for (let i = Math.floor(before / per); i < Math.floor(state.doom.blood / per); i++) {
            const crystal = await randomCrystal(rollRarity(), 'проклят');
            if (crystal) crystals.push(crystal);
        }
        if (crystals.length) await actor.createEmbeddedDocuments('Item', crystals);
        // Последняя жертва — чтобы у всех проиграть капли и всплывающий кристалл
        state.doom.last = { actorId: actor.id, at: Date.now(), img: crystals.at(-1)?.img ?? null };
        await saveDoom(state.map, state.node.id, state.doom);
        const gained = crystals.length ? ` Постамент отдаёт: ${crystals.map(c => `<strong>${esc(c.name)}</strong>`).join(', ')}.` : '';
        await chat(`<strong>${esc(actor.name)}</strong> отдаёт постаменту ${level} ПЗ. Кровь: ${state.doom.blood}.${gained}`);
    }

    static async #onTake(event, target) {
        if (!game.user.isGM) return;
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
    }
}

onSocket('openDoom', () => DoomAltar.show());

// Алтарь перерисовывается, когда меняется карта этажа или ПЗ персонажей — туман и камень остаются
const refreshAltar = () => foundry.applications.instances?.get('gachadnd-doom-altar')?.refresh?.();
Hooks.on('updateScene', (scene, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) refreshAltar();
});
Hooks.on('updateActor', refreshAltar);
Hooks.on('createItem', refreshAltar);
