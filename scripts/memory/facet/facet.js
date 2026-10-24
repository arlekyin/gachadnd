/**
 * Gacha Roguelike dnd5e — Огранка: камни и гнёзда (docs/ogranka.md)
 *
 * Действующая ступень тега I / II / III даёт 1 / 2 / 3 камня этого тега — сколько их можно вставить
 * одновременно. Камни не усиливаются; любой камень тега доступен с первой ступени; каждый — в одном
 * экземпляре. Камень не добавляет своего эффекта — меняет, как срабатывает способность класса: кого
 * задевает, где и когда, чем за неё платить (что делает каждый — stones.js).
 *
 * Гнёзда: у каждого оружия свои 3 (флаг предмета stones), у каждой категории способностей класса — 3 паза
 * (флаг актёра facetSlots { категория: [...] }); камень в категории действует на все её способности.
 * Запись гнезда — { id, at }: at — когда вставлен. Камней тега стало меньше — гаснут последние вставленные,
 * но остаются в гнезде. Вне боя — свободно, в бою — нельзя.
 *
 * Категория — по активности dnd5e: Удар (атака, урон по одной цели), Волна (спасбросок с уроном, урон
 * по области), Лечение, Реакция (время — реакция), Усиление (всё остальное).
 */

import { MODULE_ID } from "../../core/constants.js";
import { isMemorySkill, isAwake, isInCombat, TAG_COUNT_MODIFIERS } from "../synergy/synergy.js";

/** Теги, у которых есть камни (docs/ogranka-stones.md): пробная тройка и первая партия */
export const FACET_TAGS = ['огонь', 'кровь', 'взрыв', 'свет', 'движение', 'сталь'];
export const TAG_COLORS = { 'огонь': '#ff7a3c', 'кровь': '#e0454a', 'взрыв': '#ffc94a', 'свет': '#fff2a8', 'движение': '#7fd6ff', 'сталь': '#b8c4cc' };
export const SLOTS = 3;

export const CATEGORIES = {
    strike: { label: 'Удар', icon: 'fa-hand-fist' },
    wave: { label: 'Волна', icon: 'fa-water' },
    heal: { label: 'Лечение', icon: 'fa-heart-pulse' },
    boost: { label: 'Усиление', icon: 'fa-arrow-up-wide-short' },
    react: { label: 'Реакция', icon: 'fa-reply' }
};
/**
 * Камни: тег, имя, правило одной строкой. Свобода сборки — любой камень в любое гнездо: правило меняет общее
 * свойство способности (цель, источник, дальность, цену, бросок, силу) и читается везде
 */
export const STONES = {
    hop: { tag: 'огонь', name: 'Перекидка', text: 'Эффект перескакивает ещё на одно существо в 10 футах от цели — на врага, если цель враг, на союзника, если союзник, — в половину силы' },
    spread: { tag: 'огонь', name: 'Разлёт', text: 'Эффект достаётся и всем в 5 футах от цели: врагам, если цель враг, союзникам, если союзник' },
    through: { tag: 'огонь', name: 'Сквозь', text: 'Цель можно выбрать сквозь её укрытие, если вы её видите; до начала вашего хода и ваше укрытие против неё не действует' },
    pay: { tag: 'кровь', name: 'Плата кровью', text: 'Раз за раунд — сверх обычной цены, за ПЗ: действием — бонусным, реакцией — второй реакцией за раунд. Цена — ваш уровень, у заклинания с ячейкой — ещё 5 × уровень ячейки' },
    debt: { tag: 'кровь', name: 'В долг', text: 'Без ячейки и заряда (без них — не тратит действие, раз за ход); в начале следующего хода ваш максимум ПЗ меньше до долгого отдыха: на 5 × уровень ячейки, без ячейки — на ваш уровень' },
    transfuse: { tag: 'кровь', name: 'Переливание', text: 'Эффект достаётся и противнику цели — рядом с вами: урон лечит ближайшего к вам союзника, лечение ранит ближайшего к вам врага — на столько же' },
    mine: { tag: 'взрыв', name: 'Мина', text: 'Можно заложить в клетку в досягаемости или дальности способности, не дальше 30 футов: сработает, когда на неё встанут или пройдут через неё, или в начале вашего хода; задевает и соседние клетки' },
    echo: { tag: 'взрыв', name: 'Раскат', text: 'В начале вашего следующего хода срабатывает ещё раз, в половину силы' },
    cast: { tag: 'взрыв', name: 'Выброс', text: 'Перед применением вы переноситесь в видимую свободную клетку в 30 футах, ближе к цели, чем стояли, и применяете оттуда — и остаётесь там (раз за ход)' },
    beam: { tag: 'свет', name: 'Луч', text: 'Первая цель — как обычно, в досягаемости или дальности; от вас через неё — линия 5 × 60 футов: задеты все на линии — враги, если цель враг, союзники, если союзник', form: true },
    cone: { tag: 'свет', name: 'Конус', text: 'Цель или область становится конусом 15 футов от вас; цель должна быть в нём, иначе камень молчит', form: true },
    flash: { tag: 'свет', name: 'Вспышка', text: 'Цель или область становится радиусом 10 футов вокруг вас; цель должна быть в нём, иначе камень молчит', form: true },
    run: { tag: 'движение', name: 'На бегу', text: 'Способность бьёт не по выбранной цели, а по первому, мимо кого вы пробежали в этот ход (в 5 футах от пути): урон — по врагу, лечение — по союзнику' },
    charge: { tag: 'движение', name: 'Разбег', text: 'Прошли в этот ход 20 футов и больше прямо к цели — ваша атака с преимуществом, её спасбросок с помехой' },
    swap: { tag: 'движение', name: 'Рокировка', text: 'До или после применения — поменяться местами с союзником в 15 футах (раз за ход)' },
    weave: { tag: 'сталь', name: 'Вплетение', text: 'Применение действием можно совместить с одной атакой оружием ближнего боя в том же действии' },
    conduit: { tag: 'сталь', name: 'Проводник', text: 'Сработает на цель вашего следующего попадания оружием ближнего боя в этот ход, вместо своего броска' },
    steady: { tag: 'сталь', name: 'Выверено', text: 'Кости силы не бросаются — берётся среднее; без костей — ваша атака не бросается: 10 + бонус' }
};
export const TAG_STONES = Object.fromEntries(FACET_TAGS.map(tag => [tag, Object.keys(STONES).filter(id => STONES[id].tag === tag)]));

const flagsOf = doc => doc?.flags?.[MODULE_ID] ?? {};

/** Счёт тегов — как у синергий: надетые и не спящие навыки, излучаемые теги, поправки (Глушитель, шрамы) */
export function facetTagCounts(actor) {
    const awake = actor.items.filter(i => isMemorySkill(i) && isAwake(i));
    const emitted = awake.filter(i => flagsOf(i).tagEmitter && flagsOf(i).emitted_tag).map(i => String(flagsOf(i).emitted_tag).toLowerCase().trim());
    const counts = {};
    for (const item of awake) {
        const tags = new Set((flagsOf(item).tags ?? []).map(t => String(t).toLowerCase().trim()));
        if (!flagsOf(item).tagEmitter) emitted.forEach(t => tags.add(t));
        else if (flagsOf(item).emitted_tag) tags.add(String(flagsOf(item).emitted_tag).toLowerCase().trim());
        tags.forEach(t => { counts[t] = (counts[t] ?? 0) + 1; });
    }
    for (const modify of TAG_COUNT_MODIFIERS) {
        try { modify(actor, counts); } catch (error) { console.error(`${MODULE_ID} | огранка: поправка тегов`, error); }
    }
    return counts;
}

/** Сколько камней тега можно вставить: ступень I / II / III — 1 / 2 / 3 */
export function grainsOf(actor) {
    const counts = facetTagCounts(actor);
    return Object.fromEntries(FACET_TAGS.map(tag => [tag, Math.floor(Math.min(counts[tag] ?? 0, 6) / 2)]));
}

/** Способность класса, которую можно огранить: оружие, черта класса или подкласса с действием, заклинание */
export function isFacetable(item) {
    if (!item || isMemorySkill(item) || flagsOf(item).is_synergy_item || flagsOf(item).is_crystal_item) return false;
    if (!(item.system?.activities?.size > 0)) return false;
    if (item.type === 'weapon' || item.type === 'spell') return true;
    return item.type === 'feat' && ['class', 'subclass'].includes(item.system?.type?.value);
}

/** Категория одной активности */
export function formOfActivity(activity) {
    if (!activity) return null;
    if (activity.activation?.type === 'reaction') return 'react';
    if (activity.type === 'attack') return 'strike';
    if (activity.type === 'heal') return 'heal';
    if (activity.type === 'save' && activity.damage?.parts?.length) return 'wave';
    // Урон без атаки и спасброска (кары): по области — Волна, иначе Удар
    if (activity.type === 'damage') return activity.target?.template?.type ? 'wave' : 'strike';
    return 'boost';
}
/** Категории способности — по всем её активностям */
export function formsOf(item) {
    return [...new Set([...(item.system?.activities?.values() ?? [])].map(formOfActivity).filter(Boolean))];
}

/** Гнездо: id оружия или ключ категории. Записи гнезда [{ id, at }] */
const isCategory = where => where in CATEGORIES;
export function slotOf(actor, where) {
    const list = isCategory(where) ? flagsOf(actor).facetSlots?.[where] : flagsOf(actor.items.get(where)).stones;
    return (list ?? []).filter(s => STONES[s?.id]);
}
async function writeSlot(actor, where, list) {
    if (isCategory(where)) return actor.update({ [`flags.${MODULE_ID}.facetSlots.${where}`]: list });
    return actor.items.get(where)?.setFlag(MODULE_ID, 'stones', list);
}

/** Все вставленные камни персонажа: [{ where, id, tag, at }] — оружие, которого уже нет, не в счёт */
export function placementsOf(actor) {
    const out = [];
    for (const where of Object.keys(CATEGORIES)) for (const s of slotOf(actor, where)) out.push({ where, id: s.id, tag: STONES[s.id].tag, at: s.at ?? 0 });
    for (const item of actor.items.filter(i => i.type === 'weapon' && isFacetable(i))) {
        for (const s of slotOf(actor, item.id)) out.push({ where: item.id, id: s.id, tag: STONES[s.id].tag, at: s.at ?? 0 });
    }
    return out;
}

/**
 * Состояние огранки: сколько камней тега можно вставить, сколько вставлено, какие горят.
 * Камней не хватает — гаснут последние вставленные
 */
export function facetState(actor) {
    const grains = grainsOf(actor);
    const used = Object.fromEntries(FACET_TAGS.map(t => [t, 0]));
    const placed = Object.fromEntries(FACET_TAGS.map(t => [t, 0]));
    const placements = placementsOf(actor).sort((a, b) => a.at - b.at);
    for (const p of placements) {
        placed[p.tag] += 1;
        p.active = used[p.tag] < grains[p.tag];
        if (p.active) used[p.tag] += 1;
    }
    const where = Object.fromEntries(placements.map(p => [p.id, p]));
    return { grains, used, placed, placements, where };
}

/** Действующие камни активности: оружие — свои гнёзда, способность класса — гнёзда её категории */
export function stonesFor(activity) {
    const item = activity?.item, actor = item?.actor;
    if (!actor || !isFacetable(item)) return [];
    const where = item.type === 'weapon' ? item.id : formOfActivity(activity);
    if (!where) return [];
    const ids = facetState(actor).placements.filter(p => p.where === where && p.active).map(p => p.id);
    // Форма света — одна: действует последняя вставленная (размещения уже по времени)
    const forms = ids.filter(id => STONES[id].form);
    return forms.length > 1 ? ids.filter(id => !STONES[id].form || id === forms.at(-1)) : ids;
}

/**
 * Вставить камень в гнездо (оружие или категория). Камень в одном экземпляре — из прежнего гнезда
 * переезжает. Только вне боя; гнездо не больше трёх; камней тега — не больше, чем даёт ступень
 */
export async function placeStone(actor, where, stoneId) {
    const stone = STONES[stoneId];
    if (!actor || !stone || !(isCategory(where) || actor.items.get(where)?.type === 'weapon')) return false;
    if (isInCombat(actor)) { ui.notifications.warn('Огранку не меняют в бою.'); return false; }
    const state = facetState(actor);
    const before = state.where[stoneId];
    if (before?.where === where) return true;
    if (slotOf(actor, where).length >= SLOTS) return false;
    if (!before && state.placed[stone.tag] >= state.grains[stone.tag]) return false;
    if (before) await writeSlot(actor, before.where, slotOf(actor, before.where).filter(s => s.id !== stoneId));
    await writeSlot(actor, where, [...slotOf(actor, where), { id: stoneId, at: Date.now() }]);
    return true;
}

/** Вынуть камень из гнезда. Только вне боя */
export async function removeStone(actor, where, stoneId) {
    if (!actor) return false;
    if (isInCombat(actor)) { ui.notifications.warn('Огранку не меняют в бою.'); return false; }
    await writeSlot(actor, where, slotOf(actor, where).filter(s => s.id !== stoneId));
    return true;
}
