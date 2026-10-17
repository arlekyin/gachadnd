/**
 * Gacha Roguelike dnd5e — События: страница дневника
 *
 * Отряд входит на узел «Событие» — у всех открывается разворот дневника Разлома: слева зарисовка (рисунок
 * автора, проявленный пером, или зарисовка кодом) и подпись под ней; справа — запись: место, заголовок, пара
 * абзацев и 2–3 варианта с ценой. Отряд решает вслух, вариант жмёт любой из отряда; если вариант делает
 * один персонаж — тот, кого выбрали в строке «Кто». Проверку бросает сам игрок штатным броском dnd5e,
 * исходы модуль применяет сам, итог — карточкой в чат. Мастер может сменить событие или закрыть его.
 *
 * События — src/events/*.yaml, собираются в data/events.json (формат — src/events/SCHEMA.md). Событие
 * выбирается по биому и этажу из ещё не встречавшихся (once: false — может повторяться).
 * Состояние — в узле карты (флаг сцены floorMap): node.event = { id, status, choice, actorId, success, text, lines }.
 */

import { MODULE_ID } from "../core/constants.js";
import { fxOn } from "../core/prefs.js";
import { isActiveGM, onSocket, emit, notifyUser, requestGM } from "../core/socket.js";
import { renderSketch, renderImageSketch, revealImageSketch, SKETCH } from "./sketches.js";
import { DOODLES } from "../core/ink.js";
import { BIOMES, currentBiome } from "./biomes.js";
import { floorBase, getFloor, addGold, pay, wealth } from "./economy.js";
import { mapScene } from "./scene-travel.js";
import { partyActors } from "./horsemen.js";
import { offerEventRewards } from "./rewards.js";
import { LOTS, rollDealLots } from "./moon-deal.js";
import { getOmen, setOmen } from "./omen.js";
import { heatOf } from "../memory/overheat.js";
import { isMemorySkill } from "../memory/synergy/synergy.js";
import { isCrystalItem } from "../memory/inventory.js";
import { validateEvent } from "./event-schema.js";
import { randomCrystal, getSkillPack } from "../memory/crystals.js";
import { addSkillToMemory } from "../memory/inventory.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const ID = 'gachadnd-event';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const esc = s => foundry.utils.escapeHTML(String(s ?? ''));

export function registerEventSettings() {
    // Встреченные за забег события (id) — однократные больше не выпадают
    game.settings.register(MODULE_ID, 'eventsSeen', { scope: 'world', config: false, type: Array, default: [] });
}

// ==========================================
// ДАННЫЕ
// ==========================================

let events = null;
export async function loadEvents() {
    if (events) return events;
    try {
        const response = await fetch(`modules/${MODULE_ID}/data/events.json`);
        const data = response.ok ? await response.json() : [];
        events = data.filter(ev => {
            const errs = validateEvent(ev);
            if (errs.length) console.warn(`[GachaDND] Событие ${ev?.id} пропущено:`, errs);
            return !errs.length;
        });
    } catch (error) {
        console.error(`${MODULE_ID} | события`, error);
        events = [];
    }
    return events;
}
const byId = id => events?.find(e => e.id === id) ?? null;

/** Событие для узла: по биому и этажу, сначала из ещё не встречавшихся */
export async function pickEvent({ biome = currentBiome(), floor = getFloor(), exclude = [] } = {}) {
    const all = await loadEvents();
    const seen = new Set(game.settings.get(MODULE_ID, 'eventsSeen') ?? []);
    const fits = all.filter(ev => {
        const biomes = Array.isArray(ev.biome) ? ev.biome : [ev.biome];
        return (biomes.includes(biome) || biomes.includes('any'))
            && (!ev.floors || (floor >= ev.floors[0] && floor <= ev.floors[1]))
            && !exclude.includes(ev.id);
    });
    const fresh = fits.filter(ev => !(ev.once !== false && seen.has(ev.id)));
    const pool = fresh.length ? fresh : fits;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

const checkDC = (option, floor = getFloor()) => 11 + floor + (option.check?.dc ?? 0);
const RARITY_ORDER = ['gray', 'green', 'blue', 'purple', 'red'];
const RARITY_WEIGHT = { gray: 1, green: 2, blue: 3, purple: 5, red: 8 };
const OMEN_ORDER = ['off', '3', '2', '1'];
function abilityLabel(key) {
    const label = CONFIG.DND5E?.abilities?.[key]?.label;
    return label ? game.i18n.localize(label) : key;
}
/** Подпись проверки: «Мудрость (Выживание)», «Телосложение», «спасбросок Мудрости» */
function checkLabel(check) {
    if (check.skill) return `${abilityOfSkill(check.skill)} (${skillLabel(check.skill)})`;
    if (check.ability) return abilityLabel(check.ability);
    return `спасбросок: ${abilityLabel(check.save)}`;
}
function skillLabel(key) {
    const label = CONFIG.DND5E?.skills?.[key]?.label;
    return label ? game.i18n.localize(label) : key;
}
function abilityOfSkill(key) {
    const ability = CONFIG.DND5E?.skills?.[key]?.ability;
    const label = CONFIG.DND5E?.abilities?.[ability]?.label;
    return label ? game.i18n.localize(label) : '';
}

// ==========================================
// СОСТОЯНИЕ НА УЗЛЕ
// ==========================================

export function currentEventNode(scene = mapScene()) {
    const map = scene?.getFlag(MODULE_ID, 'floorMap');
    const node = map?.nodes?.find(n => n.id === map.currentNodeId);
    return node?.type === 'event' ? { map, node } : null;
}

async function saveEvent(found, event) {
    const copy = foundry.utils.deepClone(found.map);
    copy.nodes.find(n => n.id === found.node.id).event = event;
    await mapScene().setFlag(MODULE_ID, 'floorMap', copy);
}

// ==========================================
// ИСХОДЫ
// ==========================================

const mainClass = actor => actor.items.filter(i => i.type === 'class').sort((a, b) => (b.system.levels ?? 0) - (a.system.levels ?? 0))[0] ?? null;

async function randomSkillName(rarity) {
    const index = await getSkillPack()?.getIndex({ fields: [`flags.${MODULE_ID}.rarity`, `flags.${MODULE_ID}.undeletable`] });
    const pool = [...(index ?? [])].filter(e => e.flags?.[MODULE_ID]?.rarity === rarity && !e.flags[MODULE_ID].undeletable);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)].name : null;
}

/** Применить исходы. one — персонаж варианта. @returns {string[]} строки для карточки */
export async function applyEffects(effects = [], { one, who, title }) {
    const lines = [];
    const party = partyActors();
    // Редкость отданного кристалла — у каждого своя: «кристалл на редкость выше» смотрит на неё
    const taken = new Map();
    for (const effect of effects) {
        const { to = who, ...rest } = effect;
        const [key, value] = Object.entries(rest)[0];
        const targets = to === 'all' ? party : to === 'one' && one ? [one] : [];
        if (key === 'note' || key === 'fight') {
            await ChatMessage.create({
                speaker: { alias: 'Дневник Разлома' }, whisper: ChatMessage.getWhisperRecipients('GM').map(u => u.id),
                content: `<div class="gd-scent-chat"><i class="fas ${key === 'fight' ? 'fa-skull-crossbones' : 'fa-feather'}"></i> <strong>${key === 'fight' ? 'Бой' : 'Мастеру'}:</strong> ${esc(value)}</div>`
            });
            continue;
        }
        if (key === 'omen') {
            const at = Math.max(0, OMEN_ORDER.indexOf(getOmen()));
            const next = OMEN_ORDER[Math.max(0, Math.min(OMEN_ORDER.length - 1, at + value))];
            if (getOmen() !== 'here' && next !== getOmen()) await setOmen(next);
            lines.push(value > 0 ? 'Пожиратель ближе' : 'Пожиратель теряет след');
            continue;
        }
        if (key === 'deal_preview') {
            const lots = await rollDealLots();
            lines.push(`луна предложит: ${lots.map(l => LOTS[l]?.name).join(', ')}`);
            continue;
        }
        if (key === 'reward') {
            await offerEventRewards({ actors: targets, tier: value.tier, count: value.count ?? 3, title });
            lines.push(`награда события — ${targets.map(a => esc(a.name)).join(', ')}`);
            continue;
        }
        for (const actor of targets) {
            if (key === 'gold') {
                const amount = Math.round(floorBase() * Math.abs(value));
                if (value > 0) { await addGold(actor, amount); lines.push(`${esc(actor.name)}: +${amount} зм`); }
                else { const paid = Math.min(amount, Math.floor(wealth(actor))); await pay(actor, paid); lines.push(`${esc(actor.name)}: −${paid} зм`); }
            } else if (key === 'take_crystal') {
                const min = RARITY_ORDER.indexOf(value?.min ?? 'gray');
                const item = actor.items.filter(i => isCrystalItem(i) && RARITY_ORDER.indexOf(i.flags[MODULE_ID]?.rarity) >= min)
                    .sort((a, b) => RARITY_ORDER.indexOf(a.flags[MODULE_ID].rarity) - RARITY_ORDER.indexOf(b.flags[MODULE_ID].rarity))[0];
                if (!item) { lines.push(`${esc(actor.name)}: отдать нечего`); continue; }
                taken.set(actor.id, item.flags[MODULE_ID].rarity);
                const qty = Number(item.system?.quantity ?? 1);
                if (qty > 1) await item.update({ 'system.quantity': qty - 1 }); else await item.delete();
                lines.push(`${esc(actor.name)}: отдан «${esc(item.name)}»`);
            } else if (key === 'take_skill') {
                const pool = actor.items.filter(i => isMemorySkill(i) && !i.flags[MODULE_ID].undeletable && !i.flags[MODULE_ID].horseman);
                const item = pool[Math.floor(Math.random() * pool.length)];
                if (!item) { lines.push(`${esc(actor.name)}: продать нечего`); continue; }
                const amount = Math.round(floorBase() * value.pay * (RARITY_WEIGHT[item.flags[MODULE_ID].rarity] ?? 1));
                await item.delete({ gachadndCleanse: true });
                await addGold(actor, amount);
                lines.push(`${esc(actor.name)}: навык «${esc(item.name)}» продан за ${amount} зм`);
            } else if (key === 'burn_skill') {
                const pool = actor.items.filter(i => isMemorySkill(i) && !i.flags[MODULE_ID].undeletable && !i.flags[MODULE_ID].horseman);
                const item = pool[Math.floor(Math.random() * pool.length)];
                if (!item) continue;
                await item.delete();
                lines.push(`${esc(actor.name)}: сгорел «${esc(item.name)}»`);
            } else if (key === 'cool') {
                const hot = actor.items.filter(i => isMemorySkill(i) && (heatOf(i).extra || heatOf(i).locked || heatOf(i).borrowed));
                if (hot.length) await actor.updateEmbeddedDocuments('Item', hot.map(i => ({ _id: i.id, [`flags.${MODULE_ID}.heat`]: { borrowed: 0, extra: 0, locked: false } })));
                lines.push(`${esc(actor.name)}: перегрев снят${hot.length ? '' : ' (его не было)'}`);
            } else if (key === 'moon_mark') {
                await actor.setFlag(MODULE_ID, 'moonMark', { floor: getFloor(), at: Date.now() });
                lines.push(`${esc(actor.name)}: метка луны`);
            } else if (key === 'crystal') {
                const rarity = value.rarity === 'up' ? RARITY_ORDER[Math.min(RARITY_ORDER.length - 1, RARITY_ORDER.indexOf(taken.get(actor.id) ?? 'gray') + 1)] : value.rarity;
                if (value.rarity === 'up' && !taken.has(actor.id)) continue;
                const data = await randomCrystal(rarity, value.tag ?? null);
                if (data) { await actor.createEmbeddedDocuments('Item', [data]); lines.push(`${esc(actor.name)}: ${esc(data.name)}`); }
            } else if (key === 'skill') {
                const name = await randomSkillName(value.rarity);
                if (name) {
                    const result = await addSkillToMemory(actor, name, { forced: true });
                    lines.push(`${esc(actor.name)}: навык «${esc(name)}» в Памяти${result?.status === 'replaced' ? ` (вытеснен «${esc(result.replacedName)}»)` : ''}`);
                }
            } else if (key === 'hit_dice') {
                const cls = mainClass(actor);
                if (!cls) continue;
                const spent = Number(cls.system.hd?.spent ?? 0), levels = Number(cls.system.levels ?? 0);
                const next = Math.max(0, Math.min(levels, spent - value));
                await cls.update({ 'system.hd.spent': next });
                lines.push(`${esc(actor.name)}: Кости Хитов ${value > 0 ? '+' : '−'}${Math.abs(spent - next)}`);
            } else if (key === 'hp') {
                const max = Number(actor.system.attributes?.hp?.max) || 0;
                const amount = Math.max(1, Math.round(max * Math.abs(value)));
                await actor.applyDamage(value < 0 ? amount : -amount);
                lines.push(`${esc(actor.name)}: ${value < 0 ? `−${amount}` : `+${amount}`} ПЗ`);
            }
        }
    }
    return lines;
}

// ==========================================
// ОПЕРАЦИИ (выполняет Мастер)
// ==========================================

async function startEvent(found, exclude = []) {
    const ev = await pickEvent({ exclude });
    if (!ev) {
        ui.notifications.warn(`Для биома «${BIOMES[currentBiome()]?.name}» событий нет — ведите своё.`);
        return null;
    }
    const event = { id: ev.id, status: 'open', choice: null, actorId: null, success: null, text: null, lines: [] };
    await saveEvent(found, event);
    return event;
}

async function resolve(found, event, ev, success) {
    const option = ev.options[event.choice];
    const outcome = option.check ? (success ? option.success : option.failure) : option;
    const one = event.actorId ? game.actors.get(event.actorId) : null;
    const lines = await applyEffects(outcome.effects, { one, who: option.who ?? 'one', title: ev.title });
    Object.assign(event, { status: 'done', success, text: outcome.text, lines });
    await saveEvent(found, event);
    const seen = new Set(game.settings.get(MODULE_ID, 'eventsSeen') ?? []);
    seen.add(ev.id);
    await game.settings.set(MODULE_ID, 'eventsSeen', [...seen]);
    const verdict = option.check ? ` · ${success ? 'успех' : 'провал'}` : '';
    return ChatMessage.create({
        speaker: { alias: 'Дневник Разлома' },
        content: `<div class="gachadnd-map-chat gd-event-chat"><strong>${esc(ev.title)}</strong> — ${esc(option.label)}${one ? ` (${esc(one.name)})` : ''}${verdict}<br><em>${esc(outcome.text)}</em>${lines.length ? `<br><small>${lines.join(' · ')}</small>` : ''}</div>`
    });
}

async function performOp({ op, userId, ...data }) {
    const found = currentEventNode();
    const user = game.users.get(userId);
    if (!found) return;
    await loadEvents();
    const event = foundry.utils.deepClone(found.node.event ?? null);
    if (!event) return;
    const ev = byId(event.id);
    if (!ev) return;
    if (op === 'reroll') {
        if (!user?.isGM || event.status !== 'open') return;
        return startEvent(found, [event.id]);
    }
    if (op === 'choose') {
        if (event.status !== 'open') return;
        const option = ev.options[data.choice];
        if (!option) return;
        const who = option.who ?? 'one';
        const actor = who === 'none' ? null : game.actors.get(data.actorId);
        if (who !== 'none') {
            if (!actor || !partyActors().some(a => a.id === actor.id)) return notifyUser(userId, 'Выберите персонажа отряда в строке «Кто».');
            if (!user?.isGM && !actor.testUserPermission(user, 'OWNER')) return notifyUser(userId, `${actor.name} — не ваш персонаж.`);
        }
        Object.assign(event, { choice: data.choice, actorId: actor?.id ?? null });
        if (option.check) {
            event.status = 'roll';
            return saveEvent(found, event);
        }
        return resolve(found, event, ev, null);
    }
    if (op === 'roll') {
        if (event.status !== 'roll') return;
        const actor = game.actors.get(event.actorId);
        if (!user?.isGM && !actor?.testUserPermission(user, 'OWNER')) return;
        return resolve(found, event, ev, Number(data.total) >= checkDC(ev.options[event.choice]));
    }
}

const request = payload => requestGM('eventOp', payload);
let queue = Promise.resolve();
onSocket('eventOp', message => {
    if (!isActiveGM()) return;
    queue = queue.then(() => performOp(message.payload)).catch(error => console.error(`${MODULE_ID} | событие`, error));
    return queue;
});
onSocket('openEvent', () => EventWindow.show());
onSocket('closeEvent', () => EventWindow.close());

// ==========================================
// ОКНО
// ==========================================

export class EventWindow extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: ID,
        classes: ['gachadnd-map', 'gachadnd-event'],
        tag: 'div',
        window: { title: 'Дневник Разлома', icon: 'fas fa-book-open', resizable: false },
        position: { width: 1180, height: 720 },
        actions: { choose: EventWindow.#onChoose, roll: EventWindow.#onRoll, reroll: EventWindow.#onReroll, finish: EventWindow.#onFinish }
    };

    static PARTS = {
        left: { template: `modules/${MODULE_ID}/templates/events/left.hbs` },
        right: { template: `modules/${MODULE_ID}/templates/events/right.hbs` }
    };

    /** Мастер на узле События: выбрать событие (если ещё нет) и открыть у всех */
    static async open() {
        if (!game.user.isGM) return EventWindow.show();
        const found = currentEventNode();
        if (!found) return ui.notifications.warn('Событие открывается на узле «Событие».');
        if (!found.node.event) {
            await loadEvents();
            if (!(await startEvent(found))) return;
        }
        emit('openEvent');
        return EventWindow.show();
    }

    static show() {
        const existing = foundry.applications.instances?.get(ID);
        if (existing) return existing.render({ force: true }).then(() => existing.bringToFront?.());
        return new EventWindow().render({ force: true });
    }

    static close() { foundry.applications.instances?.get(ID)?.close(); }

    /** Просмотр события без узла и без последствий (проверка вида): game.gachadnd.previewEvent('swamp_lights') */
    static async preview(id) {
        await loadEvents();
        if (!byId(id)) return ui.notifications.warn(`Нет такого события: ${id}.`);
        EventWindow.close();
        const app = new EventWindow();
        app.previewId = id;
        return app.render({ force: true });
    }

    previewId = null;
    /** Проявление рисунка-картинки: { seek(k), stop() } */
    reveal = null;
    #revealSeconds = 0;
    #textStart = 0;
    #actorId = null;
    #eventId = null;

    get state() {
        if (this.previewId) return { id: this.previewId, status: 'open', choice: null, preview: true };
        return currentEventNode()?.node.event ?? null;
    }

    _configureRenderParts(options) {
        const parts = super._configureRenderParts(options);
        // Смена состояния того же события — только правая страница: рисунок не начинается заново
        if (this.rendered && this.state && this.#eventId === this.state.id) delete parts.left;
        return parts;
    }

    async _prepareContext(options) {
        await loadEvents();
        const state = this.state;
        const ev = state ? byId(state.id) : null;
        if (!ev) return { empty: true };
        const live = fxOn();
        const floor = getFloor();
        const context = { live, empty: false, isGM: game.user.isGM };
        if (this.#eventId !== ev.id || !this.rendered) {
            const size = ev.image ? { w: ev.image.w, h: ev.image.h } : SKETCH;
            // Рисунка нет — пустая страница с бледной розой ветров: «зарисовка ещё не сделана»
            const sketch = ev.image
                ? renderImageSketch({ ...ev.image, src: `modules/${MODULE_ID}/${ev.image.src}`, seed: ev.id, live })
                : ev.sketch ? renderSketch(ev.sketch, ev.id)
                : { svg: `<svg class="gd-sketch gd-ev-blank" viewBox="0 0 40 40"><path d="${DOODLES[0]}"/></svg><div class="gd-ev-blank-note">зарисовка ещё не сделана</div>`, duration: 0 };
            this.#revealSeconds = live && ev.image ? sketch.reveal : 0;
            this.#textStart = live ? sketch.duration * 0.28 : 0;
            Object.assign(context, { sketch: sketch.svg, sketchW: size.w, sketchH: size.h, caption: ev.caption ? { text: ev.caption, at: (live ? sketch.duration : 0).toFixed(2) } : null });
        }
        const start = this.#textStart;
        const mine = partyActors().filter(a => game.user.isGM || a.isOwner);
        const chosenActor = state.actorId ? game.actors.get(state.actorId) : null;
        if (!mine.some(a => a.id === this.#actorId)) this.#actorId = (mine.find(a => a.id === game.user.character?.id) ?? mine[0])?.id ?? null;
        const option = state.choice != null ? ev.options[state.choice] : null;
        const biome = Array.isArray(ev.biome) ? ev.biome[0] : ev.biome;
        Object.assign(context, {
            place: `Этаж ${ROMAN[floor - 1] ?? floor} · ${(BIOMES[biome] ?? BIOMES[currentBiome()]).name}`,
            title: ev.title,
            text: ev.text.map((t, i) => ({ t, at: (start + i * 1.1).toFixed(2) })),
            options: ev.options.map((o, i) => ({
                i, label: o.label, at: (start + ev.text.length * 1.1 + 0.4 + i * 0.4).toFixed(2),
                detail: [o.check ? `${checkLabel(o.check)}, Сл ${checkDC(o, floor)}` : null, o.detail].filter(Boolean).join(' · '),
                chosen: state.choice === i
            })),
            open: state.status === 'open',
            decided: state.status !== 'open',
            needsWho: state.status === 'open' && !state.preview && ev.options.some(o => (o.who ?? 'one') !== 'none'),
            who: mine.map(a => ({ id: a.id, name: a.name, selected: a.id === this.#actorId })),
            rolling: state.status === 'roll' ? {
                actor: chosenActor?.name ?? '',
                check: `${checkLabel(option.check)}, Сл ${checkDC(option, floor)}`,
                canRoll: !!chosenActor && (game.user.isGM || chosenActor.isOwner)
            } : null,
            done: state.status === 'done' ? { text: state.text, verdict: option?.check ? (state.success ? 'успех' : 'провал') : null, lines: (state.lines ?? []).join(' · ') } : null,
            preview: !!state.preview
        });
        return context;
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this.element.classList.toggle('live', !!context.live);
        const state = this.state;
        if (state && this.#eventId !== state.id) {
            this.#eventId = state.id;
            this.element.classList.remove('settled');
            this.reveal?.stop();
            this.reveal = this.#revealSeconds ? revealImageSketch(this.element, this.#revealSeconds) : null;
        } else if (!options.isFirstRender) this.element.classList.add('settled');
        this.element.querySelector('[name="who"]')?.addEventListener('change', e => { this.#actorId = e.target.value; });
    }

    _onClose(options) {
        this.reveal?.stop();
        super._onClose(options);
    }

    static #onChoose(event, target) {
        const choice = Number(target.dataset.i);
        if (this.previewId) {
            // Просмотр: только показать исход, без последствий
            const o = byId(this.previewId).options[choice];
            const out = this.element.querySelector('.gd-ev-outcome');
            out.textContent = o.check ? `Успех: ${o.success.text} Провал: ${o.failure.text}` : o.text;
            out.classList.add('on');
            return;
        }
        request({ op: 'choose', choice, actorId: this.#actorId });
    }

    static async #onRoll() {
        const state = this.state;
        const option = byId(state?.id)?.options[state.choice];
        const actor = game.actors.get(state?.actorId);
        if (!actor || !option?.check) return;
        const c = option.check;
        const result = c.skill ? await actor.rollSkill({ skill: c.skill }, { configure: false })
            : c.ability ? await actor.rollAbilityCheck({ ability: c.ability }, { configure: false })
            : await actor.rollSavingThrow({ ability: c.save }, { configure: false });
        const roll = Array.isArray(result) ? result[0] : result;
        if (roll?.total == null) return;
        request({ op: 'roll', total: roll.total });
    }

    static #onReroll() { request({ op: 'reroll' }); }

    static #onFinish() {
        if (!this.previewId) emit('closeEvent');
        EventWindow.close();
    }
}

// Состояние узла поменялось — окно раскладывает правую страницу (или всё — при смене события)
Hooks.on('updateScene', (scene, changes) => {
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) return;
    const app = foundry.applications.instances?.get(ID);
    if (app?.rendered && !app.previewId) app.render();
});
