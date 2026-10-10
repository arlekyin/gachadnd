#!/usr/bin/env node
/**
 * Симулятор боя отряда с Пожирателем: Монте-Карло, только числа — без позиционирования и тактики.
 *
 *   node tools/sim/devourer.mjs                     отряд из tools/sim/party/*.json, все Глубины и Насыщения
 *   node tools/sim/devourer.mjs --level 5           типовой отряд 5 уровня (если папка пуста)
 *   node tools/sim/devourer.mjs --depth 3 --satiety 1 --runs 5000
 *   node tools/sim/devourer.mjs --depth 3 --log     один бой по ходам
 *
 * Профиль Пожирателя — из tools/bestiary.mjs (тот же, что на листе актёра). Модель и упрощения — в README.md.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rollFormula, average, rollD20, hitChance, failChance } from './dice.mjs';
import { loadParty, typicalParty } from './party.mjs';
import { DEVOURER, DEPTHS, RANK_DEPTH } from '../bestiary.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_ROUNDS = 15;

// ==========================================
// АРГУМЕНТЫ
// ==========================================

function parseArgs(argv) {
    const args = { runs: 2000, log: false };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^--/, '');
        if (key === 'log') args.log = true;
        else args[key] = Number(argv[++i]);
    }
    return args;
}

// ==========================================
// ПОЖИРАТЕЛЬ НА ГЛУБИНЕ И НАСЫЩЕНИИ
// ==========================================

const modOf = score => Math.floor((score - 10) / 2);

function devourerProfile(depth, satiety) {
    const d = DEPTHS[depth] ?? DEPTHS[2];
    const mods = Object.fromEntries(Object.entries(DEVOURER.abilities).map(([k, v]) => [k, modOf(v)]));
    const saves = Object.fromEntries(Object.keys(mods).map(k => [k, mods[k] + (DEVOURER.saves.includes(k) ? DEVOURER.prof : 0)]));
    const hp = DEVOURER.hp + d.hp + (satiety ? DEVOURER.satietyHp(satiety) : 0);
    return {
        depth, satiety, hp, ac: DEVOURER.ac + d.ac, saves,
        hit: mods.str + DEVOURER.prof + satiety + d.hit,
        dc: DEVOURER.dc + satiety + d.hit,
        damage: mods.str + d.damage,
        attacks: depth >= 5 ? 3 : 2,
        legact: DEVOURER.legact + d.legact,
        legres: DEVOURER.legres + d.legres + (satiety >= 2 ? 1 : 0),
        memoryDie: depth >= 7 ? 10 : depth >= 4 ? 8 : 6,
        rank: depth >= RANK_DEPTH[3] ? 3 : depth >= RANK_DEPTH[2] ? 2 : 1,
        memoryRolls: satiety >= 2 ? 2 : 1,
        swallow: satiety >= 3 ? 2 : 1,
        bellyLimit: 3 + satiety,
        scraps: 2 + Math.floor(satiety / 2),
        burp: depth >= 8 ? 4 : 2,
        lairTimes: depth >= 9 ? 2 : 1,
        deepAdapt: depth >= 6,
        lastLayer: depth >= 10
    };
}

// ==========================================
// БОЙ
// ==========================================

const pick = (list, rng) => list[Math.floor(rng() * list.length)];
const alive = pcs => pcs.filter(p => p.hp > 0);
const sum = list => list.reduce((a, b) => a + b, 0);
const carried = pc => sum(pc.crystals);

class Fight {
    constructor(party, profile, { rng = Math.random, log = null } = {}) {
        this.rng = rng;
        this.log = log;
        this.p = profile;
        this.pcs = party.map(pc => ({
            ...pc, maxHp: pc.hp, hp: pc.hp, crystals: [...pc.crystals], slots: { ...pc.slots }, uses: {},
            triggers: pc.triggers ?? [], resist: new Set(pc.resist ?? []), vulnerable: new Set(pc.vulnerable ?? []),
            triggerUses: {}, reaction: true, advantage: false,
            frightened: false, lostTurn: false, disadvantage: false
        }));
        const dv = this.dv = {
            hp: profile.hp, max: profile.hp, temp: 0, layers: 3, broken: 0, floor: 0, layerDamage: {},
            resist: new Set(), immune: new Set(), legres: profile.legres, belly: [], lastUsed: false, reaction: true, warudo: false
        };
        dv.layerSize = dv.max / 3;
        this.scraps = Array.from({ length: profile.scraps }, () => this.#scrap());
        this.stats = { round: 0, layersBroken: 0, swallowed: 0, downs: 0, devourerDamage: 0, partyDamage: 0 };
    }

    #scrap() {
        return { hp: 9, ac: 12, carrying: null, owner: null };
    }

    say(text) {
        this.log?.push(`  ${text}`);
    }

    // ---------- Урон по Пожирателю: временные ПЗ, сопротивления, слои памяти ----------
    hurtDevourer(amount, type) {
        const dv = this.dv;
        if (dv.immune.has(type)) return 0;
        if (dv.resist.has(type)) amount = Math.floor(amount / 2);
        if (dv.temp) {
            const absorbed = Math.min(dv.temp, amount);
            dv.temp -= absorbed;
            amount -= absorbed;
        }
        const before = dv.hp;
        dv.hp = Math.max(dv.floor, dv.hp - amount);
        const dealt = before - dv.hp;
        dv.layerDamage[type] = (dv.layerDamage[type] ?? 0) + dealt;
        this.stats.partyDamage += dealt;
        if (dv.hp <= dv.floor && dealt > 0 && before > dv.floor) this.#breakLayer();
        return dealt;
    }

    #breakLayer() {
        const dv = this.dv;
        dv.broken += 1;
        this.stats.layersBroken += 1;
        if (dv.hp <= 0) {
            if (this.p.lastLayer && !dv.lastUsed) {
                dv.lastUsed = true;
                dv.hp = Math.floor(dv.max / 2);
                dv.floor = 0;
                dv.resist.clear(); dv.immune.clear();
                this.say('Последний слой: Пожиратель встаёт с половиной ПЗ');
            }
            return;
        }
        // Адаптация: сопротивление к самому сильному типу урона по этому слою (на Глубине 6+ — к двум)
        const top = Object.entries(dv.layerDamage).sort((a, b) => b[1] - a[1]).slice(0, this.p.deepAdapt ? 2 : 1).map(([t]) => t);
        for (const type of top) {
            if (dv.resist.has(type)) dv.immune.add(type);
            else dv.resist.add(type);
        }
        dv.layerDamage = {};
        if (dv.broken === 1) {
            for (let i = 0; i < this.p.burp; i++) this.scraps.push(this.#scrap());
            this.say(`Слой памяти рухнул (${top.join(', ')}), Отрыжка: +${this.p.burp} Огрызка`);
        } else this.say(`Слой памяти рухнул (${top.join(', ')})`);
    }

    // В начале его хода граница раунда: рухнуть может только следующий слой
    #setFloor() {
        const dv = this.dv;
        const below = Math.floor((dv.hp - 1) / dv.layerSize);
        dv.floor = Math.max(0, Math.round(below * dv.layerSize));
        if (dv.lastUsed) dv.floor = 0;
    }

    // ---------- Урон по персонажу ----------
    hurtPc(pc, amount, type = null) {
        if (pc.hp <= 0 || amount <= 0) return;
        if (type && pc.resist.has(type)) amount = Math.floor(amount / 2);
        if (type && pc.vulnerable.has(type)) amount *= 2;
        // Реакция на урон (Кровавый щит, Уно-реверс): одна за раунд, тратит заряд
        const reaction = pc.reaction && this.#ready(pc, 'damaged').find(t => t.trigger.reduce);
        if (reaction) {
            pc.reaction = false;
            this.#spendTrigger(pc, reaction);
            const { reduce } = reaction.trigger;
            const back = reduce.half ? Math.floor(amount / 2) : Math.min(amount, Math.round(rollFormula(reduce.formula ?? reaction.fromRoll ?? '0', pc.data ?? {}, { rng: this.rng })));
            amount -= back;
            if (reduce.half) this.hurtDevourer(back, type ?? 'force');
            this.say(`${pc.name}: ${reaction.name} — урон меньше на ${back}`);
        }
        pc.hp -= amount;
        this.stats.devourerDamage += amount;
        if (pc.hp > 0) return;
        // Кровавый пакт: вместо 0 ПЗ — 1 ПЗ и лечение, враги рядом получают столько же
        const pact = this.#ready(pc, 'zero_hp')[0];
        if (pact) {
            this.#spendTrigger(pc, pact);
            const healed = Math.round(rollFormula(pact.trigger.revive.formula, pc.data ?? {}, { rng: this.rng }));
            pc.hp = Math.min(pc.maxHp, 1 + healed);
            const burst = pact.trigger.burst;
            if (burst) {
                const saved = rollD20(0, this.rng) + (this.p.saves[burst.save] ?? 0) >= pc.universalDc;
                this.hurtDevourer(saved ? Math.floor(healed / 2) : healed, burst.type);
            }
            this.say(`${pc.name}: ${pact.name} — остаётся с ${pc.hp} ПЗ`);
            return;
        }
        pc.hp = 0;
        this.stats.downs += 1;
        this.say(`${pc.name} падает`);
    }

    // ---------- Срабатывания навыков и синергий ----------
    #ready(pc, on) {
        return pc.triggers.filter(t => t.trigger.on === on && (t.uses === null || (pc.triggerUses[t.name] ?? t.uses) > 0));
    }

    #spendTrigger(pc, t) {
        if (t.uses !== null) pc.triggerUses[t.name] = (pc.triggerUses[t.name] ?? t.uses) - 1;
    }

    #condition(pc, when, option) {
        const dv = this.dv;
        return {
            self_wounded: pc.hp < pc.maxHp, self_bloodied: pc.hp <= pc.maxHp / 2,
            target_bloodied: dv.hp <= dv.max / 2, hostile_target: true,
            target_anomaly: true, attack_only: option?.type === 'attack'
        }[when] ?? false;
    }

    // Доп. урон и лечение после урона: по умолчанию 1 раз в ход
    #onDamageDealt(pc, option) {
        for (const t of this.#ready(pc, 'damage_roll')) {
            const { when = [], once = 'turn', bonus, heal_self } = t.trigger;
            if (once !== 'none' && pc.turnFired?.has(t.name)) continue;
            if (!when.every(w => this.#condition(pc, w, option))) continue;
            pc.turnFired ??= new Set();
            pc.turnFired.add(t.name);
            this.#spendTrigger(pc, t);
            if (bonus) {
                const formula = bonus.from === 'damage' ? t.fromDamage?.formula : bonus.from === 'roll' ? t.fromRoll : bonus.formula;
                const type = bonus.from === 'damage' ? t.fromDamage?.type : bonus.type;
                if (!formula) continue;
                const twice = bonus.double_when && this.#condition(pc, bonus.double_when, option) ? 2 : 1;
                const dealt = this.hurtDevourer(Math.round(rollFormula(formula, pc.data ?? {}, { rng: this.rng })) * twice, type ?? 'force');
                this.say(`${pc.name}: ${t.name} +${dealt}`);
            }
            if (heal_self) pc.hp = Math.min(pc.maxHp, pc.hp + Math.round(rollFormula(heal_self.formula, pc.data ?? {}, { rng: this.rng })));
        }
    }

    // Начало хода и боя: плата уроном за преимущество (Проклятье I)
    #onTurnStart(pc, on) {
        for (const t of this.#ready(pc, on)) {
            const { pay, advantage } = t.trigger;
            if (!pay || pc.hp <= pc.maxHp / 2) continue;
            pc.hp = Math.max(1, pc.hp - Math.round(rollFormula(pay.formula, pc.data ?? {}, { rng: this.rng })));
            if (advantage === 'attacks') pc.advantage = true;
        }
    }

    pcSave(pc, ability, edge = 0) {
        return rollD20(edge, this.rng) + (pc.saves[ability] ?? 0) >= this.p.dc;
    }

    // ---------- Ход Пожирателя ----------
    devourerTurn() {
        const { p, dv, rng } = this;
        this.#setFloor();
        dv.reaction = true;
        dv.warudo = false;
        for (const pc of this.pcs) pc.reaction = true;
        if (sum(dv.belly) >= p.bellyLimit) return 'left';
        const targets = alive(this.pcs);
        if (!targets.length) return null;
        // Нюх: самый большой запас кристаллов, при равенстве — самый раненый
        const scent = () => alive(this.pcs).sort((a, b) => carried(b) - carried(a) || a.hp - b.hp)[0];

        // Кость Памяти: с Насыщения 2 — два броска, лучший по ценности
        const faces = Array.from({ length: p.memoryRolls }, () => 1 + Math.floor(rng() * p.memoryDie));
        const face = faces.sort((a, b) => this.#faceValue(b) - this.#faceValue(a))[0];
        let advantageAll = false;
        let usedAction = false;
        const rank = p.rank;
        const save = (pc, ability) => this.pcSave(pc, ability);
        const area = (count, formula, ability, label, type) => {
            const hit = alive(this.pcs).sort(() => rng() - 0.5).slice(0, count);
            for (const pc of hit) {
                const dmg = rollFormula(formula, {}, { rng });
                this.hurtPc(pc, save(pc, ability) ? Math.floor(dmg / 2) : dmg, type);
            }
            this.say(`Память ${face}: ${label} по ${hit.map(x => x.name).join(', ')}`);
            usedAction = true;
        };
        const strongest = () => alive(this.pcs).sort((a, b) => this.#pcValue(b) - this.#pcValue(a))[0];
        switch (face) {
            case 1: dv.temp = Math.max(dv.temp, 5 + rank * DEVOURER.prof); this.say(`Память 1: Квен, ${dv.temp} временных ПЗ`); break;
            case 2: { const t = scent(); if (!save(t, 'str')) { advantageAll = true; this.say(`Память 2: Удалой рывок, ${t.name} сбит с ног`); } break; }
            case 3: { const t = strongest(); if (!save(t, 'wis')) { t.frightened = true; this.say(`Память 3: Хайзенберг, ${t.name} испуган`); } break; }
            case 4: if (this.#multiattackValue() < 2 * average(rank >= 2 ? '3d6' : '2d6')) area(rank >= 3 ? 3 : 2, rank >= 2 ? '3d6' : '2d6', 'dex', 'Игни', 'fire'); break;
            case 5: { const t = strongest(); if (!save(t, 'wis')) { t.disadvantage = true; this.say(`Память 5: Нейрализатор, ${t.name} с помехой`); } usedAction = true; break; }
            case 6: area(2, `${DEVOURER.prof + 1}d8`, 'str', 'Фус-Ро-Да', 'thunder'); break;
            case 7: area(3, '8d6', 'dex', 'Мегумин', 'fire'); break;
            case 8: { const t = strongest(); if (!save(t, 'wis')) { t.lostTurn = true; this.say(`Память 8: Кукловод, ${t.name} теряет ход`); } usedAction = true; break; }
            case 9: dv.warudo = true; this.say('Память 9: ЗА ВАРУДО наготове'); break;
            case 10: area(2, '10d10', 'dex', 'Ещё один потомок Вергилия', 'force'); break;
        }
        if (!usedAction) this.#multiattack(scent, advantageAll);
        this.#scrapsTurn();
        return null;
    }

    #pcValue(pc) {
        return Math.max(0, ...pc.options.filter(o => this.#available(pc, o)).map(o => this.#expected(pc, o)));
    }

    #multiattackValue() {
        const p = this.p;
        return average(`${DEVOURER.claw[0]}d${DEVOURER.claw[1]}`) * (p.attacks - 1) + average(`${DEVOURER.bite[0]}d${DEVOURER.bite[1]}`) + p.damage * p.attacks;
    }

    // Ценность грани для выбора из двух бросков: урон или выключенный из боя персонаж
    #faceValue(face) {
        const best = alive(this.pcs).reduce((m, pc) => Math.max(m, this.#pcValue(pc)), 0);
        return { 1: 8, 2: 6, 3: best * 0.4, 4: 14, 5: best * 0.5, 6: 2 * average(`${DEVOURER.prof + 1}d8`), 7: 3 * 28 * 0.75, 8: best, 9: best * 0.8, 10: 2 * 55 * 0.75 }[face] ?? 0;
    }

    #attack(target, weapon, edge) {
        const p = this.p;
        const roll = rollD20(edge, this.rng);
        if (roll !== 20 && (roll === 1 || roll + p.hit < target.ac)) return false;
        const [n, die] = weapon;
        const dmg = rollFormula(`${n}d${die}`, {}, { rng: this.rng, crit: roll === 20 }) + p.damage;
        this.hurtPc(target, dmg, weapon[2]);
        return true;
    }

    #bite(target, edge) {
        if (!this.#attack(target, DEVOURER.bite, edge)) return;
        if (!target.crystals.length || this.pcSave(target, 'dex')) return;
        for (let i = 0; i < this.p.swallow && target.crystals.length; i++) {
            const at = Math.floor(this.rng() * target.crystals.length);
            const [weight] = target.crystals.splice(at, 1);
            this.dv.belly.push(weight);
            this.stats.swallowed += weight;
        }
        this.say(`Укус: Брюхо ${sum(this.dv.belly)} / ${this.p.bellyLimit}`);
    }

    #multiattack(scent, advantageAll) {
        let bit = false;
        for (let i = 0; i < this.p.attacks; i++) {
            const target = scent();
            if (!target) return;
            const edge = 1; // Нюх: преимущество по носителю самого большого запаса
            if (!bit && carried(target) > 0 && i === this.p.attacks - 1) { this.#bite(target, edge); bit = true; }
            else this.#attack(target, DEVOURER.claw, advantageAll ? 1 : edge);
        }
    }

    legendary() {
        const target = alive(this.pcs).sort((a, b) => carried(b) - carried(a) || a.hp - b.hp)[0];
        if (target) this.#attack(target, DEVOURER.claw, 1);
    }

    lair() {
        for (let i = 0; i < this.p.lairTimes; i++) {
            if (1 + Math.floor(this.rng() * 4) !== 3) continue;
            // Кристаллы гудят: носители веса 3+ — спасбросок Мудрости, 3к6 психической энергией
            for (const pc of alive(this.pcs).filter(pc => carried(pc) >= 3)) {
                const dmg = rollFormula('3d6', {}, { rng: this.rng });
                this.hurtPc(pc, this.pcSave(pc, 'wis') ? Math.floor(dmg / 2) : dmg, 'psychic');
            }
            this.say('Логово: Кристаллы гудят');
        }
    }

    // Огрызки: выхватывают кристалл у носителя (Ловкость Сл 12) и несут в Брюхо следующим ходом
    #scrapsTurn() {
        for (const scrap of this.scraps.filter(s => s.hp > 0)) {
            if (scrap.carrying !== null) {
                this.dv.belly.push(scrap.carrying);
                this.stats.swallowed += scrap.carrying;
                scrap.carrying = null;
                continue;
            }
            const target = alive(this.pcs).filter(pc => pc.crystals.length).sort((a, b) => carried(b) - carried(a))[0];
            if (target) {
                if (rollD20(0, this.rng) + (target.saves.dex ?? 0) < 12) {
                    const at = Math.floor(this.rng() * target.crystals.length);
                    scrap.carrying = target.crystals.splice(at, 1)[0];
                    scrap.owner = target;
                }
            } else {
                const victim = pick(alive(this.pcs), this.rng);
                if (victim && rollD20(0, this.rng) + 4 >= victim.ac) this.hurtPc(victim, rollFormula('1d6', {}, { rng: this.rng }) + 2, 'piercing');
            }
        }
    }

    // ---------- Ход персонажа ----------
    #available(pc, option) {
        const r = option.resource;
        if (!r) return true;
        if (r.slot) return Object.entries(pc.slots).some(([lvl, n]) => Number(lvl) >= r.slot && n > 0);
        return (pc.uses[r.uses] ?? r.max) > 0;
    }

    #spend(pc, option) {
        const r = option.resource;
        if (!r) return;
        if (r.slot) {
            const lvl = Object.keys(pc.slots).map(Number).sort((a, b) => a - b).find(l => l >= r.slot && pc.slots[l] > 0);
            if (lvl) pc.slots[lvl] -= 1;
        } else pc.uses[r.uses] = (pc.uses[r.uses] ?? r.max) - 1;
    }

    #multiplier(type) {
        const dv = this.dv;
        return dv.immune.has(type) ? 0 : dv.resist.has(type) ? 0.5 : 1;
    }

    // Средний урон варианта по Пожирателю с учётом КД, спасбросков и адаптаций
    #expected(pc, o) {
        const dmg = sum(o.parts.map(part => average(part.formula, o.data) * this.#multiplier(part.type)));
        const edge = (pc.advantage ? 1 : 0) - (pc.disadvantage || pc.frightened ? 1 : 0);
        if (o.type === 'attack') {
            const p = hitChance(o.toHit, this.p.ac, edge);
            return (dmg * p + (pc.sneak && o.sneak ? average(pc.sneak) * p : 0)) * (o.attacks ?? 1);
        }
        if (o.type === 'save') {
            const fail = failChance(this.p.saves[o.save] ?? 0, o.dc);
            return dmg * (fail + (1 - fail) * (o.onSave === 'half' ? 0.5 : 0));
        }
        return dmg;
    }

    // Ограниченные ресурсы бережём на 5 % выгоды: заговор не хуже ячейки — берём заговор
    #best(pc, bonus) {
        const choices = pc.options.filter(o => !!o.bonus === bonus && this.#available(pc, o)).map(o => ({ o, value: this.#expected(pc, o) * (o.resource ? 0.95 : 1) }));
        return choices.sort((a, b) => b.value - a.value)[0]?.o ?? null;
    }

    #resolve(pc, o) {
        this.#spend(pc, o);
        const before = this.dv.hp + this.dv.temp;
        this.#apply(pc, o);
        const dealt = before - this.dv.hp - this.dv.temp;
        if (this.log) this.say(`${pc.name}: ${o.name} — ${dealt} урона`);
        if (dealt > 0 && this.dv.hp > 0) this.#onDamageDealt(pc, o);
    }

    #apply(pc, o) {
        // ЗА ВАРУДО: первое опасное действие после его хода уходит в пустоту
        if (this.dv.warudo && this.#expected(pc, o) >= 10) {
            this.dv.warudo = false;
            this.dv.reaction = false;
            this.say(`ЗА ВАРУДО: ${o.name} ${pc.name} уходит в пустоту`);
            return;
        }
        const edge = (pc.advantage ? 1 : 0) - (pc.disadvantage || pc.frightened ? 1 : 0);
        let sneakUsed = false;
        for (let i = 0; i < (o.attacks ?? 1); i++) {
            if (this.dv.hp <= 0) return;
            if (o.type === 'attack') {
                let roll = rollD20(edge, this.rng);
                let hit = roll === 20 || (roll !== 1 && roll + o.toHit >= this.p.ac);
                // Перекрутка: реакцией перебросить первое попадание за раунд
                if (hit && this.dv.reaction) {
                    this.dv.reaction = false;
                    roll = rollD20(edge, this.rng);
                    hit = roll === 20 || (roll !== 1 && roll + o.toHit >= this.p.ac);
                }
                if (!hit) continue;
                for (const part of o.parts) this.hurtDevourer(rollFormula(part.formula, o.data, { rng: this.rng, crit: roll === 20 }), part.type);
                if (pc.sneak && o.sneak && !sneakUsed) {
                    sneakUsed = true;
                    this.hurtDevourer(rollFormula(pc.sneak, {}, { rng: this.rng, crit: roll === 20 }), o.parts[0].type);
                }
            } else if (o.type === 'save') {
                let saved = rollD20(0, this.rng) + (this.p.saves[o.save] ?? 0) >= o.dc;
                const rolls = o.parts.map(part => rollFormula(part.formula, o.data, { rng: this.rng }));
                // Легендарное сопротивление — на крупный урон
                if (!saved && this.dv.legres > 0 && sum(rolls) >= 15) { this.dv.legres -= 1; saved = true; this.say(`Легендарное сопротивление против ${o.name}`); }
                const k = saved ? (o.onSave === 'half' ? 0.5 : 0) : 1;
                o.parts.forEach((part, j) => this.hurtDevourer(Math.floor(rolls[j] * k), part.type));
            } else {
                for (const part of o.parts) this.hurtDevourer(rollFormula(part.formula, o.data, { rng: this.rng }), part.type);
            }
        }
    }

    pcTurn(pc) {
        if (pc.hp <= 0) return;
        pc.turnFired = new Set();
        if (pc.lostTurn) { pc.lostTurn = false; return; }
        if (this.stats.round === 1) this.#onTurnStart(pc, 'combat_start');
        this.#onTurnStart(pc, 'turn_start');
        // Лечение лежащего союзника важнее урона
        const down = this.pcs.find(x => x.hp <= 0);
        const heal = down && pc.heals.find(h => !h.resource || this.#available(pc, { resource: h.resource }));
        let bonusUsed = false;
        if (heal) {
            this.#spend(pc, { resource: heal.resource });
            down.hp = Math.min(down.maxHp, Math.max(1, Math.round(rollFormula(heal.formula, heal.data, { rng: this.rng }))));
            this.say(`${pc.name} поднимает ${down.name} (${heal.name})`);
            if (heal.bonus) bonusUsed = true;
            else return this.#endTurn(pc);
        }
        // Огрызок с кристаллом — перехватить, пока не донёс
        const thief = this.scraps.find(s => s.hp > 0 && s.carrying !== null);
        const action = this.#best(pc, false);
        if (thief && action && action.type === 'attack') {
            const roll = rollD20(0, this.rng);
            if (roll === 20 || roll + action.toHit >= thief.ac) {
                thief.hp = 0;
                (thief.owner?.hp > 0 ? thief.owner : pc).crystals.push(thief.carrying);
                thief.carrying = null;
                this.say(`${pc.name} сбивает Огрызка с кристаллом`);
            }
        } else if (action) this.#resolve(pc, action);
        if (!bonusUsed) {
            const bonus = this.#best(pc, true);
            if (bonus && this.dv.hp > 0) this.#resolve(pc, bonus);
        }
        this.#endTurn(pc);
    }

    #endTurn(pc) {
        pc.disadvantage = false;
        pc.frightened = false;
        pc.advantage = false;
    }

    // ---------- Раунды ----------
    run() {
        const order = [...this.pcs].sort((a, b) => (b.init + this.rng() * 20) - (a.init + this.rng() * 20));
        for (let round = 1; round <= MAX_ROUNDS; round++) {
            this.stats.round = round;
            this.log?.push(`Раунд ${round}: Пожиратель ${this.dv.hp} / ${this.dv.max} ПЗ, слоёв рухнуло ${this.dv.broken}, Брюхо ${sum(this.dv.belly)}`);
            // Счёт 20: логово и сразу его ход (Шов)
            this.lair();
            if (!alive(this.pcs).length) return this.#end('loss');
            if (this.devourerTurn() === 'left') return this.#end('left');
            if (!alive(this.pcs).length) return this.#end('loss');
            let legendary = this.p.legact;
            for (const pc of order) {
                this.pcTurn(pc);
                if (this.dv.hp <= 0) return this.#end('win');
                if (legendary > 0 && alive(this.pcs).length) { this.legendary(); legendary -= 1; }
                if (!alive(this.pcs).length) return this.#end('loss');
            }
        }
        return this.#end('timeout');
    }

    #end(result) {
        return {
            result, rounds: this.stats.round, layers: this.stats.layersBroken, swallowed: this.stats.swallowed,
            downs: this.stats.downs, standing: alive(this.pcs).length,
            partyHpLeft: sum(this.pcs.map(p => p.hp)) / sum(this.pcs.map(p => p.maxHp))
        };
    }
}

// ==========================================
// ПРОГОН И ОТЧЁТ
// ==========================================

function simulate(party, depth, satiety, runs) {
    const profile = devourerProfile(depth, satiety);
    const totals = { win: 0, loss: 0, left: 0, timeout: 0, rounds: 0, winRounds: 0, downs: 0, swallowed: 0, hpLeft: 0 };
    for (let i = 0; i < runs; i++) {
        const r = new Fight(party, profile).run();
        totals[r.result] += 1;
        totals.rounds += r.rounds;
        if (r.result === 'win') totals.winRounds += r.rounds;
        totals.downs += r.downs;
        totals.swallowed += r.swallowed;
        totals.hpLeft += r.partyHpLeft;
    }
    const pct = n => Math.round(n / runs * 100);
    return {
        depth, satiety, profile,
        win: pct(totals.win), loss: pct(totals.loss), left: pct(totals.left), timeout: pct(totals.timeout),
        rounds: totals.rounds / runs, winRounds: totals.win ? totals.winRounds / totals.win : 0,
        downs: totals.downs / runs, swallowed: totals.swallowed / runs, hpLeft: Math.round(totals.hpLeft / runs * 100)
    };
}

function describeParty(party) {
    const lines = ['Отряд:'];
    for (const pc of party) {
        const options = [...pc.options].sort((a, b) => (b.resource ? 0 : 1) - (a.resource ? 0 : 1)).slice(0, 4)
            .map(o => `${o.name}${o.resource ? (o.resource.slot ? ` [ячейка ${o.resource.slot}]` : ` [${o.resource.max} исп.]`) : ''}`);
        const slots = Object.entries(pc.slots).map(([l, n]) => `${l}:${n}`).join(' ');
        lines.push(`  ${pc.name} — ур. ${pc.level}, КД ${pc.ac}, ПЗ ${pc.hp}, кристаллы ${sum(pc.crystals)} (вес)${slots ? `, ячейки ${slots}` : ''}${pc.sneak ? `, скрытая атака ${pc.sneak}` : ''}`);
        lines.push(`    варианты: ${options.join('; ') || '—'}${pc.options.length > 4 ? ` и ещё ${pc.options.length - 4}` : ''}`);
        if (pc.effectsUsed?.length) lines.push(`    эффекты: ${pc.effectsUsed.join(', ')}`);
        if (pc.resist?.length) lines.push(`    сопротивления: ${pc.resist.join(', ')}`);
        if (pc.triggers?.length) lines.push(`    срабатывания: ${pc.triggers.map(t => `${t.name} (${t.trigger.on})`).join(', ')}`);
        if (pc.silent?.length) lines.push(`    не учтены (нет чисел для боя): ${pc.silent.join(', ')}`);
    }
    return lines.join('\n');
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    let party = loadParty(path.join(HERE, 'party'));
    let source = 'экспорт из tools/sim/party';
    if (!party.length) {
        party = typicalParty(args.level || 4);
        source = `типовой отряд ${args.level || 4} уровня (папка tools/sim/party пуста)`;
    }
    const level = Math.round(sum(party.map(p => p.level)) / party.length);
    const ownDepth = Math.max(1, Math.min(10, Math.ceil(level / 2)));
    const out = [`Пожиратель против отряда — ${source}`, describeParty(party), ''];

    if (args.log) {
        const depth = args.depth || ownDepth, satiety = args.satiety || 0;
        const log = [];
        const r = new Fight(party, devourerProfile(depth, satiety), { log }).run();
        out.push(`Один бой: Глубина ${depth}, Насыщение ${satiety}`, ...log, `Итог: ${r.result}, раундов ${r.rounds}`);
        console.log(out.join('\n'));
        return;
    }

    const depths = args.depth ? [args.depth] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const satieties = args.satiety !== undefined && !Number.isNaN(args.satiety) ? [args.satiety] : [0, 1, 2, 3, 4, 5];
    out.push(`Средний уровень отряда ${level} — его этаж: Глубина ${ownDepth}. Боёв на клетку: ${args.runs}.`, '');
    out.push('Победа отряда, % (в скобках — Пожиратель ушёл с полным Брюхом, %)');
    out.push(['Глубина'.padEnd(8), ...satieties.map(s => `Нас. ${s}`.padStart(11))].join(''));
    const detail = [];
    for (const depth of depths) {
        const row = [`${depth}${depth === ownDepth ? '*' : ''}`.padEnd(8)];
        for (const satiety of satieties) {
            const r = simulate(party, depth, satiety, args.runs);
            row.push(`${r.win} (${r.left})`.padStart(11));
            if (depth === ownDepth || depths.length === 1) detail.push(r);
        }
        out.push(row.join(''));
        process.stderr.write('.');
    }
    process.stderr.write('\n');
    out.push('', `Подробно — Глубина ${depths.length === 1 ? depths[0] : ownDepth}:`);
    out.push('Нас.  ПЗ Пож.  победа  поражение  ушёл  затянулся  раундов (до победы)  падений  съедено (вес)  ПЗ отряда в конце');
    for (const r of detail) {
        out.push([
            String(r.satiety).padEnd(6), String(r.profile.hp).padEnd(8), `${r.win} %`.padEnd(8), `${r.loss} %`.padEnd(11), `${r.left} %`.padEnd(6),
            `${r.timeout} %`.padEnd(11), `${r.rounds.toFixed(1)} (${r.winRounds.toFixed(1)})`.padEnd(21), r.downs.toFixed(1).padEnd(9),
            r.swallowed.toFixed(1).padEnd(15), `${r.hpLeft} %`
        ].join(''));
    }
    const text = out.join('\n');
    console.log(text);
    const file = path.join(HERE, 'last-run.txt');
    fs.writeFileSync(file, text + '\n', 'utf8');
    console.log(`\nСохранено: ${path.relative(process.cwd(), file)}`);
}

main();
