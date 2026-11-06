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
import { t } from "../../core/i18n.js";

/** Теги, у которых есть камни (docs/ogranka-stones.md): пробная тройка, первая партия, бросок и цель */
export const FACET_TAGS = ['огонь', 'кровь', 'взрыв', 'свет', 'движение', 'сталь', 'проклятье', 'казнь', 'разум', 'аномалия'];
export const TAG_COLORS = { 'огонь': '#ff7a3c', 'кровь': '#e0454a', 'взрыв': '#ffc94a', 'свет': '#fff2a8', 'движение': '#7fd6ff', 'сталь': '#b8c4cc',
    'проклятье': '#9b6be0', 'казнь': '#b8323e', 'разум': '#e58fd8', 'аномалия': '#5fe0a8' };
export const SLOTS = 3;

export const CATEGORIES = {
    strike: { label: t('Удар'), icon: 'fa-hand-fist' },
    wave: { label: t('Волна'), icon: 'fa-water' },
    heal: { label: t('Лечение'), icon: 'fa-heart-pulse' },
    boost: { label: t('Усиление'), icon: 'fa-arrow-up-wide-short' },
    react: { label: t('Реакция'), icon: 'fa-reply' }
};
/**
 * Камни: тег, имя, правило одной строкой. Свобода сборки — любой камень в любое гнездо: правило меняет общее
 * свойство способности (цель, источник, дальность, цену, бросок, силу) и читается везде
 */
export const STONES = {
    hop: { tag: 'огонь', name: t('Перекидка'), text: t('Эффект перескакивает ещё на одно ближайшее существо в пределах 10 футов от цели.') },
    spread: { tag: 'огонь', name: t('Разлёт'), text: t('Эффект достаётся и всем существам в пределах 5 футов от цели.') },
    through: { tag: 'огонь', name: t('Сквозь'), text: t('Цель можно выбрать, игнорируя её укрытие, если вы её видите.') },
    pay: { tag: 'кровь', name: t('Плата кровью'), text: t('Раз в раунд вы можете использовать способность, не тратя действие или реакцию. Вы теряете ПЗ, равные вашему уровню, плюс 5 за каждый уровень потраченной ячейки.') },
    debt: { tag: 'кровь', name: t('В долг'), text: t('Вы можете использовать способность, не тратя ячейку или заряд. Вместо этого потратьте кости хитов: по одной за каждый уровень ячейки или одну вместо заряда.') },
    transfuse: { tag: 'кровь', name: t('Переливание'), text: t('Когда способность наносит урон, ближайший союзник в пределах 5 футов от вас восстанавливает столько же ПЗ. Когда она лечит, ближайший враг в пределах 5 футов от вас получает столько же некротического урона.') },
    mine: { tag: 'взрыв', name: t('Мина'), text: t('Вместо обычного использования заложите способность в клетку в пределах её дальности, но не дальше 30 футов. Она срабатывает, когда враг входит в эту клетку или проходит через неё, либо в начале вашего хода. Способность действует на врагов в этой и соседних клетках, а лечение — на союзников.') },
    echo: { tag: 'взрыв', name: t('Раскат'), text: t('В начале вашего следующего хода способность срабатывает по тем же целям ещё раз, нанося половину урона или восстанавливая половину ПЗ.') },
    cast: { tag: 'взрыв', name: t('Выброс'), text: t('Раз в ход перед использованием способности вы можете телепортироваться в видимую свободную клетку в пределах 30 футов, которая ближе к цели, чем ваша. Вы используете способность оттуда и остаётесь там.') },
    beam: { tag: 'свет', name: t('Луч'), text: t('Цель или область становится лучом 5 × 60 футов, идущим от вас. Способность срабатывает, только если цель в пределах её досягаемости или дальности.'), form: true },
    cone: { tag: 'свет', name: t('Конус'), text: t('Цель или область становится конусом 15 футов от вас. Способность срабатывает, только если цель в пределах её досягаемости или дальности.'), form: true },
    flash: { tag: 'свет', name: t('Вспышка'), text: t('Цель или область становится радиусом 10 футов вокруг вас. Способность срабатывает, только если цель в пределах её досягаемости или дальности.'), form: true },
    run: { tag: 'движение', name: t('На бегу'), text: t('Когда вы используете способность, вы можете сразу переместиться на расстояние до половины своей скорости. Способность срабатывает по всем, мимо кого вы прошли за это перемещение на расстоянии до 5 футов. Это перемещение всегда провоцирует атаки по возможности.') },
    charge: { tag: 'движение', name: t('Разбег'), text: t('Если в этот ход вы прошли не менее 20 футов прямо к цели, вы совершаете бросок атаки по ней с преимуществом, а она совершает спасбросок с помехой.') },
    swap: { tag: 'движение', name: t('Рокировка'), text: t('Раз в ход после использования способности вы можете поменяться местами с одним существом в пределах 15 футов, на которое она подействовала.') },
    weave: { tag: 'сталь', name: t('Вплетение'), text: t('Когда вы используете способность действием, вы можете этим же действием совершить одну атаку оружием ближнего боя.') },
    conduit: { tag: 'сталь', name: t('Проводник'), text: t('Способность не срабатывает сразу, а заряжает ваше оружие. Когда вы в этот ход попадаете атакой оружием ближнего боя, она срабатывает по этой цели без своего броска атаки. Цель спасброска совершает его как обычно. Если до конца хода вы не попали, способность пропадает.') },
    steady: { tag: 'сталь', name: t('Выверено'), text: t('Вы не бросаете кости урона или лечения способности, а берёте их среднее значение, округлённое вверх. Если у способности есть бросок атаки, но нет этих костей, результат атаки равен 10 + ваш бонус атаки.') },
    // Проклятье — сделка: сильнее сейчас, расплата потом (odds.js)
    inevitable: { tag: 'проклятье', name: t('Неотвратимо'), text: t('Ваша атака попадает автоматически, а цель автоматически проваливает спасбросок. Урон и лечение способности уменьшаются вдвое.') },
    jinx: { tag: 'проклятье', name: t('Сглаз'), text: t('Вы совершаете бросок атаки с преимуществом, а цель совершает спасбросок с помехой. Ваш следующий после этого бросок к20 совершается с помехой.') },
    refund: { tag: 'проклятье', name: t('Возврат'), text: t('Если вы промахнулись или все цели преуспели в спасброске, вы можете вернуть потраченную ячейку или заряд. Тогда ваш следующий бросок к20 совершается с помехой.') },
    // Казнь — по слабым
    finish: { tag: 'казнь', name: t('Добить'), text: t('Если урон сверх нужного опустил ПЗ цели до 0 или лечение восстановило все её ПЗ и осталось лишнее, вы можете передать этот излишек урона или лечения ближайшему к цели существу в пределах 30 футов.') },
    mercy: { tag: 'казнь', name: t('Без пощады'), text: t('Если у цели осталось не больше половины ПЗ, вы совершаете бросок атаки по ней с преимуществом, а она совершает спасбросок с помехой. Союзник, на которого подействовала способность, совершает свой следующий бросок к20 с преимуществом.') },
    verdict: { tag: 'казнь', name: t('Приговор'), text: t('Если у врага больше половины ПЗ, способность по нему не срабатывает сразу и ничего не тратит. Если до конца вашего следующего хода его ПЗ упадут до половины или ниже, от чего угодно, вы можете использовать её по нему и только тогда заплатить её цену.') },
    // Разум — точность
    select: { tag: 'разум', name: t('Избирательно'), text: t('Выберите любых существ. Способность и другие камни на них не действуют.') },
    redirect: { tag: 'разум', name: t('Перенаправить'), text: t('Если вы промахнулись или цель преуспела в спасброске, вы можете перенести эффект на другое существо в пределах 5 футов от неё. Результат атаки остаётся прежним, а спасбросок новая цель совершает сама.') },
    defer: { tag: 'разум', name: t('Отложенный выбор'), text: t('Вы тратите цену сразу, а способность срабатывает в конце раунда. Цель вы выбираете в этот момент.') },
    // Аномалия — случай
    fate: { tag: 'аномалия', name: t('Кубик судьбы'), text: t('Когда вы используете способность, бросьте к6. На 1 её урон или лечение уменьшается вдвое, на 6 удваивается, на 2–5 не меняется.') },
    switch: { tag: 'аномалия', name: t('Шальной заряд'), text: t('Способность срабатывает по выбранной цели как обычно, а затем сразу ещё раз по случайному существу в пределах 30 футов от вас.') },
    twin: { tag: 'аномалия', name: t('Двойное эхо'), text: t('Если на к20 броска атаки выпало 1 или 20, вы можете сразу использовать способность ещё раз по той же цели, без цены и с новым броском. Повтор не вызывает этот эффект снова.') }
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

/** Запреты огранки: (actor) => true — камни персонажа сейчас не горят (обет «Потухшие грани»). Регистрируются снаружи */
export const FACET_BLOCKS = [];

/**
 * Состояние огранки: сколько камней тега можно вставить, сколько вставлено, какие горят.
 * Камней не хватает — гаснут последние вставленные
 */
export function facetState(actor) {
    const grains = grainsOf(actor);
    const used = Object.fromEntries(FACET_TAGS.map(t => [t, 0]));
    const placed = Object.fromEntries(FACET_TAGS.map(t => [t, 0]));
    const placements = placementsOf(actor).sort((a, b) => a.at - b.at);
    const blocked = FACET_BLOCKS.some(block => block(actor));
    for (const p of placements) {
        placed[p.tag] += 1;
        p.active = !blocked && used[p.tag] < grains[p.tag];
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
    if (isInCombat(actor)) { ui.notifications.warn(t('Огранку не меняют в бою.')); return false; }
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
    if (isInCombat(actor)) { ui.notifications.warn(t('Огранку не меняют в бою.')); return false; }
    await writeSlot(actor, where, slotOf(actor, where).filter(s => s.id !== stoneId));
    return true;
}
