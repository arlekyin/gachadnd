/**
 * Персонажи для симулятора: экспорт актёров из Foundry (правый клик → Export Data) или типовой отряд.
 *
 * Из экспорта берутся числа, которые лежат в данных листа: характеристики, уровни классов, доспехи,
 * оружие, заклинания с ячейками, навыки Памяти (экипированные) и кристаллы в инвентаре. Активные эффекты,
 * синергии и бонусы предметов, которые dnd5e считает при загрузке мира, в экспорте не видны — их можно
 * вписать в overrides.json (КД, ПЗ, бонус к попаданию и урону).
 */

import fs from 'fs';
import path from 'path';
import { average } from './dice.mjs';

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const SCENT_WEIGHT = { gray: 1, green: 1, blue: 2, purple: 3, red: 5, orange: 5 };
// Дополнительная атака по классам: [уровень, атак за действие]
const EXTRA_ATTACK = {
    fighter: [[20, 4], [11, 3], [5, 2]],
    barbarian: [[5, 2]], paladin: [[5, 2]], ranger: [[5, 2]], monk: [[5, 2]]
};
const CASTER_ABILITY = { wizard: 'int', artificer: 'int', cleric: 'wis', druid: 'wis', ranger: 'wis', bard: 'cha', paladin: 'cha', sorcerer: 'cha', warlock: 'cha' };

const mod = score => Math.floor(((Number(score) || 10) - 10) / 2);
const profBonus = level => Math.floor((Math.max(1, level) - 1) / 4) + 2;
const classKey = item => String(item.system?.identifier || item.name || '').toLowerCase();

function activitiesOf(item) {
    return Object.values(item.system?.activities ?? {});
}

// Части урона активности: кости, тип, своя формула
function partFormula(part, crit = false) {
    if (!part) return null;
    if (part.custom?.enabled && part.custom.formula) return part.custom.formula;
    if (!part.number || !part.denomination) return part.bonus || null;
    return `${part.number}d${part.denomination}${part.bonus ? ` + ${part.bonus}` : ''}`;
}
const partType = part => [...(part?.types ?? [])][0] ?? 'force';

function hitPoints(actor, level, conMod) {
    const hp = actor.system.attributes?.hp ?? {};
    if (Number(hp.max) > 0) return Number(hp.max);
    // Максимум не задан — dnd5e считает его по классам: 1-й уровень первого класса — полная кость, дальше среднее
    let total = 0, first = true;
    for (const cls of actor.items.filter(i => i.type === 'class')) {
        const die = parseInt(String(cls.system.hd?.denomination ?? cls.system.hitDice ?? 'd8').replace('d', '')) || 8;
        for (let l = 0; l < (cls.system.levels ?? 1); l++) {
            total += first ? die : die / 2 + 1;
            first = false;
        }
    }
    const bonusLevel = Number(hp.bonuses?.level) || 0, bonusOverall = Number(hp.bonuses?.overall) || 0;
    return Math.floor(total + (conMod + bonusLevel) * level + bonusOverall) || 10;
}

function armorClass(actor, mods, data) {
    const ac = actor.system.attributes?.ac ?? {};
    const equipped = actor.items.filter(i => i.type === 'equipment' && i.system.equipped);
    const armor = equipped.find(i => ['light', 'medium', 'heavy', 'natural'].includes(i.system.type?.value));
    const shield = equipped.find(i => i.system.type?.value === 'shield');
    const shieldBonus = shield ? (Number(shield.system.armor?.value) || 2) + (Number(shield.system.armor?.magicalBonus) || 0) : 0;
    let base;
    switch (ac.calc) {
        case 'flat': return Number(ac.flat) || 10;
        case 'natural': base = Number(ac.flat) || 10; break;
        case 'mage': base = 13 + mods.dex; break;
        case 'unarmoredMonk': base = 10 + mods.dex + mods.wis; break;
        case 'unarmoredBarb': base = 10 + mods.dex + mods.con; break;
        case 'custom': base = average(ac.formula || '10', data); break;
        default: {
            if (!armor) { base = 10 + mods.dex; break; }
            const type = armor.system.type.value;
            const cap = armor.system.armor?.dex ?? (type === 'heavy' ? 0 : type === 'medium' ? 2 : null);
            base = (Number(armor.system.armor?.value) || 10) + (Number(armor.system.armor?.magicalBonus) || 0) + (cap === null ? mods.dex : Math.min(cap, mods.dex));
        }
    }
    return Math.round(base + shieldBonus + (Number(average(ac.bonus || '0', data)) || 0));
}

/** Персонаж из экспорта Foundry → модель для боя */
export function loadActor(actor, overrides = {}) {
    const classes = actor.items.filter(i => i.type === 'class');
    const level = classes.reduce((sum, c) => sum + (Number(c.system.levels) || 0), 0) || Number(actor.system.details?.level) || 1;
    const prof = profBonus(level);
    const mods = Object.fromEntries(ABILITIES.map(a => [a, mod(actor.system.abilities?.[a]?.value)]));
    const data = {
        prof, details: { level }, attributes: { prof },
        abilities: Object.fromEntries(ABILITIES.map(a => [a, { mod: mods[a], value: actor.system.abilities?.[a]?.value ?? 10 }])),
        classes: Object.fromEntries(classes.map(c => [classKey(c), { levels: c.system.levels }]))
    };
    const saves = Object.fromEntries(ABILITIES.map(a => [a, mods[a] + (actor.system.abilities?.[a]?.proficient ? prof : 0)]));
    const classLevel = key => classes.filter(c => classKey(c).includes(key)).reduce((s, c) => s + (c.system.levels ?? 0), 0);
    const attacksPerAction = Math.max(1, ...Object.entries(EXTRA_ATTACK).map(([key, steps]) => {
        const l = classLevel(key);
        return steps.find(([need]) => l >= need)?.[1] ?? 1;
    }));
    const rogue = classLevel('rogue');
    const casterClass = classes.find(c => CASTER_ABILITY[classKey(c)]);
    const spellAbility = actor.system.attributes?.spellcasting || CASTER_ABILITY[casterClass ? classKey(casterClass) : ''] || 'int';
    const spellMod = mods[spellAbility] ?? 0;
    const cantripTier = 1 + (level >= 5) + (level >= 11) + (level >= 17);
    const extra = { hit: Number(overrides.hit) || 0, damage: Number(overrides.damage) || 0 };

    const options = [];
    const heals = [];
    const addActivity = (item, activity, { kind, resource, toHit, abilityMod, dc, cantrip = false, attacks = 1, sneak = false }) => {
        const scale = formula => cantrip && formula ? `(${formula}) * ${cantripTier}` : formula;
        const parts = (activity.damage?.parts ?? []).map(p => ({ formula: scale(partFormula(p)), type: partType(p) })).filter(p => p.formula);
        if (activity.type === 'heal') {
            const formula = partFormula(activity.healing);
            if (formula) heals.push({ name: item.name, formula, data: { ...data, mod: abilityMod }, resource, bonus: activity.activation?.type === 'bonus' });
            return;
        }
        if (kind === 'weapon') {
            const base = item.system.damage?.base;
            if (activity.damage?.includeBase !== false && base) {
                const formula = partFormula(base);
                if (formula) parts.unshift({ formula: `${formula} + ${abilityMod} + ${Number(item.system.magicalBonus) || 0}`, type: partType(base) });
            }
        }
        if (!parts.length) return;
        parts.forEach(p => { p.formula = `${p.formula} + ${extra.damage}`; });
        const type = activity.type === 'attack' ? 'attack' : activity.type === 'save' ? 'save' : 'auto';
        options.push({
            name: activity.name && activity.name !== item.name ? `${item.name}: ${activity.name}` : item.name,
            type, parts, data: { ...data, mod: abilityMod },
            toHit: (toHit ?? 0) + extra.hit, dc, save: activity.save?.ability ? [...activity.save.ability][0] ?? activity.save.ability : null,
            onSave: activity.damage?.onSave ?? 'half', attacks, sneak, resource,
            bonus: activity.activation?.type === 'bonus'
        });
    };

    for (const item of actor.items) {
        const flags = item.flags?.gachadnd ?? {};
        if (item.type === 'weapon' && item.system.equipped !== false) {
            const finesse = [...(item.system.properties ?? [])].includes('fin');
            const ranged = /R$/.test(item.system.type?.value ?? '') || item.system.range?.long > 0;
            for (const activity of activitiesOf(item).filter(a => a.type === 'attack')) {
                const ability = activity.attack?.ability || (finesse ? (mods.dex > mods.str ? 'dex' : 'str') : ranged ? 'dex' : 'str');
                const abilityMod = mods[ability] ?? 0;
                const toHit = abilityMod + (item.system.proficient === 0 ? 0 : prof) + (Number(item.system.magicalBonus) || 0) + (Number(average(activity.attack?.bonus || '0', data)) || 0);
                addActivity(item, activity, { kind: 'weapon', toHit, abilityMod, attacks: attacksPerAction, sneak: rogue > 0 && (finesse || ranged) });
            }
        } else if (item.type === 'spell') {
            const prep = item.system.preparation ?? {};
            if (prep.mode === 'prepared' && prep.prepared === false && item.system.level > 0) continue;
            const level = Number(item.system.level) || 0;
            const resource = level ? { slot: level } : null;
            for (const activity of activitiesOf(item)) {
                addActivity(item, activity, {
                    kind: 'spell', resource, cantrip: level === 0, abilityMod: spellMod,
                    toHit: spellMod + prof, dc: 8 + prof + spellMod
                });
            }
        } else if (item.type === 'feat' && (flags.is_active || (!flags.skill_name && Number(average(item.system.uses?.max || '0', data)) > 0))) {
            // Навыки Памяти — только экипированные; особенности класса — с зарядами
            if (flags.is_crystal_item || flags.is_synergy_item) continue;
            const uses = Math.max(0, Math.floor(Number(average(item.system.uses?.max || '0', data)) || 0));
            const resource = uses ? { uses: item.name, max: uses } : null;
            for (const activity of activitiesOf(item)) {
                const ability = activity.attack?.ability || activity.save?.dc?.calculation || spellAbility;
                const abilityMod = mods[ability] ?? spellMod;
                const dcFormula = activity.save?.dc?.formula;
                const dc = dcFormula ? Math.round(average(dcFormula.replace(/@flags\.gachadnd\.dc_bonus/g, '0'), data)) : 8 + prof + Math.max(mods.str, mods.dex, mods.con, mods.int, mods.wis, mods.cha);
                addActivity(item, activity, { kind: 'feat', resource, toHit: abilityMod + prof, abilityMod, dc });
            }
        }
    }

    // Безоружный удар — если больше нечем бить
    if (!options.some(o => !o.resource && !o.bonus)) {
        options.push({ name: 'Безоружный удар', type: 'attack', parts: [{ formula: `1 + ${mods.str}`, type: 'bludgeoning' }], data, toHit: mods.str + prof, attacks: attacksPerAction, resource: null });
    }

    const slots = {};
    for (let n = 1; n <= 9; n++) {
        const s = actor.system.spells?.[`spell${n}`];
        const count = Number(s?.override ?? s?.max ?? s?.value) || 0;
        if (count) slots[n] = count;
    }
    const pact = actor.system.spells?.pact;
    if (Number(pact?.max ?? pact?.value) > 0 && pact?.level) slots[pact.level] = (slots[pact.level] ?? 0) + Number(pact.max ?? pact.value);

    const crystals = overrides.crystals ?? actor.items
        .filter(i => i.flags?.gachadnd?.is_crystal_item || /^Кристалл:/.test(i.name))
        .flatMap(i => Array(Math.max(1, Number(i.system?.quantity) || 1)).fill(SCENT_WEIGHT[i.flags?.gachadnd?.rarity] ?? 1));

    return {
        name: actor.name, level, prof, mods, saves,
        ac: Number(overrides.ac) || armorClass(actor, mods, data),
        hp: Number(overrides.hp) || hitPoints(actor, level, mods.con),
        init: mods.dex, options, heals, slots, crystals,
        sneak: rogue ? `${Math.ceil(rogue / 2)}d6` : null
    };
}

/**
 * Типовой персонаж уровня: средние числа по классу, когда экспорта нет.
 * Боец — оружие и доп. атаки, плут — скрытая атака, жрец — заговор и лечение, волшебник — огненные заклинания.
 */
function typical(role, level) {
    const prof = profBonus(level);
    const main = level >= 8 ? 5 : level >= 4 ? 4 : 3;
    const tier = 1 + (level >= 5) + (level >= 11) + (level >= 17);
    const conMod = role === 'fighter' ? 3 : 2;
    const die = { fighter: 10, rogue: 8, cleric: 8, wizard: 6 }[role];
    const hp = die + (level - 1) * (die / 2 + 1) + conMod * level;
    const slots = role === 'cleric' || role === 'wizard'
        ? Object.fromEntries([[1, Math.min(4, level + 1)], [2, level >= 3 ? (level >= 4 ? 3 : 2) : 0], [3, level >= 5 ? (level >= 6 ? 3 : 2) : 0], [4, level >= 7 ? Math.min(3, level - 6) : 0], [5, level >= 9 ? (level >= 10 ? 2 : 1) : 0]].filter(([, c]) => c))
        : {};
    const data = { prof, details: { level } };
    const weapon = (name, formula, type, toHit, attacks, sneak = false) => ({ name, type: 'attack', parts: [{ formula, type }], data, toHit, attacks, sneak, resource: null });
    const spell = (name, level, kind, formula, type, extra = {}) => ({ name, type: kind, parts: [{ formula, type }], data, toHit: main + prof, dc: 8 + prof + main, save: extra.save ?? 'dex', onSave: 'half', attacks: 1, resource: level ? { slot: level } : null, ...extra });
    const base = {
        level, prof, init: role === 'rogue' ? main : 2, slots, heals: [], crystals: [1, 1, 2],
        saves: { str: 1, dex: 2, con: 2, int: 0, wis: 1, cha: 0 }
    };
    if (role === 'fighter') return {
        ...base, name: `Боец ${level}`, ac: 18, hp, sneak: null, saves: { ...base.saves, str: main + prof, con: conMod + prof },
        options: [weapon('Длинный меч', `1d8 + ${main + (level >= 1 ? 2 : 0)}`, 'slashing', main + prof, level >= 20 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1)]
    };
    if (role === 'rogue') return {
        ...base, name: `Плут ${level}`, ac: 15, hp, sneak: `${Math.ceil(level / 2)}d6`, saves: { ...base.saves, dex: main + prof },
        options: [weapon('Рапира', `1d8 + ${main}`, 'piercing', main + prof, 1, true)]
    };
    if (role === 'cleric') return {
        ...base, name: `Жрец ${level}`, ac: 18, hp, sneak: null, saves: { ...base.saves, wis: main + prof, cha: prof },
        heals: [{ name: 'Лечащее слово', formula: `${Math.ceil(level / 4) + 1}d4 + ${main}`, data, resource: { slot: 1 }, bonus: true }],
        options: [
            spell('Священное пламя', 0, 'save', `${tier}d8`, 'radiant', { save: 'dex', onSave: 'none' }),
            spell('Направляющий снаряд', 1, 'attack', '4d6', 'radiant'),
            ...(level >= 5 ? [spell('Духовные стражи', 3, 'save', '3d8', 'radiant', { save: 'wis' })] : [])
        ]
    };
    return {
        ...base, name: `Волшебник ${level}`, ac: 13, hp, sneak: null, saves: { ...base.saves, int: main + prof, wis: 1 + prof },
        options: [
            spell('Огненный снаряд', 0, 'attack', `${tier}d10`, 'fire'),
            spell('Волшебная стрела', 1, 'auto', '3d4 + 3', 'force'),
            spell('Палящий луч', 2, 'attack', '6d6', 'fire'),
            ...(level >= 5 ? [spell('Огненный шар', 3, 'save', '8d6', 'fire')] : []),
            ...(level >= 9 ? [spell('Конус холода', 5, 'save', '8d8', 'cold', { save: 'con' })] : [])
        ]
    };
}

export function typicalParty(level) {
    return ['fighter', 'rogue', 'cleric', 'wizard'].map(role => typical(role, level));
}

/** Отряд из папки: *.json — экспорт актёров, overrides.json — поправки по имени персонажа */
export function loadParty(dir) {
    if (!fs.existsSync(dir)) return [];
    const overridesPath = path.join(dir, 'overrides.json');
    const overrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, 'utf8')) : {};
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') && f !== 'overrides.json')
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
        .filter(a => a?.type === 'character' && Array.isArray(a.items))
        .map(a => loadActor(a, overrides[a.name] ?? {}));
}
