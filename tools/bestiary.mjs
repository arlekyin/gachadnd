/**
 * Сборка бестиария: существа Лабиринта → dist/packs/gacha-bestiary/*.json (актёры dnd5e с атаками,
 * особенностями и эффектами). Существа описаны здесь же кодом: у актёра много вложенных документов,
 * и общий шаблон активностей короче YAML.
 *
 * Пожиратель — аномалия, бывший исследователь Лабиринта, Большой (2×2). Числа рассчитаны на второй этаж
 * (мини-босс, ПО 4); рост от возвращений — эффекты «Насыщение N» на актёре: Мастер включает один.
 * Формулы атак и Сл читают @flags.gachadnd.satiety — его задаёт включённый эффект.
 * Иконки — только из модуля и подтверждённые пути ядра Foundry: неверный путь дал бы пустую картинку.
 */

import fs from 'fs';
import path from 'path';

const IMG = 'modules/gachadnd/assets/bestiary/devourer.webp';
const TOKEN = 'modules/gachadnd/assets/bestiary/devourer-token.webp';
const SATIETY = '@flags.gachadnd.satiety';
const DC = `13 + ${SATIETY}`;

// Память Пожирателя: навыки компендиума по граням к6. В бою доступен только навык выпавшей грани
const MEMORY = ['Квен', 'Удалой рывок', 'Хайзенберг', 'Игни', 'Нейрализатор', 'Фус-Ро-Да'];

/**
 * @param {{ distDir: string, stableId: (...parts: string[]) => string, skills: object[] }} options
 *   skills — собранные предметы навыков (ранг I) из компендиума навыков.
 * @returns {string[]}  Имена собранных существ.
 */
export function buildBestiary({ distDir, stableId, skills }) {
    const out = path.join(distDir, 'gacha-bestiary');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const actors = [devourer(stableId, skills), scrap(stableId), portal(stableId)];
    for (const actor of actors) {
        fs.writeFileSync(path.join(out, `${actor.name}_${actor._id}.json`), JSON.stringify(actor, null, 2) + '\n', 'utf8');
    }
    return actors.map(a => a.name);
}

// ==========================================
// ШАБЛОНЫ АКТИВНОСТЕЙ И ПРЕДМЕТОВ dnd5e
// ==========================================

const part = (number, denomination, types, formula) => ({
    number: formula ? null : number, denomination: formula ? null : denomination, bonus: '', types,
    custom: { enabled: !!formula, formula: formula ?? '' },
    scaling: { mode: '', number: null, formula: '' }
});

function activity(id, type, name, { activation = 'action', range, self = false, ...rest } = {}) {
    return {
        _id: id, type, name, sort: 0,
        activation: { type: activation, value: ['action', 'bonus', 'reaction'].includes(activation) ? 1 : null, condition: '', override: false },
        consumption: { targets: [], scaling: { allowed: false, max: '' }, spellSlot: true },
        description: { chatFlavor: '' },
        duration: { concentration: false, value: '', units: 'inst', special: '', override: false },
        effects: [],
        range: self ? { units: 'self', special: '', override: false } : range ? { value: String(range), units: 'ft', special: '', override: false } : { units: '', special: '', override: false },
        target: {
            template: { count: '', contiguous: false, type: '', size: '', width: '', height: '', units: 'ft' },
            affects: { count: '', type: self ? 'self' : '', choice: false, special: '' },
            prompt: true, override: false
        },
        uses: { spent: 0, max: '', recovery: [] },
        ...rest
    };
}

const html = (...paragraphs) => paragraphs.map(p => p.startsWith('<') ? p : `<p>${p}</p>`).join('');

// Расход легендарных действий: dnd5e списывает их из ресурса актёра
const legendaryCost = n => ({ targets: [{ type: 'attribute', target: 'resources.legact.value', value: String(n), scaling: { mode: '', formula: '' } }], scaling: { allowed: false, max: '' }, spellSlot: true });

function item(actorId, id, type, name, img, description, system = {}, activities = []) {
    return {
        _id: id, name, type, img,
        system: {
            description: { value: description, chat: '' },
            source: { custom: 'Gacha Roguelike', book: '', page: '', license: '', rules: '2024', revision: 1 },
            identifier: '',
            activities: Object.fromEntries(activities.map(a => [a._id, a])),
            ...system
        },
        effects: [], folder: null, sort: 0, ownership: { default: 0 }, flags: {},
        _key: `!actors.items!${actorId}.${id}`
    };
}

const feat = (actorId, id, name, img, description, activities = [], uses) => item(actorId, id, 'feat', name, img, description, {
    type: { value: 'monster', subtype: '' }, requirements: '', properties: [],
    uses: uses ?? { max: '', spent: 0, recovery: [] }
}, activities);

const natural = (actorId, id, name, img, description, dice, activities) => item(actorId, id, 'weapon', name, img, description, {
    quantity: 1, weight: { value: 0, units: 'lb' }, price: { value: 0, denomination: 'gp' },
    equipped: true, identified: true, proficient: 1, properties: [],
    range: { value: null, long: null, units: 'ft', reach: null },
    uses: { max: '', spent: 0, recovery: [] },
    damage: { base: part(dice[0], dice[1], [dice[2]]), versatile: part(null, null, []) },
    type: { value: 'natural', baseItem: '' }
}, activities);

// ==========================================
// ПОЖИРАТЕЛЬ
// ==========================================

function devourer(stableId, skills) {
    const A = stableId('bestiary', 'devourer');
    const id = (...parts) => stableId('bestiary', 'devourer', ...parts);
    const attack = (key, name) => activity(id(key, 'attack'), 'attack', name, {
        range: 5,
        attack: { ability: 'str', bonus: SATIETY, critical: { threshold: null }, flat: false, type: { value: 'melee', classification: 'weapon' } },
        damage: { critical: { bonus: '' }, includeBase: true, parts: [] }
    });
    const digest = (key, label, amount) => activity(id('bite', 'heal', key), 'heal', `Переварить: ${label}`, {
        activation: 'special', self: true, healing: part(null, null, ['healing'], String(amount))
    });

    const items = [
        feat(A, id('scent'), 'Нюх вероятности', 'modules/gachadnd/assets/icons/skills/red_fog_active.webp', html(
            'Пожиратель знает, где лежит каждый кристалл на этаже и у кого он.',
            'Он совершает атаки с <strong>преимуществом</strong> по существу, у которого больше всего кристаллов (по весу: серый и зелёный — 1, синий — 2, фиолетовый — 3, красный и оранжевый — 5).'
        )),
        feat(A, id('seam'), 'Шов', 'modules/gachadnd/assets/icons/skills/grey_fog_active.webp', html(
            'Пожиратель не выходит из готового портала — он рвёт ткань узла там, где сильнее всего пахнет.',
            '<ul><li><strong>Знак.</strong> В начале раунда, когда он прорывается, в воздухе проступает трещина над носителем самого большого запаса кристаллов: всем видно, у кого он появится, но не раньше этого раунда.</li>' +
            '<li><strong>Выход.</strong> На счёте инициативы 20 он появляется в свободном месте в пределах 10 футов от этого носителя и сразу совершает ход.</li>' +
            '<li><strong>Наполовину в Пределе.</strong> До конца своего первого хода он неуязвим к урону и состояниям: заготовленные ловушки и залпы в точку появления уходят в туман.</li></ul>'
        )),
        feat(A, id('layers'), 'Слои памяти', 'modules/gachadnd/assets/icons/skills/purple_fog_crystall.webp', html(
            'Тело Пожирателя — три слоя чужих воспоминаний; каждый — треть его максимума ПЗ (при 90 ПЗ — по 30).',
            '<ul><li>За один раунд — от начала его хода до начала следующего — разрушить можно <strong>только один слой</strong>. Урон сверх границы слоя в этом раунде пропадает: память осыпается, но держит.</li>' +
            '<li>Разрушенный слой отмечайте зарядом этой особенности. Слой рушится — Пожиратель на миг рассыпается и собирается: Отрыжка памяти срабатывает на первом слое, а не на половине ПЗ.</li>' +
            '<li>Убить его можно не быстрее чем за три раунда — он успеет ходить.</li></ul>'
        ), [], { max: '3', spent: 0, recovery: [] }),
        feat(A, id('adapt'), 'Адаптация', 'modules/gachadnd/assets/icons/skills/blue_fog_crystall.webp', html(
            'Он помнит, чем его ранили. Когда рушится слой памяти, Пожиратель получает <strong>сопротивление</strong> к типу урона, который нанёс этому слою больше всего, до конца встречи. Повторная адаптация к тому же типу — <strong>иммунитет</strong>.',
            'Мастер добавляет тип в сопротивления на листе. Бить одним и тем же — порох, огонь, излюбленный навык — всё хуже с каждым слоем.'
        )),
        feat(A, id('belly'), 'Брюхо', 'modules/gachadnd/assets/icons/skills/purple_fog_crystall.webp', html(
            'Проглоченные Укусом кристаллы лежат в Брюхе отдельной кучей до конца встречи. Мастер переносит их в инвентарь Пожирателя и отмечает вес.',
            '<strong>Насытился.</strong> Если в начале его хода вес Брюха не меньше <strong>3 + Насыщение</strong>, он рассыпается туманом и уходит вместе с Брюхом: эти кристаллы потеряны для отряда, Насыщение +1.'
        )),
        feat(A, id('retreat'), 'Туманное отступление', 'modules/gachadnd/assets/icons/skills/grey_fog_active.webp', html(
            'На 0 ПЗ Пожиратель не умирает, а рассыпается туманом.',
            '<ul><li>Он выплёвывает Брюхо: проглоченные кристаллы падают на пол, их можно подобрать.</li><li>Остаётся <strong>Сердце аномалии</strong> (в инвентаре Пожирателя).</li><li>Золото: База этажа × 0,3.</li><li>Насыщение +1. Он вернётся, если Запах отряда не упадёт ниже порога Шёпота.</li></ul>'
        )),
        feat(A, id('multiattack'), 'Мультиатака', 'icons/skills/melee/blade-tips-triple-steel.webp', html(
            'Пожиратель совершает две атаки: две Когтем или одну Когтем и одну Укусом-пожиранием.'
        ), [activity(id('multiattack', 'use'), 'utility', 'Мультиатака', { roll: { formula: '', name: '', prompt: false, visible: false } })]),
        natural(A, id('claw'), 'Коготь', 'icons/skills/melee/strike-slashes-red.webp', html(
            'Рукопашная атака: досягаемость 5 футов. Урон 2к6 + модификатор Силы, рубящий. К попаданию прибавляется Насыщение.'
        ), [2, 6, 'slashing'], [attack('claw', 'Коготь')]),
        natural(A, id('bite'), 'Укус-пожирание', 'icons/creatures/abilities/mouth-teeth-long-red.webp', html(
            'Рукопашная атака: досягаемость 5 футов. Урон 2к8 + модификатор Силы, колющий. К попаданию прибавляется Насыщение.',
            '<strong>Пожирание кристалла.</strong> Если у цели есть кристаллы, она проходит спасбросок Ловкости (Сл 13 + Насыщение). При провале случайный кристалл из её инвентаря уходит в Брюхо.',
            '<strong>Переварить.</strong> Пожиратель восстанавливает 5 ПЗ за каждую единицу веса проглоченного кристалла: кнопки по редкости.'
        ), [2, 8, 'piercing'], [
            attack('bite', 'Укус'),
            activity(id('bite', 'save'), 'save', 'Пожирание кристалла', {
                activation: 'special', range: 5,
                save: { ability: ['dex'], dc: { calculation: '', formula: DC } },
                damage: { onSave: 'none', parts: [] }
            }),
            digest('common', 'серый или зелёный', 5),
            digest('blue', 'синий', 10),
            digest('purple', 'фиолетовый', 15),
            digest('red', 'красный или оранжевый', 25)
        ]),
        feat(A, id('memory'), 'Память Пожирателя', 'modules/gachadnd/assets/icons/skills/purple_fog_active.webp', html(
            'Он держал в голове слишком много навыков — шесть ещё всплывают. В начале каждого своего хода Пожиратель бросает 1к6: в этот ход он может использовать только навык выпавшей грани, по его обычной активации и без расхода зарядов. Остальные заперты. С Насыщения 2 он бросает дважды и выбирает.',
            '<ol>' + MEMORY.map(name => `<li>${name}</li>`).join('') + '</ol>',
            'Сл навыков — 13 + Насыщение. Навыки — отдельные строки на листе с номером грани.'
        ), [activity(id('memory', 'roll'), 'utility', 'Всплывает', { activation: 'special', roll: { formula: '1d6', name: 'Память Пожирателя', prompt: false, visible: true } })]),
        ...MEMORY.map((name, n) => memorySkill(A, id('memory', String(n + 1)), n + 1, skills.find(i => i.name === name), name)),
        feat(A, id('burp'), 'Отрыжка памяти', 'modules/gachadnd/assets/icons/skills/grey_fog_active.webp', html(
            'Когда рушится первый слой памяти, Пожиратель выкашливает 2 Огрызков памяти в свободные места в пределах 10 футов. Они действуют сразу после него.'
        )),
        feat(A, id('lair'), 'Разрыв ткани (логово)', 'modules/gachadnd/assets/icons/skills/red_fog_active.webp', html(
            'Узел, куда он прорвался, рвётся. На счёте инициативы 20 (проигрывая ничьи) бросьте 1к4:',
            '<ol>' +
            '<li><strong>Тяга запаха.</strong> Каждое существо с кристаллами в пределах 60 футов совершает спасбросок Силы (Сл 13 + Насыщение) или притягивается на 10 футов к Пожирателю.</li>' +
            '<li><strong>Туманная стена.</strong> Стена тумана длиной 30 футов и высотой 10 футов в пределах 60 футов: местность сильно заслонена до следующего счёта 20. Слепое зрение Пожирателя её не замечает.</li>' +
            '<li><strong>Кристаллы гудят.</strong> Каждое существо, несущее кристаллы общим весом 3 и больше, совершает спасбросок Мудрости (Сл 13 + Насыщение): 2к6 урона психической энергией, при успехе половина.</li>' +
            '<li><strong>Шов рвётся.</strong> Пожиратель и до двух Огрызков телепортируются в свободные места в пределах 10 футов от носителя самого большого запаса кристаллов.</li>' +
            '</ol>',
            '<strong>Приманка.</strong> Любое существо может бонусным действием бросить в точку в пределах 30 футов сколько угодно своих кристаллов — одной кучей.',
            '<ul><li><strong>Пожиратель</strong> идёт на запах сильнейшего. Куча перетягивает его, только если её вес больше, чем у любого существа в пределах 60 футов: тогда на своём следующем ходу он обязан двигаться к ней, дойдя — глотает всю кучу в Брюхо. Один серый кристалл против носителя двадцати его не отвлечёт.</li>' +
            '<li><strong>Огрызки</strong> — падальщики: брошенный кристалл ближе носителя они хватают в первую очередь, любой кучи хватает.</li></ul>'
        ), [
            activity(id('lair', 'roll'), 'utility', 'Разрыв ткани', { activation: 'lair', roll: { formula: '1d4', name: 'Разрыв ткани', prompt: false, visible: true } }),
            activity(id('lair', 'pull'), 'save', 'Тяга запаха', {
                activation: 'lair', range: 60,
                save: { ability: ['str'], dc: { calculation: '', formula: DC } },
                damage: { onSave: 'none', parts: [] }
            }),
            activity(id('lair', 'hum'), 'save', 'Кристаллы гудят', {
                activation: 'lair',
                save: { ability: ['wis'], dc: { calculation: '', formula: DC } },
                damage: { onSave: 'half', parts: [part(2, 6, ['psychic'])] }
            })
        ]),
        feat(A, id('reroll'), 'Перекрутка', 'modules/gachadnd/assets/icons/skills/blue_fog_active.webp', html(
            'Реакция, 1 раз в раунд. Когда существо в пределах 60 футов, которое Пожиратель видит, попадает по нему атакой или преуспевает в спасброске против его эффекта, бросок перебрасывается. Существо обязано взять новый результат.'
        ), [activity(id('reroll', 'use'), 'utility', 'Перекрутка', { activation: 'reaction', range: 60, roll: { formula: '', name: '', prompt: false, visible: false } })]),
        feat(A, id('legres'), 'Легендарное сопротивление', 'modules/gachadnd/assets/icons/skills/purple_fog_crystall.webp', html(
            'Один раз за встречу (с Насыщения 2 — дважды), проваливая спасбросок, Пожиратель может считать его успешным.',
            'Эффект Насыщения 2 и выше добавляет 1 к максимуму; перед встречей поставьте текущее значение равным максимуму.'
        )),
        feat(A, id('legendary'), 'Легендарные действия', 'modules/gachadnd/assets/icons/skills/purple_fog_active.webp', html(
            'Пожиратель совершает 2 легендарных действия за раунд, сразу после хода другого существа; восстанавливает их в начале своего хода.',
            '<ul><li><strong>Тень (1).</strong> Перемещается на расстояние до половины скорости, не провоцируя атак.</li>' +
            '<li><strong>Коготь (1).</strong> Одна атака Когтем.</li>' +
            '<li><strong>Глоток (2).</strong> Одна атака Укусом-пожиранием.</li></ul>'
        ), [
            activity(id('legendary', 'shadow'), 'utility', 'Тень', { activation: 'legendary', consumption: legendaryCost(1), roll: { formula: '', name: '', prompt: false, visible: false } }),
            activity(id('legendary', 'claw'), 'attack', 'Коготь (легендарное)', {
                activation: 'legendary', range: 5, consumption: legendaryCost(1),
                attack: { ability: 'str', bonus: SATIETY, critical: { threshold: null }, flat: false, type: { value: 'melee', classification: 'weapon' } },
                damage: { critical: { bonus: '' }, includeBase: false, parts: [part(2, 6, ['slashing'], '2d6 + @abilities.str.mod')] }
            }),
            activity(id('legendary', 'bite'), 'attack', 'Глоток (легендарное, 2)', {
                activation: 'legendary', range: 5, consumption: legendaryCost(2),
                attack: { ability: 'str', bonus: SATIETY, critical: { threshold: null }, flat: false, type: { value: 'melee', classification: 'weapon' } },
                damage: { critical: { bonus: '' }, includeBase: false, parts: [part(2, 8, ['piercing'], '2d8 + @abilities.str.mod')] }
            })
        ]),
        item(A, id('heart'), 'loot', 'Сердце аномалии', 'modules/gachadnd/assets/icons/skills/red_fog_crystall.webp', html(
            'Остаётся, когда Пожиратель рассыпается туманом. Пульсирует в такт чужим воспоминаниям.',
            'Носитель навыка «Пожиратель» может съесть его в этом бою. Иначе — ценный трофей: его можно продать или обменять на Событии.'
        ), { quantity: 1, weight: { value: 1, units: 'lb' }, price: { value: 0, denomination: 'gp' }, identified: true, type: { value: '', subtype: '' }, properties: [] })
    ];

    // Насыщение: Мастер включает один эффект — тот, что равен числу возвращений и кормлений
    const effects = [1, 2, 3, 4, 5].map(n => ({
        _id: id('satiety', String(n)),
        name: `Насыщение ${n}`,
        img: 'modules/gachadnd/assets/icons/skills/purple_fog_crystall.webp',
        disabled: true, transfer: false,
        changes: [
            { key: 'flags.gachadnd.satiety', mode: 5, value: String(n), priority: 20 },
            { key: 'system.attributes.hp.max', mode: 2, value: String(15 * (n >= 3 ? n - 1 : 1)), priority: 20 },
            ...(n >= 2 ? [{ key: 'system.resources.legres.max', mode: 2, value: '1', priority: 20 }] : [])
        ],
        description: html(`Насыщение ${n}: +${n} к попаданию и Сл, +${15 * (n >= 3 ? n - 1 : 1)} к максимуму ПЗ` +
            (n >= 2 ? ', легендарное сопротивление +1, Память — два броска на выбор' : '') +
            (n >= 3 ? ', Укус глотает 2 кристалла' : '') + '. Включайте только один эффект Насыщения.'),
        duration: {}, origin: null, statuses: [], flags: {}, tint: '#ffffff',
        _key: `!actors.effects!${A}.${id('satiety', String(n))}`
    }));

    return {
        _id: A,
        name: 'Пожиратель',
        type: 'npc',
        img: IMG,
        system: {
            abilities: Object.fromEntries(Object.entries({ str: 16, dex: 16, con: 18, int: 6, wis: 14, cha: 8 })
                .map(([key, value]) => [key, { value, proficient: ['dex', 'wis'].includes(key) ? 1 : 0, bonuses: { check: '', save: '' } }])),
            attributes: {
                ac: { flat: 14, calc: 'natural', formula: '' },
                hp: { value: 90, max: 90, temp: 0, tempmax: 0, formula: '13d8 + 32' },
                movement: { walk: 40, climb: 30, burrow: 0, fly: 0, swim: 0, units: 'ft', hover: false },
                senses: { darkvision: 60, blindsight: 30, tremorsense: 0, truesight: 0, units: 'ft', special: '' }
            },
            details: {
                biography: { value: biography(), public: '' },
                alignment: 'Хаотично-нейтральный',
                type: { value: 'aberration', subtype: 'аномалия', swarm: '', custom: '' },
                cr: 4, environment: 'Лабиринт Тумана'
            },
            traits: {
                size: 'lg',
                ci: { value: ['charmed', 'frightened'], custom: '' },
                languages: { value: [], custom: 'понимает языки, которые знал, но говорит только «ещё»' }
            },
            resources: { legact: { value: 2, max: 2 }, legres: { value: 1, max: 1 }, lair: { value: true, initiative: 20 } },
            source: { custom: 'Gacha Roguelike', book: '', page: '', license: '', rules: '2024', revision: 1 }
        },
        prototypeToken: {
            name: 'Пожиратель', displayName: 20, actorLink: true, disposition: -1, displayBars: 40,
            bar1: { attribute: 'attributes.hp' }, width: 2, height: 2,
            texture: { src: TOKEN, scaleX: 1, scaleY: 1 },
            // Зрение токена: Мастер, выбрав его на тёмной сцене, видит его глазами, а не пустоту
            sight: { enabled: true, range: 60, visionMode: 'darkvision' }
        },
        items,
        effects,
        folder: null, sort: 0, ownership: { default: 0 },
        flags: { gachadnd: { satiety: 0, creature: 'devourer' } },
        _key: `!actors!${A}`
    };
}

// Навык из компендиума в Памяти Пожирателя: без зарядов и флагов модуля (это не Память персонажа:
// синергии и триггеры его не трогают), Сл — общая формула Пожирателя
function memorySkill(actorId, id, face, source, name) {
    if (!source) throw new Error(`Бестиарий: навык «${name}» не найден в компендиуме навыков`);
    const copy = structuredClone(source);
    const activities = Object.fromEntries(Object.values(copy.system.activities ?? {}).map(a => {
        a.consumption = { targets: [], scaling: { allowed: false, max: '' }, spellSlot: true };
        if (a.save) a.save.dc = { calculation: '', formula: DC };
        return [a._id, a];
    }));
    return {
        _id: id, name: `${face}. ${copy.name}`, type: copy.type, img: copy.img,
        system: {
            ...copy.system,
            description: { value: `<p><em>Память Пожирателя, грань ${face}: доступен в ход, когда выпала эта грань.</em></p>${copy.system.description?.value ?? ''}`, chat: '' },
            uses: { max: '', spent: 0, recovery: [] },
            activities
        },
        effects: (copy.effects ?? []).map(e => ({ ...e, _key: `!actors.items.effects!${actorId}.${id}.${e._id}` })),
        folder: null, sort: face * 10, ownership: { default: 0 },
        flags: { gachadnd: { devourer_memory: face } },
        _key: `!actors.items!${actorId}.${id}`
    };
}

// ==========================================
// ОГРЫЗОК ПАМЯТИ — свита Пожирателя
// ==========================================

function scrap(stableId) {
    const A = stableId('bestiary', 'scrap');
    const id = (...parts) => stableId('bestiary', 'scrap', ...parts);
    // Иконка ядра Foundry, которую использует сам dnd5e: путь гарантированно существует
    const img = 'icons/creatures/unholy/demon-winged-cyclops-drooling.webp';
    const items = [
        feat(A, id('carry'), 'Носильщик', 'modules/gachadnd/assets/icons/skills/grey_fog_active.webp', html(
            'Огрызок держит не больше одного кристалла. С кристаллом он движется к Пожирателю; если заканчивает ход в пределах 5 футов от него, кристалл уходит в Брюхо.',
            'Убитый Огрызок роняет кристалл на месте. Брошенный кристалл (Приманка) ближе носителя Огрызок хватает в первую очередь.'
        )),
        feat(A, id('crumble'), 'Рассыпчатый', 'modules/gachadnd/assets/icons/skills/grey_fog_active.webp', html(
            'На 0 ПЗ Огрызок рассыпается туманом: клетка, где он стоял, сильно заслонена до конца следующего раунда.'
        )),
        natural(A, id('grab'), 'Хват', 'icons/creatures/claws/claw-scaled-red.webp', html(
            'Рукопашная атака: досягаемость 5 футов. Урон 1к6 + модификатор Ловкости, колющий.',
            '<strong>Выхватить.</strong> Если у цели есть кристаллы и у Огрызка руки пусты, цель проходит спасбросок Ловкости Сл 12. При провале Огрызок выхватывает случайный кристалл.'
        ), [1, 6, 'piercing'], [
            activity(id('grab', 'attack'), 'attack', 'Хват', {
                range: 5,
                attack: { ability: 'dex', bonus: '', critical: { threshold: null }, flat: false, type: { value: 'melee', classification: 'weapon' } },
                damage: { critical: { bonus: '' }, includeBase: true, parts: [] }
            }),
            activity(id('grab', 'save'), 'save', 'Выхватить', {
                activation: 'special', range: 5,
                save: { ability: ['dex'], dc: { calculation: '', formula: '12' } },
                damage: { onSave: 'none', parts: [] }
            })
        ])
    ];
    return {
        _id: A, name: 'Огрызок памяти', type: 'npc', img,
        system: {
            abilities: Object.fromEntries(Object.entries({ str: 8, dex: 14, con: 12, int: 3, wis: 10, cha: 3 })
                .map(([key, value]) => [key, { value, proficient: 0, bonuses: { check: '', save: '' } }])),
            attributes: {
                ac: { flat: 12, calc: 'natural', formula: '' },
                hp: { value: 9, max: 9, temp: 0, tempmax: 0, formula: '2d6 + 2' },
                movement: { walk: 30, climb: 30, burrow: 0, fly: 0, swim: 0, units: 'ft', hover: false },
                senses: { darkvision: 60, blindsight: 0, tremorsense: 0, truesight: 0, units: 'ft', special: '' }
            },
            details: {
                biography: { value: html('<em>Обрывок исследователя, которого Пожиратель когда-то съел вместе с кристаллами. Помнит только, что надо нести.</em>'), public: '' },
                alignment: 'Без мировоззрения',
                type: { value: 'aberration', subtype: 'аномалия', swarm: '', custom: '' },
                cr: 0.25, environment: 'Лабиринт Тумана'
            },
            traits: { size: 'sm', ci: { value: ['charmed', 'frightened'], custom: '' }, languages: { value: [], custom: '' } },
            source: { custom: 'Gacha Roguelike', book: '', page: '', license: '', rules: '2024', revision: 1 }
        },
        prototypeToken: {
            name: 'Огрызок памяти', displayName: 20, actorLink: false, disposition: -1, displayBars: 40,
            bar1: { attribute: 'attributes.hp' }, width: 1, height: 1,
            texture: { src: img, scaleX: 0.8, scaleY: 0.8, tint: '#b4b4b4' }, sight: { enabled: true, range: 60, visionMode: 'darkvision' }, appendNumber: true
        },
        items, effects: [], folder: null, sort: 0, ownership: { default: 0 },
        flags: { gachadnd: { creature: 'scrap' } },
        _key: `!actors!${A}`
    };
}

// ==========================================
// ПОРТАЛ УЗЛА — метка на сцене, источающая свет
// ==========================================

// Не существо: токен-метка перехода между узлами. Светит сам, поэтому на тёмной сцене виден всем,
// кто видит его свет; полосы и имя скрыты, в бой его не добавляют
function portal(stableId) {
    const A = stableId('bestiary', 'portal');
    // Цвет серого навыка (#9d9d9d) — как туман серой редкости
    const img = 'modules/gachadnd/assets/icons/skills/grey_fog_active.webp';
    return {
        _id: A, name: 'Портал узла', type: 'npc', img,
        system: {
            attributes: {
                ac: { flat: 20, calc: 'flat', formula: '' },
                hp: { value: 1, max: 1, temp: 0, tempmax: 0, formula: '' },
                movement: { walk: 0, climb: 0, burrow: 0, fly: 0, swim: 0, units: 'ft', hover: false }
            },
            details: {
                biography: { value: html('Разрыв ткани Лабиринта: проход к соседнему узлу. Метка для сцены — светится и медленно закручивается.', 'Цвет и радиус света меняются в настройках токена, вкладка «Свет».'), public: '' },
                type: { value: 'custom', subtype: '', swarm: '', custom: 'портал' }, cr: 0
            },
            traits: { size: 'med', ci: { value: [], custom: '' }, languages: { value: [], custom: '' } },
            source: { custom: 'Gacha Roguelike', book: '', page: '', license: '', rules: '2024', revision: 1 }
        },
        prototypeToken: {
            name: 'Портал узла', displayName: 0, displayBars: 0, actorLink: false, disposition: 0,
            width: 2, height: 2, lockRotation: true,
            texture: { src: img, scaleX: 1.2, scaleY: 1.2 },
            sight: { enabled: false },
            light: {
                bright: 10, dim: 30, angle: 360, color: '#9d9d9d', alpha: 0.55, coloration: 1, luminosity: 0.5,
                attenuation: 0.6, saturation: 0.2, contrast: 0, shadows: 0,
                animation: { type: 'vortex', speed: 2, intensity: 4, reverse: false }
            }
        },
        items: [], effects: [], folder: null, sort: 0, ownership: { default: 0 },
        flags: { gachadnd: { creature: 'portal' } },
        _key: `!actors!${A}`
    };
}

function biography() {
    return html(
        '<p><em>Когда-то — исследователь Лабиринта. Его охватило желание поглотить как можно больше навыков; чужие воспоминания заполонили его собственные, и от перегрузки его сознание стёрлось. Осталась сущность, похожая на енота, с властью над вероятностью на уровне инстинкта — и одним инстинктом: тащить к себе всё, что блестит вероятностью. Пределом он ходит между этажами.</em></p>',
        '<h2>Запах</h2>',
        'Запах = сумма весов кристаллов в инвентарях всего отряда (серый и зелёный — 1, синий — 2, фиолетовый — 3, красный и оранжевый — 5) и +2 за каждый слот перегрузки любого персонажа. Навыки в Памяти не пахнут.',
        '<table><thead><tr><th>Запах (Э — номер этажа)</th><th>Состояние</th></tr></thead><tbody>' +
        '<tr><td>ниже 4 + 2Э</td><td>Тишина: он не видит отряд</td></tr>' +
        '<tr><td>от 4 + 2Э</td><td>Шёпот: туман пахнет металлом, кристаллы гудят, сквозь стены — «ещё…»</td></tr>' +
        '<tr><td>от 6 + 3Э</td><td>Охота: на следующем подходящем узле он прорывается</td></tr>' +
        '</tbody></table>',
        'Прорывается на узлы Монстры, Элита (третьей стороной), Событие, Привал (до отдыха). Не входит на Босса, Магазин, Риск, Погибель. Шёпот всегда за узел до Охоты.',
        '<h2>Насыщение</h2>',
        '+1 за каждое возвращение и каждое кормление. Предел — номер этажа + 1. Ниже предела он возвращается через 2 узла Охоты, на пределе — на каждом подходящем узле. Переход на следующий этаж Насыщение не сбрасывает. На листе включите эффект «Насыщение N».',
        '<h2>Свита и местность</h2>',
        'В начале встречи рядом с ним 2 Огрызка памяти и ещё по одному за каждые 2 Насыщения. На половине ПЗ — Отрыжка памяти (+2). Огрызки воруют кристаллы и несут их в Брюхо — их надо перехватывать. Логово: Разрыв ткани на счёте 20. Приманка: куча брошенных кристаллов тянет его, только если тяжелее запаса любого носителя рядом; Огрызков тянет любая.',
        '<h2>Выходы</h2>',
        '<ul><li><strong>Бой</strong> — свести к 0 ПЗ: Брюхо, Сердце аномалии, золото; Насыщение +1.</li>' +
        '<li><strong>Откуп</strong> — действием отдать кристаллы общим весом 2 + 2 × Насыщение: он уходит до конца этажа, Насыщение +1.</li>' +
        '<li><strong>Избавиться</strong> — сбить Запах ниже Шёпота (поглотить, переплавить, расщепить, продать): он теряет след, Насыщение остаётся.</li></ul>'
    );
}
