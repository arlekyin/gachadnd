/**
 * Сборка бестиария: существа Лабиринта → dist/packs/gacha-bestiary/*.json (актёры dnd5e с атаками,
 * особенностями и эффектами). Существа описаны здесь же кодом: у актёра много вложенных документов,
 * и общий шаблон активностей короче YAML.
 *
 * Пожиратель — аномалия, бывший исследователь Лабиринта. Числа рассчитаны на второй этаж
 * (мини-босс, ПО 4); рост от возвращений — эффекты «Насыщение N» на актёре: Мастер включает один.
 * Формулы атак и Сл читают @flags.gachadnd.satiety — его задаёт включённый эффект.
 * Иконки — только из модуля и подтверждённые пути ядра Foundry: неверный путь дал бы пустую картинку.
 */

import fs from 'fs';
import path from 'path';

const IMG = 'modules/gachadnd/assets/icons/skills/purple_fog_active.webp';
const SATIETY = '@flags.gachadnd.satiety';
const DC = `13 + ${SATIETY}`;

/**
 * @param {{ distDir: string, stableId: (...parts: string[]) => string }} options
 * @returns {string[]}  Имена собранных существ.
 */
export function buildBestiary({ distDir, stableId }) {
    const out = path.join(distDir, 'gacha-bestiary');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const actors = [devourer(stableId)];
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

function devourer(stableId) {
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
        natural(A, id('bite'), 'Укус-пожирание', 'icons/skills/wounds/bone-broken-tooth-fang-red.webp', html(
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
        feat(A, id('echo'), 'Эхо чужих навыков', 'modules/gachadnd/assets/icons/skills/purple_fog_active.webp', html(
            'Бонусным действием в начале каждого своего хода Пожиратель бросает 1к6 — отголосок навыков, которые он когда-то носил. С Насыщения 2 он бросает дважды и выбирает.',
            '<ol>' +
            '<li><strong>Обратный сдвиг.</strong> До его следующего хода атаки по нему совершаются с помехой.</li>' +
            '<li><strong>Кража удачи.</strong> Одно существо в пределах 30 футов совершает следующий бросок к20 дважды и берёт худший.</li>' +
            '<li><strong>Шаг тумана.</strong> Телепортируется на расстояние до 30 футов к носителю самого большого запаса кристаллов.</li>' +
            '<li><strong>Чужая ярость.</strong> Следующая атака этого хода наносит дополнительно 2к6 урона силовым полем (кнопка ниже).</li>' +
            '<li><strong>Выплюнутый навык.</strong> Конус 15 футов: спасбросок Ловкости (Сл 13 + Насыщение), 3к6 урона случайного типа — к4: огонь, холод, яд, некротическая энергия; при успехе половина (кнопка ниже).</li>' +
            '<li><strong>Джекпот.</strong> Бросьте Эхо ещё дважды: действуют оба эффекта.</li>' +
            '</ol>'
        ), [
            activity(id('echo', 'roll'), 'utility', 'Эхо', { activation: 'bonus', roll: { formula: '1d6', name: 'Эхо чужих навыков', prompt: false, visible: true } }),
            activity(id('echo', 'fury'), 'damage', 'Чужая ярость', {
                activation: 'special',
                damage: { critical: { allow: true, bonus: '' }, parts: [part(2, 6, ['force'])] }
            }),
            activity(id('echo', 'spit'), 'save', 'Выплюнутый навык', {
                activation: 'special',
                target: {
                    template: { count: '1', contiguous: false, type: 'cone', size: '15', width: '', height: '', units: 'ft' },
                    affects: { count: '', type: '', choice: false, special: '' }, prompt: true, override: false
                },
                save: { ability: ['dex'], dc: { calculation: '', formula: DC } },
                damage: { onSave: 'half', parts: [part(3, 6, ['fire', 'cold', 'poison', 'necrotic'])] }
            })
        ]),
        feat(A, id('reroll'), 'Перекрутка', 'modules/gachadnd/assets/icons/skills/blue_fog_active.webp', html(
            'Реакция, 1 раз в раунд. Когда существо в пределах 60 футов, которое Пожиратель видит, попадает по нему атакой или преуспевает в спасброске против его эффекта, бросок перебрасывается. Существо обязано взять новый результат.'
        ), [activity(id('reroll', 'use'), 'utility', 'Перекрутка', { activation: 'reaction', range: 60, roll: { formula: '', name: '', prompt: false, visible: false } })]),
        feat(A, id('legres'), 'Легендарное сопротивление (Насыщение 2+)', 'modules/gachadnd/assets/icons/skills/purple_fog_crystall.webp', html(
            'С Насыщения 2: один раз за встречу, проваливая спасбросок, Пожиратель может считать его успешным.',
            'Эффект Насыщения 2 и выше добавляет 1 к максимуму легендарных сопротивлений; перед встречей поставьте текущее значение равным максимуму.'
        )),
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
            (n >= 2 ? ', легендарное сопротивление 1, Эхо — два броска на выбор' : '') +
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
                hp: { value: 68, max: 68, temp: 0, tempmax: 0, formula: '8d8 + 32' },
                movement: { walk: 40, climb: 30, burrow: 0, fly: 0, swim: 0, units: 'ft', hover: false },
                senses: { darkvision: 0, blindsight: 30, tremorsense: 0, truesight: 0, units: 'ft', special: '' }
            },
            details: {
                biography: { value: biography(), public: '' },
                alignment: 'Хаотично-нейтральный',
                type: { value: 'aberration', subtype: 'аномалия', swarm: '', custom: '' },
                cr: 4, environment: 'Лабиринт Тумана'
            },
            traits: {
                size: 'med',
                ci: { value: ['charmed', 'frightened'], custom: '' },
                languages: { value: [], custom: 'понимает языки, которые знал, но говорит только «ещё»' }
            },
            resources: { legact: { value: 0, max: 0 }, legres: { value: 0, max: 0 }, lair: { value: false, initiative: null } },
            source: { custom: 'Gacha Roguelike', book: '', page: '', license: '', rules: '2024', revision: 1 }
        },
        prototypeToken: {
            name: 'Пожиратель', displayName: 20, actorLink: true, disposition: -1, displayBars: 40,
            bar1: { attribute: 'attributes.hp' }, width: 1, height: 1,
            texture: { src: IMG, scaleX: 1, scaleY: 1 },
            sight: { enabled: false }
        },
        items,
        effects,
        folder: null, sort: 0, ownership: { default: 0 },
        flags: { gachadnd: { satiety: 0, creature: 'devourer' } },
        _key: `!actors!${A}`
    };
}

function biography() {
    return html(
        '<p><em>Когда-то — исследователь Лабиринта. Он держал в голове столько навыков, что потерял себя. Осталась власть над вероятностью на уровне инстинкта — и один инстинкт: найти больше кристаллов.</em></p>',
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
        '<h2>Выходы</h2>',
        '<ul><li><strong>Бой</strong> — свести к 0 ПЗ: Брюхо, Сердце аномалии, золото; Насыщение +1.</li>' +
        '<li><strong>Откуп</strong> — действием отдать кристаллы общим весом 2 + 2 × Насыщение: он уходит до конца этажа, Насыщение +1.</li>' +
        '<li><strong>Избавиться</strong> — сбить Запах ниже Шёпота (поглотить, переплавить, расщепить, продать): он теряет след, Насыщение остаётся.</li></ul>'
    );
}
