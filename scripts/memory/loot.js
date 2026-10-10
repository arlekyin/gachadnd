/**
 * Gacha Roguelike dnd5e — Генератор лута и гачи (Интерфейс Мастера)
 */

import { MODULE_ID } from "../core/constants.js";
import { isMemorySkill } from "./synergy/synergy.js";
import { addSkillToMemory } from "./inventory.js";
import { randomCrystal, randomCrystalWithTag, crystalImage } from "./crystals.js";
import { SYNERGIES } from "./synergy/synergy-tiers.js";
import { HOOKS } from "./memory-api.js";
import { startDraft } from "./draft.js";

// Веса редкости по этажам забега: чем глубже, тем больше редких
const RARITY_WEIGHTS_BY_FLOOR = [
    { upTo: 2, weights: { gray: 600, green: 250, blue: 100, purple: 40, red: 9 } },
    { upTo: 5, weights: { gray: 400, green: 300, blue: 180, purple: 90, red: 20 } },
    { upTo: Infinity, weights: { gray: 200, green: 300, blue: 250, purple: 150, red: 40 } }
];

// Мягкая гарантия на отряд: с 8-го кристалла подряд без фиолетового или красного шанс растёт на 6 %
// за каждый следующий, 15-й — гарантированно фиолетовый или красный; каждый 40-й без красного — красный
export const PITY = { softFrom: 8, step: 0.06, hard: 15, red: 40 };
const RARE = ['purple', 'red'];

export function registerLootSettings() {
    game.settings.register(MODULE_ID, 'lootPity', { scope: 'world', config: false, type: Object, default: { miss: 0, red: 0 } });
}

// Подсказка Тумана: каждый пятый кристалл добычи (в среднем) несёт тег, которому кому-то из отряда
// не хватает одного экипированного навыка до следующей ступени синергии
const NEAR_TAG_CHANCE = 0.2;

function nearTags() {
    const tags = new Set();
    for (const actor of game.actors.filter(a => a.type === 'character' && a.hasPlayerOwner)) {
        const counts = actor.getFlag(MODULE_ID, 'counts') ?? {};
        for (const { tag, key, tiers } of SYNERGIES) {
            const have = counts[key] ?? 0;
            const next = tiers.find(t => t.count > have);
            if (have > 0 && next && next.count - have === 1) tags.add(tag);
        }
    }
    return [...tags];
}

// Этаж знает Лабиринт; без него — первый
function currentFloor() {
    try {
        return Math.max(1, Number(game.settings.get(MODULE_ID, 'runFloor')) || 1);
    } catch (err) {
        return 1;
    }
}

export function rarityWeights(floor = currentFloor()) {
    return { ...RARITY_WEIGHTS_BY_FLOOR.find(t => floor <= t.upTo).weights };
}

const RARITY_COLORS = {
    'gray': '#7f7f7f', 'green': '#1eff00', 'blue': '#0070dd', 
    'purple': '#a335ee', 'red': '#ff003c', 'orange': '#ff8000'
};

const ROOM_TEMPLATES = {
    // Цель — 5–6 кристаллов на игрока за этаж: путь из 5 узлов даёт в среднем 1,75 Монстров и 0,75 Элиты, плюс Босс
    'normal': { name: 'Обычная комната', chancePerPlayer: 1.0, bonusRoll: false },
    'elite': { name: 'Элитный противник', chancePerPlayer: 1.5, bonusRoll: true },
    'boss': { name: 'Босс', chancePerPlayer: 2.0, bonusRoll: true },
    'cursed': { name: 'Проклятая комната', chancePerPlayer: 2.0, bonusRoll: false, excludeOrange: true, requiredTag: 'проклят' }
};

function pickWeighted(weights) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (const [rarity, weight] of Object.entries(weights)) {
        if (roll < weight) return rarity;
        roll -= weight;
    }
    return Object.keys(weights)[0];
}

/**
 * Редкость кристалла добычи. pity — счётчики мягкой гарантии ({ miss, red }); бросок их наращивает.
 * Без pity — чистые веса этажа (Жадность и прочие побочные броски).
 */
function rollRarity(bonusRoll = false, excludeOrange = false, pity = null) {
    const weights = rarityWeights();
    if (bonusRoll) delete weights.gray;
    if (!pity) return pickWeighted(weights);

    pity.miss += 1;
    pity.red += 1;
    const rare = Object.fromEntries(RARE.map(r => [r, weights[r]]));
    let rarity;
    if (pity.red >= PITY.red) rarity = 'red';
    else if (pity.miss >= PITY.hard) rarity = pickWeighted(rare);
    else {
        const bonus = Math.max(0, pity.miss - PITY.softFrom + 1) * PITY.step;
        rarity = Math.random() < bonus ? pickWeighted(rare) : pickWeighted(weights);
    }
    return rarity;
}

// Счётчики гарантии сбрасывает выпавший кристалл, а не заказанная редкость: проклятой комнате может не
// найтись фиолетового навыка с нужным тегом
function settlePity(pity, rarity) {
    if (RARE.includes(rarity)) pity.miss = 0;
    if (rarity === 'red') pity.red = 0;
}

export class GachaLootTerminal extends Application {
    constructor(options = {}) {
        super(options);
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "gachadnd-loot-terminal",
            template: null,
            width: 380,
            height: "auto",
            resizable: false,
            classes: ["dnd5e2", "gacha-dark-theme"]
        });
    }

    get title() { return `Генератор Лута (Мастер)`; }

    async _renderInner(data) {
        const activePlayersCount = game.users.filter(u => u.active && !u.isGM).length || 4;
        const div = document.createElement("div");
        div.style.cssText = "padding: 18px; display: flex; flex-direction: column; gap: 16px; background: #0b0a0a; color: #d0c9c0; font-family: 'Modesto Condensed', serif; box-sizing: border-box;";
        div.innerHTML = `
            <div style="text-align: center; border-bottom: 1px solid #3d3834; padding-bottom: 12px;">
                <div style="font-size: 1.6em; color: #ede6dc; letter-spacing: 1px;"><i class="fas fa-gem" style="color: #ffaa00;"></i> ПРИЗЫВ ТУМАНА</div>
            </div>
            <div>
                <label style="display: block; font-size: 1.15em; color: #8c8275; margin-bottom: 6px;">Тип завершенной комнаты:</label>
                <select id="gacha-room-type" style="width: 100%; background: #161414; color: #f5efe6; border: 1px solid #3d3834; height: 30px; border-radius: 4px;">
                    <option value="normal">Обычная комната (1 на игрока)</option>
                    <option value="elite">Элитный противник, Застава (1,5 на игрока)</option>
                    <option value="boss">Босс (2 на игрока)</option>
                    <option value="cursed">Проклятая комната (2 на игрока)</option>
                </select>
            </div>
            <div>
                <label style="display: block; font-size: 1.15em; color: #8c8275; margin-bottom: 6px;">Фильтр редкости:</label>
                <select id="gacha-rarity-filter" style="width: 100%; background: #161414; color: #f5efe6; border: 1px solid #3d3834; height: 30px; border-radius: 4px;">
                    <option value="any">Без фильтра (Стандартные шансы гачи)</option>
                    <option style="color: #9d9d9d;" value="gray">Только Серые</option>
                    <option style="color: #1eff00;" value="green">Только Зелёные</option>
                    <option style="color: #0070dd;" value="blue">Только Синие</option>
                    <option style="color: #a335ee;" value="purple">Только Фиолетовые</option>
                    <option style="color: #ff003c;" value="red">Только Красные</option>
                </select>
            </div>
            <div>
                <label style="display: block; font-size: 1.15em; color: #8c8275; margin-bottom: 6px;">Игроков:</label>
                <div style="display: flex; align-items: center; background: #161414; border: 1px solid #3d3834; border-radius: 4px; padding: 4px 6px; height: 30px;">
                    <input type="number" id="gacha-player-count" value="${activePlayersCount}" min="1" max="10" style="width: 100%; background: transparent; color: #f5efe6; border: none; outline: none;">
                </div>
            </div>
            <button type="button" id="gacha-generate-btn" style="margin-top: 5px; padding: 12px; background: linear-gradient(180deg, #38250d 0%, #1a1105 100%); border: 1px solid #ffaa00; border-radius: 4px; color: #ffaa00; font-size: 1.25em; font-weight: bold; cursor: pointer;">
                <i class="fas fa-dice-d20"></i> Сгенерировать добычу
            </button>
        `;
        return $(div);
    }

    activateListeners(html) {
        super.activateListeners(html);
        const element = html instanceof jQuery ? html[0] : html;

        element.querySelector('#gacha-generate-btn').addEventListener('click', async (e) => {
            e.preventDefault();
            const roomType = element.querySelector('#gacha-room-type').value;
            const rarityFilter = element.querySelector('#gacha-rarity-filter').value;
            const players = parseInt(element.querySelector('#gacha-player-count').value) || 1;
            await this.generateLoot(roomType, players, rarityFilter);
            this.close();
        });

    }

    async generateLoot(roomType, players, rarityFilter) {
        const template = ROOM_TEMPLATES[roomType] || ROOM_TEMPLATES['normal'];
        const totalChance = players * template.chancePerPlayer;
        const guaranteedDrops = Math.floor(totalChance);
        const fractionalChance = totalChance - guaranteedDrops;
        
        let dropsCount = guaranteedDrops;
        if (Math.random() <= fractionalChance) dropsCount += 1;
        // Любимчик Лабиринта: каждый экипированный навык с loot_bonus добавляет кристаллы в общую добычу
        dropsCount += game.actors
            .filter(a => a.type === 'character' && a.hasPlayerOwner)
            .flatMap(a => a.items.filter(i => isMemorySkill(i) && i.flags[MODULE_ID].is_active))
            .reduce((sum, i) => sum + (Number(i.flags[MODULE_ID].loot_bonus) || 0), 0);

        // Мягкая гарантия считается только для бросков без фильтра редкости
        const pity = { miss: 0, red: 0, ...game.settings.get(MODULE_ID, 'lootPity') };
        const near = template.requiredTag ? [] : nearTags();
        const drops = [];
        for (let i = 0; i < dropsCount; i++) {
            let targetRarity = rarityFilter;
            if (rarityFilter === 'any') targetRarity = rollRarity(template.bonusRoll, template.excludeOrange, pity);

            const hint = near.length && Math.random() < NEAR_TAG_CHANCE ? near[Math.floor(Math.random() * near.length)] : null;
            const crystal = (hint && await randomCrystalWithTag(targetRarity, hint)) || await randomCrystal(targetRarity, template.requiredTag);
            if (crystal) drops.push({ crystal, rarity: crystal.flags[MODULE_ID].rarity });
            if (crystal && rarityFilter === 'any') settlePity(pity, crystal.flags[MODULE_ID].rarity);
        }

        if (rarityFilter === 'any') await game.settings.set(MODULE_ID, 'lootPity', { miss: pity.miss, red: pity.red });

        const targets = canvas.tokens.controlled;
        const targetActor = targets.length === 1 ? targets[0].actor : null;

        // Выделен один токен — добыча целиком ему; иначе кристаллы делятся по очереди
        let draftOrder = null;
        if (targetActor && drops.length > 0) {
            await targetActor.createEmbeddedDocuments("Item", drops.map(d => d.crystal));
        } else if (drops.length > 0) {
            draftOrder = await startDraft(template.name, drops.map(d => d.crystal));
        }

        // Подключённые системы добавляют своё (Лабиринт — золото комнаты) и строку в карточку
        const loot = { roomType, actor: targetActor, lines: [], tasks: [] };
        Hooks.callAll(HOOKS.lootGenerated, loot);
        await Promise.all(loot.tasks);

        const forced = await this.applyForcedLoot(template, rarityFilter);
        // Гарантия близко — игроки видят только атмосферу, без чисел
        if (rarityFilter === 'any' && pity.miss >= PITY.softFrom - 1) loot.lines.push('<div style="text-align: center; margin-top: 8px; color: #b9a6d8; font-style: italic;"><i class="fas fa-smog"></i> Туман густеет: вероятность копится.</div>');
        await this.printLootCard(template.name, drops, targetActor, forced, loot.lines, draftOrder);
    }

    // Жадность: персонажи с экипированным навыком forced_loot получают кристаллы сразу в Память, без выбора
    async applyForcedLoot(template, rarityFilter) {
        const results = [];
        const actors = game.actors.filter(a => a.type === 'character' && a.hasPlayerOwner);

        for (const actor of actors) {
            const count = actor.items
                .filter(i => isMemorySkill(i) && i.flags[MODULE_ID].is_active)
                .reduce((sum, i) => sum + (Number(i.flags[MODULE_ID].forced_loot) || 0), 0);

            for (let i = 0; i < count; i++) {
                const rarity = rarityFilter === 'any' ? rollRarity(template.bonusRoll, template.excludeOrange) : rarityFilter;
                const crystal = await randomCrystal(rarity, template.requiredTag);
                if (!crystal) continue;

                const { is_crystal_item, ...extraFlags } = crystal.flags[MODULE_ID];
                const skillName = extraFlags.skill_name;
                const result = await addSkillToMemory(actor, skillName, { forced: true, extraFlags });
                if (result.status === 'duplicate') await actor.createEmbeddedDocuments('Item', [crystal]);
                results.push({ actor, skillName, rarity: extraFlags.rarity || rarity, ...result });
            }
        }
        return results;
    }

    async printLootCard(roomName, drops, targetActor, forced = [], lines = [], draftOrder = null) {
        let contentHtml = ``;
        if (drops.length === 0) {
            contentHtml = `<div style="text-align: center; padding: 15px; color: #7a7062;">Ничего ценного...</div>`;
        } else {
            contentHtml = drops.map(d => {
                const color = RARITY_COLORS[d.rarity] || '#aaa';
                const flags = d.crystal.flags[MODULE_ID];
                const tags = (flags.tags || []).join(', ');
                const customImg = crystalImage(d.rarity);

                return `
                    <div style="display: flex; align-items: center; gap: 12px; background: #111; padding: 8px; border: 1px solid ${color}; border-radius: 4px; margin-bottom: 8px;">
                        <img src="${customImg}" style="width: 40px; height: 40px; border-radius: 3px; border: 1px solid ${color};">
                        <div>
                            <div style="font-weight: bold; color: ${color}; font-size: 1.15em;">${d.crystal.name}</div>
                            <div style="font-size: 0.8em; color: #8c8275;">${flags.category || 'УТИЛИТА'} ${tags ? `• [${tags}]` : ''}</div>
                        </div>
                    </div>`;
            }).join('');
        }

        const forcedText = {
            added: () => 'занесён в Память',
            duplicate: () => 'повтор — кристалл в инвентаре, слияние на Алтаре Памяти',
            replaced: r => `занесён в Память, сгорел «${r.replacedName}»`,
            burned: () => 'сгорел'
        };
        const forcedHtml = forced.length ? `
            <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2626;">
                <div style="color: #ff003c; text-align: center; margin-bottom: 6px;">ЖАДНОСТЬ</div>
                ${forced.map(r => `<div style="font-size: 0.9em; color: #d0c9c0;"><strong>${r.actor.name}:</strong> <span style="color: ${RARITY_COLORS[r.rarity] || '#aaa'};">${r.skillName}</span> — ${forcedText[r.status]?.(r) ?? r.status}</div>`).join('')}
            </div>` : '';

        const statusText = targetActor ? `<span style="color: #1eff00;">Добыча добавлена: <strong>${targetActor.name}</strong></span>`
            : draftOrder ? `<span style="color: #ffaa00;">Кристаллы делятся по очереди: ${draftOrder.join(' → ')}</span>`
            : drops.length ? `<span style="color: #ffaa00;">Токен не выделен, персонажей отряда нет.</span>` : '';

        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: "Туманный Разлом" }),
            content: `
            <div style="background: #0b0a0a; border: 2px solid #3d3834; border-radius: 6px; padding: 12px; font-family: 'Modesto Condensed', serif;">
                <h3 style="text-align: center; color: #ede6dc; margin-bottom: 12px;">ДОБЫЧА: <span style="color: #ffaa00;">${roomName.toUpperCase()}</span></h3>
                ${contentHtml}
                ${lines.join('')}
                <div style="text-align: center; margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2626;">${statusText}</div>
                ${forcedHtml}
            </div>`
        });
    }
}