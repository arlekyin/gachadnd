/**
 * Gacha Roguelike dnd5e — Риск (узел карты «Риск»)
 *
 * Испытание «испытай удачу»: лестница этапов, каждый успех кладёт награду в общую копилку.
 * Перед каждым этапом отряд решает — идти дальше или уйти с добычей. 3 провала — обвал:
 * копилка сгорает наполовину, отряд получает последний удар сцены.
 *
 * Правила этапа: выступает один персонаж (отряд выбирает), один союзник может помочь (преимущество).
 * Выступавший пропускает следующий этап. Групповой этап бросают все: успех, если преуспела половина.
 * Провал можно вытянуть Ценой крови — Кость Хитов добавляется к результату.
 * Пока испытание идёт, нельзя поглощать кристаллы и менять навыки.
 *
 * Испытания — src/risks/*.yaml, собираются в data/risks.json. Состояние — в узле карты (флаг сцены floorMap).
 */

import { MODULE_ID } from "./constants.js";
import { randomCrystal, crystalForSkill } from "./crystals.js";
import { getFloor, rollGold, addGold } from "./economy.js";
import { partyActors } from "./horsemen.js";
import { isActiveGM, onSocket, emit, notifyUser, requestGM } from "./socket.js";
import { validateRisk } from "./risk-schema.js";

const { ApplicationV2 } = foundry.applications.api;

const RARITY_COLORS = { gray: '#9d9d9d', green: '#1eff00', blue: '#0070dd', purple: '#a335ee', red: '#ff003c' };
const MAX_FAILURES = 3;
const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ==========================================
// ДАННЫЕ
// ==========================================

// Пул испытаний: встроенные (data/risks.json) и свои испытания Мастера из JSON-файла мира
let challenges = null;
async function fetchJson(path) {
    try {
        const response = await fetch(path);
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    }
}

async function loadChallenges() {
    if (challenges) return challenges;
    const own = game.settings.get(MODULE_ID, 'riskOnlyCustom') ? [] : (await fetchJson(`modules/${MODULE_ID}/data/risks.json`)) ?? [];
    const custom = [];
    const path = game.settings.get(MODULE_ID, 'riskCustomFile');
    if (path) {
        const data = await fetchJson(path);
        if (!data) ui.notifications.error(`Свои испытания Риска: файл «${path}» не прочитан. Нужен JSON — объект испытания или список.`);
        for (const [i, risk] of (Array.isArray(data) ? data : data ? [data] : []).entries()) {
            const errors = validateRisk(risk);
            if ([...own, ...custom].some(c => c.id === risk?.id)) errors.push(`id: «${risk.id}» уже используется`);
            if (errors.length) {
                if (game.user.isGM) ui.notifications.error(`Испытание ${risk?.id ?? `№${i + 1}`} пропущено — ${errors[0]}`);
                console.warn(`[GachaDND] Испытание Риска ${risk?.id ?? i} пропущено:`, errors);
            } else custom.push(risk);
        }
    }
    challenges = [...own, ...custom];
    return challenges;
}

export function registerRiskSettings() {
    game.settings.register(MODULE_ID, 'riskHistory', { scope: 'world', config: false, type: Array, default: [] });
    const reset = () => { challenges = null; };
    game.settings.register(MODULE_ID, 'riskCustomFile', {
        name: 'Свои испытания Риска',
        hint: 'JSON-файл с испытаниями (объект или список) — формат как в src/risks/SCHEMA.md модуля. Добавляются к встроенным.',
        scope: 'world', config: true, type: String, default: '', filePicker: 'any', onChange: reset
    });
    game.settings.register(MODULE_ID, 'riskOnlyCustom', {
        name: 'Только свои испытания Риска',
        hint: 'Встроенные испытания не используются.',
        scope: 'world', config: true, type: Boolean, default: false, onChange: reset
    });
}

function currentRiskNode(scene = canvas?.scene) {
    const map = scene?.getFlag(MODULE_ID, 'floorMap');
    const node = map?.nodes?.find(n => n.id === map.currentNodeId);
    return node?.type === 'risk' ? { map, node } : null;
}

// Испытание идёт: поглощение кристаллов и смена навыков заблокированы
export function isRiskActive(scene) {
    return !!currentRiskNode(scene)?.node.risk?.active;
}

async function saveRisk(map, nodeId, risk) {
    const copy = foundry.utils.deepClone(map);
    copy.nodes.find(n => n.id === nodeId).risk = risk;
    await canvas.scene.setFlag(MODULE_ID, 'floorMap', copy);
}

const stageDC = (floor, approach) => 12 + Math.floor(floor / 2) + (approach?.dc ?? 0);
const actorLevel = actor => actor.system.details?.level ?? 1;
const isDown = actor => (actor.system.attributes?.hp?.value ?? 0) <= 0;

// Награда этапа: золото, затем кристаллы растущей редкости
async function stageReward(index) {
    const crystal = async rarity => {
        const data = await randomCrystal(rarity);
        return data ? { crystal: { skillId: data.flags[MODULE_ID].skill_id, name: data.name, rarity } } : {};
    };
    if (index === 0) return { gold: Math.round(rollGold('elite') / 2) };
    if (index === 1) return crystal('green');
    if (index === 2) return crystal('blue');
    if (index === 3) return { gold: rollGold('elite') };
    if (index === 4) return crystal('purple');
    return crystal(index % 2 ? 'blue' : 'purple');
}

function rewardLabel(index) {
    return ['½ золота элитной комнаты', 'зелёный кристалл', 'синий кристалл', 'золото элитной комнаты', 'фиолетовый кристалл'][index]
        ?? (index % 2 ? 'синий кристалл' : 'фиолетовый кристалл');
}

// ==========================================
// ОПЕРАЦИИ (выполняет Мастер)
// ==========================================

async function chat(content) {
    await ChatMessage.create({ speaker: { alias: 'Риск' }, content: `<div class="gachadnd-risk-chat">${content}</div>` });
}

async function applyFail(actor, fail) {
    if (!actor || !fail) return;
    if (fail.hp) {
        const hp = actor.system.attributes.hp.value;
        await actor.update({ 'system.attributes.hp.value': Math.max(0, hp - Math.round(fail.hp * actorLevel(actor))) });
    }
    if (fail.condition) await actor.toggleStatusEffect?.(fail.condition, { active: true });
}

// Самая маленькая доступная Кость Хитов: бросок и списание
async function spendHitDie(actor) {
    const classes = [...(actor.system.attributes?.hd?.classes ?? [])]
        .filter(c => (c.system.hd?.value ?? 0) > 0)
        .sort((a, b) => parseInt(a.system.hd.denomination.slice(1)) - parseInt(b.system.hd.denomination.slice(1)));
    const cls = classes[0];
    if (!cls) return null;
    const roll = await new Roll(`1${cls.system.hd.denomination}`).evaluate();
    await cls.update({ 'system.hd.spent': cls.system.hd.spent + 1 });
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: 'Цена крови: Кость Хитов' });
    return roll.total;
}

async function succeedStage(risk, challenge, actorId, note) {
    const reward = await stageReward(risk.stage);
    if (reward.gold) risk.pot.gold += reward.gold;
    if (reward.crystal) risk.pot.crystals.push(reward.crystal);
    const stage = challenge.stages[risk.stage];
    risk.log.push(`✔ ${stage.name}: ${note}`);
    risk.lastPerformer = actorId ?? null;
    risk.pending = null;
    risk.groupRolls = {};
    risk.stage += 1;
}

async function deliver(risk, recipient, reason) {
    risk.active = false;
    risk.ended = reason;
    if (!recipient) return chat(`Испытание окончено, но получатель добычи не выбран. Копилка: ${potText(risk.pot)}.`);
    const crystals = [];
    for (const c of risk.pot.crystals) {
        const data = await crystalForSkill({ skillId: c.skillId });
        if (data) crystals.push(data);
    }
    if (crystals.length) await recipient.createEmbeddedDocuments('Item', crystals);
    if (risk.pot.gold) await addGold(recipient, risk.pot.gold);
    return chat(`Добыча испытания — <strong>${esc(recipient.name)}</strong>: ${potText(risk.pot)}.`);
}

function potText(pot) {
    const parts = [];
    if (pot.gold) parts.push(`${pot.gold} зм`);
    pot.crystals.forEach(c => parts.push(`<span style="color: ${RARITY_COLORS[c.rarity]}">${esc(c.name)}</span>`));
    return parts.join(', ') || 'пусто';
}

async function collapse(risk, challenge) {
    risk.pot.gold = Math.floor(risk.pot.gold / 2);
    const keep = Math.floor(risk.pot.crystals.length / 2);
    risk.pot.crystals = risk.pot.crystals.sort(() => Math.random() - 0.5).slice(0, keep);
    for (const actor of partyActors()) if (!isDown(actor)) await applyFail(actor, challenge.collapse);
    risk.log.push(`✖ Обвал: ${challenge.collapse.text}`);
    await chat(`<strong>Обвал!</strong> ${esc(challenge.collapse.text)} Копилка сгорает наполовину.`);
}

async function performRiskOp({ op, userId, actorId, helperId, approach, total, recipientId }) {
    const found = currentRiskNode();
    if (!found?.node.risk?.active) return;
    const risk = foundry.utils.deepClone(found.node.risk);
    const challenge = (await loadChallenges()).find(c => c.id === risk.challengeId);
    if (!challenge) return;
    const stage = challenge.stages[risk.stage];
    const user = game.users.get(userId);
    const actor = game.actors.get(actorId);
    const deny = text => notifyUser(userId, text);
    const owns = a => a && user && (user.isGM || a.testUserPermission(user, 'OWNER'));

    const finishFailure = async () => {
        risk.failures += 1;
        if (risk.failures >= MAX_FAILURES) {
            await collapse(risk, challenge);
            const recipient = game.actors.get(risk.recipientId) ?? partyActors()[0];
            await deliver(risk, recipient, 'collapse');
        }
    };

    if (op === 'roll' && stage && !stage.group) {
        if (!owns(actor) || risk.pending) return;
        if (actorId === risk.lastPerformer) return deny(`${actor.name} выступал на прошлом этапе и пропускает этот.`);
        const choice = stage.approaches[approach];
        const dc = stageDC(risk.floor, choice);
        const helper = game.actors.get(helperId);
        const note = `${actor.name} — ${choice.label} (${total} против Сл ${dc})${helper ? `, помогал ${helper.name}` : ''}`;
        if (total >= dc) {
            await succeedStage(risk, challenge, actorId, note);
            if (risk.stage >= challenge.stages.length) await deliver(risk, game.actors.get(risk.recipientId) ?? actor, 'complete');
        } else {
            risk.pending = { actorId, approach, total, dc, note };
        }
    }

    else if (op === 'blood' && risk.pending) {
        const performer = game.actors.get(risk.pending.actorId);
        if (!owns(performer)) return;
        const bonus = await spendHitDie(performer);
        if (bonus === null) return deny(`${performer.name}: Кости Хитов кончились.`);
        risk.pending.total += bonus;
        risk.pending.note = `${risk.pending.note}, Цена крови +${bonus}`;
        if (risk.pending.total >= risk.pending.dc) {
            await succeedStage(risk, challenge, risk.pending.actorId, `${risk.pending.note} → ${risk.pending.total}`);
            if (risk.stage >= challenge.stages.length) await deliver(risk, game.actors.get(risk.recipientId) ?? performer, 'complete');
        }
    }

    else if (op === 'accept' && risk.pending) {
        const performer = game.actors.get(risk.pending.actorId);
        if (!owns(performer)) return;
        const choice = stage.approaches[risk.pending.approach];
        await applyFail(performer, choice.fail);
        risk.log.push(`✖ ${stage.name}: ${risk.pending.note} — ${choice.fail.text}`);
        risk.lastPerformer = risk.pending.actorId;
        risk.pending = null;
        await finishFailure();
    }

    else if (op === 'groupRoll' && stage?.group) {
        if (!owns(actor) || risk.groupRolls[actorId] || isDown(actor)) return;
        const choice = stage.approaches[approach];
        const dc = stageDC(risk.floor, choice);
        risk.groupRolls[actorId] = { approach, total, dc, success: total >= dc };
        const participants = partyActors().filter(a => !isDown(a));
        if (participants.every(a => risk.groupRolls[a.id])) {
            const rolls = participants.map(a => ({ actor: a, ...risk.groupRolls[a.id] }));
            const successes = rolls.filter(r => r.success).length;
            const summary = rolls.map(r => `${r.actor.name} ${r.total}/${r.dc}`).join(', ');
            if (successes >= Math.ceil(rolls.length / 2)) {
                await succeedStage(risk, challenge, null, `все вместе (${summary})`);
                if (risk.stage >= challenge.stages.length) await deliver(risk, game.actors.get(risk.recipientId) ?? participants[0], 'complete');
            } else {
                for (const r of rolls.filter(r => !r.success)) await applyFail(r.actor, stage.approaches[r.approach].fail);
                risk.log.push(`✖ ${stage.name}: все вместе (${summary})`);
                risk.groupRolls = {};
                risk.lastPerformer = null;
                await finishFailure();
            }
        }
    }

    else if (op === 'auto' && user?.isGM && stage) {
        await succeedStage(risk, challenge, stage.group ? null : actorId, `${stage.group ? 'отряд' : actor?.name ?? 'отряд'} — автоуспех (решение Мастера)`);
        if (risk.stage >= challenge.stages.length) await deliver(risk, game.actors.get(risk.recipientId) ?? actor ?? partyActors()[0], 'complete');
    }

    // Импровизация не удалась: провал этапа, выступавший теряет ПЗ, равные уровню, и пропускает следующий этап
    else if (op === 'autoFail' && user?.isGM && stage && !risk.pending) {
        if (!stage.group && actor) {
            await applyFail(actor, { hp: 1 });
            risk.lastPerformer = actorId;
        }
        risk.groupRolls = {};
        risk.log.push(`✖ ${stage.name}: ${stage.group ? 'отряд' : actor?.name ?? 'отряд'} — импровизация не удалась`);
        await finishFailure();
    }

    else if (op === 'recipient' && user?.isGM) {
        risk.recipientId = recipientId;
    }

    else if (op === 'leave' && user?.isGM && !risk.pending) {
        risk.log.push('Отряд уходит с добычей.');
        await deliver(risk, game.actors.get(recipientId ?? risk.recipientId), 'left');
    }

    await saveRisk(found.map, found.node.id, risk);
}

// Операции выполняются по очереди: каждая читает состояние, которое записала предыдущая
let queue = Promise.resolve();
onSocket('riskOp', message => {
    if (!isActiveGM()) return;
    queue = queue.then(() => performRiskOp(message.payload)).catch(err => console.error('[GachaDND] Риск:', err));
    return queue;
});
onSocket('openRisk', () => RiskWindow.show());

const request = payload => requestGM('riskOp', payload);

// ==========================================
// ОКНО РИСКА
// ==========================================

function skillLabel(key) {
    const label = CONFIG.DND5E?.skills?.[key]?.label;
    return label ? game.i18n.localize(label) : key;
}

async function rollSkill(actor, skill, advantage) {
    const result = await actor.rollSkill({ skill, advantage }, { configure: false });
    const roll = Array.isArray(result) ? result[0] : result;
    return roll?.total ?? null;
}

export class RiskWindow extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: 'gachadnd-risk',
        classes: ['gachadnd-risk'],
        tag: 'div',
        window: { title: 'Риск', icon: 'fas fa-exclamation-triangle', resizable: true },
        position: { width: 720, height: 720 },
        actions: {
            roll: RiskWindow.#onRoll,
            groupRoll: RiskWindow.#onGroupRoll,
            blood: () => request({ op: 'blood' }),
            accept: () => request({ op: 'accept' }),
            auto: RiskWindow.#onAuto,
            autoFail: RiskWindow.#onAutoFail,
            leave: RiskWindow.#onLeave
        }
    };

    // Мастер начинает испытание: выбирается ещё не встречавшееся, окно открывается у всех
    static async open() {
        if (!game.user.isGM) return RiskWindow.show();
        const found = currentRiskNode();
        if (!found) return ui.notifications.warn('Отряд не стоит на узле Риска.');
        if (!found.node.risk) {
            const all = await loadChallenges();
            if (!all.length) return ui.notifications.error('Испытания Риска не найдены: соберите модуль (npm run build).');
            let history = game.settings.get(MODULE_ID, 'riskHistory') ?? [];
            let pool = all.filter(c => !history.includes(c.id));
            if (!pool.length) { history = []; pool = all; }
            const challenge = pool[Math.floor(Math.random() * pool.length)];
            await game.settings.set(MODULE_ID, 'riskHistory', [...history, challenge.id]);
            await saveRisk(found.map, found.node.id, {
                challengeId: challenge.id, floor: getFloor(), stage: 0, failures: 0, active: true,
                pot: { gold: 0, crystals: [] }, lastPerformer: null, pending: null, groupRolls: {}, log: [],
                recipientId: partyActors()[0]?.id ?? null, ended: null
            });
            await chat(`<strong>${esc(challenge.name)}</strong><br>${esc(challenge.intro)}`);
        }
        emit('openRisk');
        return RiskWindow.show();
    }

    static show() {
        const existing = foundry.applications.instances?.get('gachadnd-risk');
        if (existing) return existing.render({ force: true });
        return new RiskWindow().render({ force: true });
    }

    async _renderHTML() {
        const found = currentRiskNode();
        const risk = found?.node.risk;
        if (!risk) return '<p class="gd-risk-empty">Отряд не стоит на узле Риска.</p>';
        const challenge = (await loadChallenges()).find(c => c.id === risk.challengeId);
        if (!challenge) return '<p class="gd-risk-empty">Испытание не найдено.</p>';
        const party = partyActors();
        const stage = challenge.stages[risk.stage];
        const pips = Array.from({ length: MAX_FAILURES }, (_, i) => `<span class="gd-pip ${i < risk.failures ? 'on' : ''}"></span>`).join('');
        const options = list => list.map(a => `<option value="${a.id}" ${a.id === this.performerId ? 'selected' : ''}>${esc(a.name)}</option>`).join('');

        let body = '';
        if (!risk.active) {
            body = `<div class="gd-risk-end">${{ left: 'Отряд ушёл с добычей.', complete: 'Испытание пройдено до конца.', collapse: 'Обвал.' }[risk.ended] ?? 'Испытание окончено.'}</div>`;
        } else if (risk.pending) {
            const performer = game.actors.get(risk.pending.actorId);
            const mine = game.user.isGM || performer?.isOwner;
            body = `
                <div class="gd-risk-pending">
                    <div>Провал: ${esc(risk.pending.note)} — ${risk.pending.total} против Сл ${risk.pending.dc}</div>
                    ${mine ? `<div class="gd-risk-buttons">
                        <button type="button" data-action="blood"><i class="fas fa-tint"></i> Цена крови — Кость Хитов</button>
                        <button type="button" data-action="accept">Принять провал</button>
                    </div>` : '<div>Ждём решения выступавшего.</div>'}
                </div>`;
        } else if (stage?.group) {
            const rows = party.filter(a => !isDown(a)).map(a => {
                const rolled = risk.groupRolls[a.id];
                const mine = game.user.isGM || a.isOwner;
                return `<div class="gd-risk-row"><span>${esc(a.name)}</span>${rolled
                    ? `<span class="${rolled.success ? 'ok' : 'bad'}">${rolled.total} / Сл ${rolled.dc}</span>`
                    : mine ? stage.approaches.map((ap, i) => `<button type="button" data-action="groupRoll" data-actor-id="${a.id}" data-approach="${i}">${skillLabel(ap.skill)} · Сл ${stageDC(risk.floor, ap)}</button>`).join('') : '<span>бросает…</span>'}</div>`;
            }).join('');
            body = `<div class="gd-risk-note">Групповой этап: бросают все, этап пройден, если преуспела хотя бы половина.</div>${rows}`;
        } else if (stage) {
            const eligible = party.filter(a => !isDown(a) && a.id !== risk.lastPerformer);
            if (!eligible.some(a => a.id === this.performerId)) this.performerId = (eligible.find(a => a.isOwner) ?? eligible[0])?.id;
            const performer = game.actors.get(this.performerId);
            const canRoll = performer && (game.user.isGM || performer.isOwner);
            const helpers = party.filter(a => !isDown(a) && a.id !== this.performerId && a.id !== risk.lastPerformer);
            body = `
                <div class="gd-risk-pick">
                    <label>Выступает <select class="gd-risk-performer">${options(eligible)}</select></label>
                    <label>Помогает <select class="gd-risk-helper"><option value="">никто</option>${helpers.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
                </div>
                ${risk.lastPerformer ? `<div class="gd-risk-note">${esc(game.actors.get(risk.lastPerformer)?.name ?? '')} выступал на прошлом этапе и пропускает этот.</div>` : ''}
                <div class="gd-approaches">${stage.approaches.map((ap, i) => `
                    <div class="gd-approach">
                        <div class="gd-approach-label">${esc(ap.label)}</div>
                        <div class="gd-approach-meta">${skillLabel(ap.skill)} · Сл ${stageDC(risk.floor, ap)}</div>
                        <div class="gd-approach-fail">Провал: ${esc(ap.fail.text)}${ap.fail.hp ? ` −${ap.fail.hp} × уровень ПЗ.` : ''}</div>
                        <button type="button" data-action="roll" data-approach="${i}" ${canRoll ? '' : 'disabled'}>Бросок</button>
                    </div>`).join('')}
                </div>`;
        }

        const gm = game.user.isGM && risk.active ? `
            <div class="gd-risk-gm">
                <label>Добыча — <select class="gd-risk-recipient">${party.map(a => `<option value="${a.id}" ${a.id === risk.recipientId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
                ${stage && !risk.pending ? '<button type="button" data-action="auto" title="Творческое применение навыка, заклинания или предмета удалось">Автоуспех</button>' : ''}
                ${stage && !risk.pending ? '<button type="button" data-action="autoFail" title="Импровизация не удалась: провал этапа, выступавший теряет ПЗ, равные уровню">Автопровал</button>' : ''}
                <button type="button" data-action="leave" ${risk.pending ? 'disabled' : ''}>Уйти с добычей</button>
            </div>` : '';

        return `
            <div class="gd-risk-head">
                <h2>${esc(challenge.name)}</h2>
                <div class="gd-risk-fails">Провалы ${pips}</div>
            </div>
            <div class="gd-risk-intro">${esc(challenge.intro)}</div>
            <div class="gd-risk-pot"><strong>Копилка:</strong> ${potText(risk.pot)}</div>
            ${stage && risk.active ? `<h3>Этап ${risk.stage + 1} из ${challenge.stages.length} — ${esc(stage.name)} <span class="gd-risk-reward">→ ${rewardLabel(risk.stage)}</span></h3>` : ''}
            ${body}
            ${gm}
            ${risk.log.length ? `<div class="gd-risk-log">${risk.log.map(l => `<div>${esc(l)}</div>`).join('')}</div>` : ''}`;
    }

    _replaceHTML(result, content) {
        content.innerHTML = result;
    }

    _onRender() {
        this.element.querySelector('.gd-risk-performer')?.addEventListener('change', event => {
            this.performerId = event.target.value;
            this.render();
        });
        this.element.querySelector('.gd-risk-recipient')?.addEventListener('change', event => {
            request({ op: 'recipient', recipientId: event.target.value });
        });
    }

    static async #onRoll(event, target) {
        const actor = game.actors.get(this.performerId);
        const found = currentRiskNode();
        const challenge = (await loadChallenges()).find(c => c.id === found?.node.risk?.challengeId);
        const approach = Number(target.dataset.approach);
        const choice = challenge?.stages[found.node.risk.stage]?.approaches[approach];
        if (!actor || !choice) return;
        const helperId = this.element.querySelector('.gd-risk-helper')?.value || null;
        target.disabled = true;
        const total = await rollSkill(actor, choice.skill, !!helperId);
        if (total === null) return this.render();
        request({ op: 'roll', actorId: actor.id, helperId, approach, total });
    }

    static async #onGroupRoll(event, target) {
        const actor = game.actors.get(target.dataset.actorId);
        const found = currentRiskNode();
        const challenge = (await loadChallenges()).find(c => c.id === found?.node.risk?.challengeId);
        const approach = Number(target.dataset.approach);
        const choice = challenge?.stages[found.node.risk.stage]?.approaches[approach];
        if (!actor || !choice) return;
        target.disabled = true;
        const total = await rollSkill(actor, choice.skill, false);
        if (total === null) return this.render();
        request({ op: 'groupRoll', actorId: actor.id, approach, total });
    }

    static #onAuto() {
        request({ op: 'auto', actorId: this.performerId });
    }

    static #onAutoFail() {
        request({ op: 'autoFail', actorId: this.performerId });
    }

    static #onLeave() {
        request({ op: 'leave', recipientId: this.element.querySelector('.gd-risk-recipient')?.value });
    }
}

const rerenderRisk = () => foundry.applications.instances?.get('gachadnd-risk')?.render();
Hooks.on('updateScene', (scene, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.floorMap`)) rerenderRisk();
});
Hooks.on('updateActor', rerenderRisk);
