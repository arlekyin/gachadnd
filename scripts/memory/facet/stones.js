/**
 * Gacha Roguelike dnd5e — Огранка: как срабатывают камни (docs/ogranka.md, «Камни»)
 *
 * Камень не добавляет своего эффекта — переносит то, что способность уже сделала. Поэтому всё
 * начинается с броска урона или лечения способности (dnd5e.rollDamageV2): итог броска и цели уходят
 * Мастеру, а он выкладывает карточки — кому ещё достаётся тот же эффект:
 *   Разлёт        — всем существам в 5 футах от единственной цели (героя — только лечением), столько же;
 *   Перекидка     — ближайшему существу в 10 футах от цели, столько же;
 *   Шальной заряд — случайному существу в 30 футах от героя, столько же;
 *   Переливание   — рядом с героем: урон лечит союзника, лечение ранит врага;
 *   Раскат        — в начале следующего хода героя те же цели получают половину;
 *   Мина          — эффект не применяется сразу: игрок закладывает его в точку в 30 футах (или применяет сразу);
 *                   сработает, когда туда войдут, или в начале хода героя.
 * Охват не множится: перескочившее не разлетается и наоборот; Раскат не повторяет сам себя.
 * Броски (docs/ogranka-stones.md, «Броски»): камень переносит только сработавшее — атака промахнулась по первой
 * цели, камни молчат (карточка «промах»). Остальным задетым атака не бросается заново: тот же бросок против КД
 * каждого. Спасбросок каждый бросает свой — кнопкой в карточке, против Сл способности. Мина замораживает бросок:
 * атака и урон — при закладке, наступивший — против своего КД или со своим спасброском. Лечение — без бросков.
 * Карточки камней пишут, что произошло и что дальше, — строкой why.
 * Цена: В долг — способность без ячейки и заряда, вместо них кости хитов (сразу; не хватает — цена обычная);
 * Плата кровью — кнопка в карточке способности: без траты действия или реакции за ПЗ, раз в раунд.
 * Камни не дают ближнему бою дальности, а дальнему — безопасности (docs/ogranka-stones.md, «Риск»):
 *   Выброс — кнопка в карточке: перенос в клетку в 30 фт, ближе к цели (раз за ход; перенос — не путь, мины молчат);
 *   Мина — в пределах досягаемости или дальности способности, не дальше 30 фт; На бегу — движение после применения,
 *   всегда под атаки по возможности (их решает Мастер); Сквозь, Вплетение и Проводник — подсказкой, на честность.
 * Свет — форма: Луч (линия 5 × 60 фт от героя к цели), Конус (15 фт к цели), Вспышка (10 фт вокруг героя) —
 *   эффект достаётся всем в фигуре (герою — только лечение); цель вне фигуры не задета. Цель обязательна и должна быть
 *   в досягаемости или дальности самой способности (rangeOf): иначе применить нельзя; форма — одна (facet.js, stonesFor).
 * Движение: Разбег — герой прошёл в этот ход 20 фт и больше прямо к цели: атака с преимуществом, спасбросок
 *   цели с помехой — строкой в карточке (начало хода — флаг токена turnStart); Рокировка — кнопка в карточке:
 *   поменяться местами с одной из целей способности в 15 фт, раз за ход; На бегу — после применения герой проходит
 *   до половины скорости, цели сами: все, мимо кого он прошёл за это перемещение (путь — moveToken).
 * Сталь: Выверено — кости силы заменяются средним, без костей — атака 10 + бонус; Вплетение и Проводник —
 *   строкой (это экономия действий, решает игрок).
 *
 * Карточки — как у навыков (blast/common.js): модуль не бросает и не применяет урон сам, кнопки dnd5e,
 * применяет Мастер лотком. Мины — флаг сцены facetMines, видны всем значком в точке.
 */

import { MODULE_ID } from "../../core/constants.js";
import { onSocket, requestGM, isActiveGM } from "../../core/socket.js";
import { onRenderChatMessage, messageItem, messageActivity } from "../../core/chat-hooks.js";
import { blast, around, tokenOf, esc, boom, centerOf, isDead } from "../skills/blast/common.js";
import { STONES, TAG_COLORS, isFacetable, stonesFor, facetState } from "./facet.js";
import { t } from "../../core/i18n.js";

const CARRY = ['hop', 'spread', 'transfuse', 'echo', 'mine', 'beam', 'cone', 'flash', 'finish', 'switch'];
const FORMS = { beam: t('Луч'), cone: t('Конус'), flash: t('Вспышка') };
/** Есть ли у героя такой камень хоть где-то (горящий) */
const facetablesWith = (actor, id) => facetState(actor).placements.some(p => p.id === id && p.active);
export const uuidOf = token => token?.document?.uuid ?? token?.uuid ?? null;
const levelOf = actor => Number(actor?.system?.details?.level) || 1;
export const tokenFrom = async uuid => { const doc = uuid ? await fromUuid(uuid) : null; return doc?.documentName === 'Token' ? doc : doc?.token ?? tokenOf(doc)?.document ?? null; };
const distance = (a, b) => { const p = centerOf(a), q = centerOf(b); return Math.hypot(p.x - q.x, p.y - q.y); };
const enrich = (html, actor) => (foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor).enrichHTML(html, { rollData: actor?.getRollData?.() ?? {} });
const gem = id => `<span class="gd-stone-gem" style="--r: ${TAG_COLORS[STONES[id].tag]}"></span>`;

// ==========================================
// БРОСКИ: попала ли способность и чем её проверяют у остальных
// ==========================================

const SAVE_OF = { str: t('Силы'), dex: t('Ловкости'), con: t('Телосложения'), int: t('Интеллекта'), wis: t('Мудрости'), cha: t('Харизмы') };

/** Последняя атака способности на этом клиенте: { total, nat, at } — по uuid активности; урон её забирает */
const ATTACKS = new Map();
Hooks.on('dnd5e.rollAttackV2', (rolls, data) => {
    const activity = data?.subject, roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if (!activity?.uuid || !roll) return;
    ATTACKS.set(activity.uuid, { total: Number(roll.total) || 0, nat: Number(roll.d20?.total ?? roll.dice?.[0]?.total) || 0, at: Date.now() });
});

/**
 * Проверка способности для камней: атака — тот же бросок против КД каждого; спасбросок — каждый бросает
 * свой против Сл; лечение и урон без броска — без проверки (атаку не бросали — тоже)
 */
function checkOf(activity) {
    if (activity.type === 'attack') {
        const last = ATTACKS.get(activity.uuid);
        ATTACKS.delete(activity.uuid);
        return last && Date.now() - last.at < 10 * 60 * 1000 ? { kind: 'attack', total: last.total, nat: last.nat } : null;
    }
    if (activity.type === 'save') {
        const raw = activity.save?.ability;
        const ability = typeof raw === 'string' ? raw : [...(raw ?? [])][0];
        const dc = Number(activity.save?.dc?.value) || null;
        return ability && dc ? { kind: 'save', ability, dc, half: activity.damage?.onSave === 'half' } : null;
    }
    return null;
}
export const acOf = token => Number(token.actor?.system?.attributes?.ac?.value) || 10;
/** Попала ли атака по этому существу: 20 на кости — всегда, 1 — никогда; Неотвратимо — всегда (auto) */
export const hits = (check, token) => check.auto || check.nat === 20 || (check.nat !== 1 && check.total >= acOf(token));
/** Чем проверят того, кому достанется, — строка для карточек «что дальше» (в карточке урона бросок виден и так) */
function testLine(check) {
    if (check?.kind === 'attack') return t('Атака {total} — против его КД.', { total: check.total });
    if (check?.kind === 'save') return t('Спасбросок {ability} Сл {dc}{v}.', { ability: SAVE_OF[check.ability] ?? check.ability, dc: check.dc, v: check.half ? t(', успех — половина') : t(', успех — мимо') });
    return '';
}
// ==========================================
// КАРТОЧКИ
// ==========================================

/**
 * Тот же эффект ещё кому-то. why — что за камень и почему, одной строкой. check — проверка способности:
 * атака — тот же бросок против КД каждого (мимо — строкой), спасбросок — кнопкой в карточке, лечение — без проверки
 */
export async function effectCard(actor, { title, victims, amount, type, heal, why = '', check = null }) {
    if (!victims.length || !(amount > 0)) return;
    const note = why ? `<span class="gd-stone-why">${why}</span>` : '';
    if (heal) {
        const content = await enrich(`<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-gem"></i> ${esc(title)}</div>
            ${note ? `<p>${note}</p>` : ''}<ul class="gd-blast-list"><li>${type === 'temphp' ? t('Временные ПЗ') : t('Лечение')}: ${esc(victims.map(t => t.name).join(', '))}</li></ul>
            <p class="gd-blast-rolls">[[/heal ${amount}${type === 'temphp' ? ' temphp' : ''}]]</p></div>`, actor);
        return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
    }
    const base = { actor, title, icon: 'fa-gem', formula: String(amount), type };
    if (check?.kind === 'save') return blast({ ...base, victims, note, ability: check.ability, dc: check.dc, half: check.half });
    if (check?.kind === 'attack') {
        const hit = victims.filter(t => hits(check, t)), miss = victims.filter(t => !hits(check, t));
        const missLine = miss.length ? t('Атака {total} — мимо: {v}.', { total: check.total, v: miss.map(tok => t('{name} (КД {ac})', { name: esc(tok.name), ac: acOf(tok) })).join(', ') }) : '';
        if (!hit.length) return noteCard(actor, title, [why, missLine].filter(Boolean).join('<br>'));
        return blast({ ...base, victims: hit, note: [note, missLine].filter(Boolean).join('<br>'), lead: t('Атака {total}{v} — попадание', { total: check.total, v: check.nat === 20 ? ' (20)' : '' }) });
    }
    return blast({ ...base, victims, note });
}
export function noteCard(actor, title, text) {
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="gd-blast-card"><div class="gd-blast-title"><i class="fas fa-gem"></i> ${esc(title)}</div><p>${text}</p></div>` });
}

/** Плата своими ПЗ: модуль снимает сам и пишет строку в чат */
async function payHp(actor, amount, why, more = '') {
    if (!actor || !(amount > 0)) return;
    const hp = actor.system.attributes.hp;
    await actor.update({ 'system.attributes.hp.value': Math.max(0, hp.value - amount) });
    await noteCard(actor, why, `${t('{v}{v2} теряет {amount} ПЗ.', { v: more ? `${more}<br>` : '', v2: esc(actor.name), amount })}`);
}

// ==========================================
// БРОСОК УРОНА ИЛИ ЛЕЧЕНИЯ: что камни переносят
// ==========================================

Hooks.on('dnd5e.rollDamageV2', (rolls, data) => {
    const activity = data?.subject, item = activity?.item, actor = item?.actor;
    if (!actor || !isFacetable(item)) return;
    const stones = stonesFor(activity).filter(id => CARRY.includes(id));
    if (!stones.length) return;
    const list = (Array.isArray(rolls) ? rolls : [rolls]).filter(Boolean);
    const heal = activity.type === 'heal' || (list.length > 0 && list.every(r => ['healing', 'temphp'].includes(r.options?.type)));
    const amount = list.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
    const type = list[0]?.options?.type ?? (heal ? 'healing' : 'force');
    const caster = tokenOf(actor);
    let targets = [...game.user.targets].map(uuidOf).filter(Boolean);
    if (!targets.length && heal && caster) targets = [uuidOf(caster)];
    let check = heal ? null : checkOf(activity);
    // Неотвратимо: атака — попадание всегда, спасбросок — провал (у задетых камнями — тоже, без кнопки спасброска)
    if (check && stonesFor(activity).includes('inevitable')) check = check.kind === 'attack' ? { ...check, auto: true } : null;
    const payload = { actorId: actor.id, casterUuid: uuidOf(caster), name: item.name, stones, amount, type, heal, targets, check, reach: reachOf(activity), range: rangeOf(activity) };
    if (stones.includes('mine')) return mineCard(actor, payload);
    requestGM('facetCast', payload);
});

onSocket('facetCast', ({ payload }) => { if (isActiveGM()) facetCast(payload).catch(error => console.error(`${MODULE_ID} | огранка: камни`, error)); });
/** Мастер: разложить перенесённый эффект по камням (Мина сюда приходит уже сработавшей) */
export async function facetCast({ actorId, casterUuid, name, stones, amount, type, heal, targets, check = null, range = null }) {
    const actor = game.actors.get(actorId), caster = await tokenFrom(casterUuid);
    const primary = (await Promise.all((targets ?? []).map(tokenFrom))).filter(t => t?.actor);
    if (!actor || !(amount > 0)) return;
    const form = stones.find(id => FORMS[id]);
    // Форме света нужна цель в досягаемости способности: цель задаёт и направление, и проверку дальности
    if (!primary.length) {
        if (form) await noteCard(actor, `${FORMS[form]} — ${name}`, t('Выберите цель в досягаемости способности.'));
        return;
    }
    const first = primary[0];
    if (form && caster && !inRange(caster, first, range)) {
        return noteCard(actor, `${FORMS[form]} — ${name}`, t('{v} вне досягаемости способности ({range} футов) — она не срабатывает.', { v: esc(first.name), range }));
    }
    // Камень переносит только сработавшее: атака мимо первой цели — камни молчат. Форма света заменяет цель — та же атака против КД каждого в фигуре
    const missed = check?.kind === 'attack' && !hits(check, first);
    if (missed && !form) {
        return noteCard(actor, t('Огранка — {name}', { name }), t('Промах по {v}: атака {total} против КД {v2} — камни не сработали.', { v: esc(first.name), total: check.total, v2: acOf(first) }));
    }
    const what = heal ? t('лечение') : t('урон');
    const test = testLine(check);
    const taken = new Set(primary.map(t => t.id));
    // Кого ещё может задеть: не задетый, живой; героя — только лечением
    const free = t => !taken.has(t.id) && !isDead(t.actor) && (t.id !== caster?.id || heal);
    let shaped = [], outside = false;
    if (form && caster) {
        const area = inShape(form, caster, first);
        outside = !area.some(t => t.id === first.id);
        if (outside) await noteCard(actor, `${FORMS[form]} — ${name}`, t('{v} вне фигуры — эффект на него не действует.', { v: esc(first.name) }));
        shaped = area.filter(free);
        shaped.forEach(t => taken.add(t.id));
        const where = { beam: t('на линии 60 футов от героя к цели'), cone: t('в конусе 15 футов от героя к цели'), flash: t('в 10 футах вокруг героя') }[form];
        await effectCard(actor, { title: `${FORMS[form]} — ${name}`, victims: shaped, amount, type, heal, check,
            why: t('{v}: все {where} получают тот же {what}.', { v: FORMS[form], where, what }) });
    }
    if (missed) return;
    // Перенос от цели — только если она сама задета
    const anchored = !outside;
    let spread = [];
    if (stones.includes('spread') && anchored && primary.length === 1) {
        spread = around(first, 5).filter(free);
        spread.forEach(t => taken.add(t.id));
        await effectCard(actor, { title: t('Разлёт — {name}', { name }), victims: spread, amount, type, heal, check,
            why: t('Разлёт: все в 5 футах от {v} получают тот же {what}.', { v: esc(first.name), what }) });
    }
    if (stones.includes('hop') && anchored) {
        const near = around(first, 10).filter(free).sort((a, b) => distance(a, first) - distance(b, first))[0];
        if (near) {
            taken.add(near.id);
            await effectCard(actor, { title: t('Перекидка — {name}', { name }), victims: [near], amount, type, heal, check,
                why: t('Перекидка: {what} перескакивает с {v} на ближайшее существо — {v2}.', { what, v: esc(first.name), v2: esc(near.name) }) });
        }
    }
    if (stones.includes('finish') && anchored) {
        // Добить: сила сверх того, что цель могла принять, — урон сверх её ПЗ, лечение сверх недостающих
        const hp = first.actor.system.attributes.hp, max = Number(hp.effectiveMax) || Number(hp.max) || 0;
        const rest = heal ? amount - Math.max(0, max - (Number(hp.value) || 0)) : amount - (Number(hp.value) || 0) - (Number(hp.temp) || 0);
        if (rest > 0) {
            const near = around(first, 30).filter(t => free(t) || primary.some(p => p.id === t.id)).sort((a, b) => distance(a, first) - distance(b, first))[0];
            const why = t('Добить: {what} {v} — лишнее {rest}.', { what: heal ? t('лечение наполнило ПЗ:') : t('урон опустил до 0 ПЗ:'), v: esc(first.name), rest });
            if (near) await passCard(actor, { name, target: near, amount: rest, type, heal, check, why: `${why} ${test}` });
            else await noteCard(actor, t('Добить — {name}', { name }), t('{why} Рядом никого — лишнее пропало.', { why }));
        }
    }
    if (stones.includes('switch') && caster) {
        const pool = around(caster, 30).filter(free);
        const stray = pool[Math.floor(Math.random() * pool.length)];
        if (stray) {
            taken.add(stray.id);
            await effectCard(actor, { title: t('Шальной заряд — {name}', { name }), victims: [stray], amount, type, heal, check,
                why: t('Шальной заряд: способность срабатывает ещё раз — случайно досталось {v}.', { v: esc(stray.name) }) });
        } else await noteCard(actor, t('Шальной заряд — {name}', { name }), t('В 30 футах больше никого — заряд ушёл в пустоту.'));
    }
    if (stones.includes('transfuse') && caster) {
        // Обратная сторона — рядом с героем: урон лечит его союзника, лечение ранит его врага (дальнобой держится у своих)
        const want = heal ? -caster.disposition : caster.disposition;
        const near = around(caster, 5).filter(t => t.disposition === want && t.disposition !== 0 && !taken.has(t.id) && !isDead(t.actor))
            .sort((a, b) => distance(a, caster) - distance(b, caster))[0];
        const whom = esc(first.name);
        if (near) await effectCard(actor, { title: t('Переливание — {name}', { name }), victims: [near], amount, type: heal ? 'necrotic' : 'healing', heal: !heal,
            why: heal ? t('Переливание: лечение {v} ранит ближайшего к герою врага — на столько же, без броска.', { v: whom })
                : t('Переливание: урон по {v} лечит ближайшего к герою союзника — на столько же.', { v: whom }) });
        else await noteCard(actor, t('Переливание — {name}', { name }), t('Рядом с героем нет {v} — переливать некому.', { v: heal ? t('врага') : t('союзника') }));
    }
    if (stones.includes('echo') && game.combat?.started) {
        const hit = [...(outside ? [] : primary), ...shaped, ...spread];
        if (hit.length) {
            const echo = actor.getFlag(MODULE_ID, 'facetEcho') ?? [];
            echo.push({ name, targets: hit.map(uuidOf), amount: Math.floor(amount / 2), type, heal, check });
            await actor.setFlag(MODULE_ID, 'facetEcho', echo);
            await noteCard(actor, t('Раскат — {name}', { name }), t('В начале вашего следующего хода {v} получат ещё половину: {what} {v2}. {test}', { v: esc(hit.map(t => t.name).join(', ')), what, v2: Math.floor(amount / 2), test }));
        }
    }
}

/**
 * Фигура света от героя к цели: Луч — линия 5 × 60 фт, Конус — 15 фт (ширина равна длине), Вспышка — 10 фт вокруг
 * героя. Существо в фигуре — центром, с запасом в полклетки
 */
export function inShape(form, caster, target) {
    const scene = caster.parent, grid = scene.grid, ft = grid.size / grid.distance, half = grid.size / 2;
    const c = centerOf(caster), t = centerOf(target ?? caster);
    const dir = Math.atan2(t.y - c.y, t.x - c.x);
    const ux = Math.cos(dir), uy = Math.sin(dir);
    return scene.tokens.filter(token => {
        if (!token.actor || token.hidden) return false;
        const p = centerOf(token), dx = p.x - c.x, dy = p.y - c.y;
        const along = dx * ux + dy * uy, across = Math.abs(-dx * uy + dy * ux);
        if (form === 'flash') return Math.hypot(dx, dy) <= 10 * ft + half;
        if (form === 'beam') return along > 0 && along <= 60 * ft + half && across <= 2.5 * ft + half * 0.5;
        if (form === 'cone') return along > 0 && along <= 15 * ft + half && across <= along / 2 + half * 0.5;
        return false;
    });
}

/** Добить: передать лишнее — выбор игрока, кнопкой в карточке; после нажатия — кому досталось */
function passHtml(pass) {
    return `<div class="gd-blast-card gd-stone-card"><div class="gd-blast-title"><i class="fas fa-gem"></i> ${t('Добить — {v}', { v: esc(pass.name) })}</div>
        <p class="gd-stone-why">${pass.why}</p><p>${pass.used ? t('Передано: <b>{v}</b>.', { v: esc(pass.target.name) }) : t('Передать ближайшему существу — или оставить как есть:')}</p>
        <div class="gd-stone-buttons"><button type="button" data-gd-pass="1">${esc(pass.target.name)}: ${pass.amount}</button></div></div>`;
}
export async function passCard(actor, { name, target, amount, type, heal, check, why }) {
    const pass = { actorId: actor.id, name, amount, type, heal, check, why, used: false, target: { uuid: uuidOf(target), name: target.name } };
    return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: passHtml(pass), flags: { [MODULE_ID]: { facetPass: pass } } });
}
onSocket('facetPassPick', ({ payload }) => { if (isActiveGM()) passPick(payload).catch(error => console.error(`${MODULE_ID} | огранка: добить`, error)); });
async function passPick({ messageId }) {
    const message = game.messages.get(messageId), pass = message?.getFlag(MODULE_ID, 'facetPass');
    if (!pass || pass.used) return;
    const token = await tokenFrom(pass.target.uuid);
    if (!token) return;
    const next = { ...pass, used: true };
    await message.update({ content: passHtml(next), [`flags.${MODULE_ID}.facetPass`]: next });
    await effectCard(game.actors.get(pass.actorId), { title: t('Добить — {name}', { name: pass.name }), victims: [token], amount: pass.amount, type: pass.type, heal: pass.heal, check: pass.check,
        why: t('Лишнее передано: {v}.', { v: esc(token.name) }) });
}

// ==========================================
// МИНА
// ==========================================

/**
 * Карточка мины по шагам: wait — что будет и как заложить; placed — ждёт; fired — сработала; now — применено сразу.
 * Бросок заморожен: атака и урон брошены при закладке
 */
function mineHtml(payload, state, extra = '') {
    const what = `${payload.heal ? t('лечение') : t('урон')} ${payload.amount}`;
    const who = payload.heal ? t('союзник') : t('враг');
    const test = payload.heal ? '' : ` ${testLine(payload.check)}`;
    const body = {
        wait: `<p class="gd-stone-why">${t('{v} — его можно заложить: {what}{v2}.', { v: payload.heal ? t('Лечение не применено') : t('Урон не нанесён'), what, v2: payload.check?.kind === 'attack' ? t(', атака {total}', { total: payload.check.total }) : '' })}</p>
            <ol class="gd-stone-steps"><li><b>${t('Заложить')}</b> ${t('— нажмите и щёлкните клетку на сцене в {v} футах от героя: досягаемость способности.', { v: payload.reach ?? 30 })}</li>
            <li>${t('Первый {who}, который встанет на эту клетку или пройдёт через неё, получит {what} — и все {v} в соседних клетках, считая диагональ. Соседние клетки мину не взрывают.{test}', { who, what, v: payload.heal ? t('союзники') : t('враги'), test })}</li>
            <li>${t('Не сработала до начала вашего хода — сработает сама на тех, кто рядом.')}</li></ol>
            <p><b>${t('Сразу')}</b> ${t('— применить как обычно, по выбранным целям.')}</p>`,
        placed: `<p class="gd-stone-why">${t('Заложена: {what}. Ждёт, пока войдёт {who}.{test} В начале вашего хода сработает сама.', { what, who, test })}</p>`,
        fired: `<p class="gd-stone-why">${t('Сработала. {extra}', { extra })}</p>`,
        now: `<p class="gd-stone-why">${t('Применено сразу, без мины.')}</p>`
    }[state];
    const buttons = state === 'wait' ? `<div class="gd-stone-buttons"><button type="button" data-gd-mine="place"><i class="fas fa-location-crosshairs"></i> ${t('Заложить')}</button><button type="button" data-gd-mine="now">${t('Сразу')}</button></div>` : '';
    return `<div class="gd-blast-card gd-stone-card"><div class="gd-blast-title"><i class="fas fa-gem"></i> ${t('Мина — {v}', { v: esc(payload.name) })}</div>${body}${buttons}</div>`;
}
function mineCard(actor, payload) {
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }), content: mineHtml(payload, 'wait'),
        flags: { [MODULE_ID]: { facetMine: { payload, state: 'wait' } } }
    });
}
/** Мастер: новое состояние карточки мины — и текст, и флаг */
function mineState(message, card, state, extra = '') {
    const next = { ...card, state };
    return message.update({ content: mineHtml(card.payload, state, extra), [`flags.${MODULE_ID}.facetMine`]: next });
}

/**
 * Досягаемость или дальность способности, футы, не дальше 30: оружие ближнего боя — досягаемость (5, с «досягаемостью»
 * 10), дальнобойное — обычная дальность; заклинание — дальность, «на себя» и касание — 5
 */
function reachOf(activity) {
    const item = activity.item, range = item.system?.range ?? {};
    let feet = 5;
    if (item.type === 'weapon') feet = /R$/.test(item.system.type?.value ?? '') ? Number(range.value) || 30 : Number(range.reach) || (item.system.properties?.has?.('rch') ? 10 : 5);
    else {
        const r = activity.range?.units ? activity.range : range;
        feet = r.units === 'ft' ? Number(r.value) || 5 : r.units === 'mi' ? 30 : 5;
    }
    return Math.min(30, feet);
}

/**
 * Полная досягаемость или дальность способности, футы; null — без предела. Оружие ближнего боя — досягаемость (метательное —
 * дальность броска), дальнобойное — дальняя дистанция; способность «на себя» с областью — размер области, касание — 5
 */
function rangeOf(activity) {
    const item = activity.item, range = item.system?.range ?? {};
    if (item.type === 'weapon') {
        if (/R$/.test(item.system.type?.value ?? '') || item.system.properties?.has?.('thr')) return Number(range.long) || Number(range.value) || 30;
        return Number(range.reach) || (item.system.properties?.has?.('rch') ? 10 : 5);
    }
    const r = activity.range?.units ? activity.range : range;
    if (r.units === 'ft') return Number(r.value) || 5;
    if (r.units === 'mi') return (Number(r.value) || 1) * 5280;
    if (r.units === 'self') return Number(activity.target?.template?.size) || 5;
    if (r.units === 'touch' || !r.units) return 5;
    return null;
}
/** В пределах ли дальности: сам герой — всегда; null — без предела */
const inRange = (caster, target, range) => range == null || target.id === caster.id || around(caster, range).some(t => t.id === target.id);

// Форма света: цель дальше досягаемости способности — применить нельзя, цена цела. Выброс переносит героя уже после
// применения, На бегу сам меняет цель: для них дальность проверяется при броске (facetCast)
Hooks.on('dnd5e.preUseActivity', activity => {
    const stones = stonesFor(activity);
    if (!stones.some(id => FORMS[id]) || stones.includes('cast') || stones.includes('run')) return;
    const caster = tokenOf(activity.item.actor)?.document, target = firstTarget();
    if (!caster || !target) return;
    const range = rangeOf(activity);
    if (inRange(caster, target, range)) return;
    ui.notifications.warn(t('{v} вне досягаемости способности ({range} футов).', { v: target.name, range }));
    return false;
});

/** Игрок щёлкает клетку на сцене; дальше досягаемости способности — нельзя */
function pickPoint(actor, messageId, reach = 30) {
    const caster = tokenOf(actor)?.document;
    if (!canvas?.ready || !caster || caster.parent?.id !== canvas.scene.id) return ui.notifications.warn(t('Герой не на этой сцене.'));
    ui.notifications.info(t('Щёлкните клетку на сцене — в {reach} футах от героя.', { reach }));
    canvas.stage.once('pointerdown', event => {
        const point = event.getLocalPosition?.(canvas.stage) ?? event.data?.getLocalPosition?.(canvas.stage) ?? canvas.mousePosition;
        const grid = canvas.scene.grid, c = centerOf(caster), cell = grid.getCenterPoint?.(point) ?? point;
        const feet = Math.hypot(cell.x - c.x, cell.y - c.y) / grid.size * grid.distance;
        if (feet > reach + grid.distance / 2) return ui.notifications.warn(t('Дальше {reach} футов — досягаемость способности, мину туда не заложить.', { reach }));
        requestGM('facetMinePlace', { messageId, sceneId: canvas.scene.id, x: Math.round(point.x), y: Math.round(point.y) });
    });
}

onSocket('facetMinePlace', ({ payload }) => { if (isActiveGM()) minePlace(payload).catch(error => console.error(`${MODULE_ID} | огранка: мина`, error)); });
async function minePlace({ messageId, sceneId, x, y }) {
    const message = game.messages.get(messageId), card = message?.getFlag(MODULE_ID, 'facetMine'), scene = game.scenes.get(sceneId);
    if (!card || card.state !== 'wait' || !scene) return;
    // Мина — в клетке: точка щелчка — к центру клетки
    ({ x, y } = scene.grid.getCenterPoint?.({ x, y }) ?? { x, y });
    await mineState(message, card, 'placed');
    const caster = await tokenFrom(card.payload.casterUuid);
    const mines = scene.getFlag(MODULE_ID, 'facetMines') ?? [];
    mines.push({ id: foundry.utils.randomID(), messageId, x, y, side: caster?.disposition ?? 1, payload: { ...card.payload, stones: card.payload.stones.filter(s => s !== 'mine') } });
    await scene.setFlag(MODULE_ID, 'facetMines', mines);
}
onSocket('facetMineNow', ({ payload }) => { if (isActiveGM()) mineNow(payload).catch(error => console.error(`${MODULE_ID} | огранка: мина`, error)); });
async function mineNow({ messageId }) {
    const message = game.messages.get(messageId), card = message?.getFlag(MODULE_ID, 'facetMine');
    if (!card || card.state !== 'wait') return;
    await mineState(message, card, 'now');
    await facetCast({ ...card.payload, stones: card.payload.stones.filter(s => s !== 'mine') });
}

/** Занимает ли токен (на месте x, y) клетку мины; reach — ещё клеток вокруг неё, считая диагональ */
function onMine(token, mine, { x = token.x, y = token.y, reach = 0 } = {}) {
    const size = token.parent.grid.size, pad = reach * size;
    const w = (token.width || 1) * size, h = (token.height || 1) * size;
    return mine.x >= x - pad && mine.x < x + w + pad && mine.y >= y - pad && mine.y < y + h + pad;
}
/** Кого задевает мина: урон — не своих, лечение — своих; в клетке мины и в соседних, с диагональю */
const mineVictims = (scene, mine) => scene.tokens.filter(t => t.actor && !t.hidden && onMine(t, mine, { reach: 1 }))
    .filter(t => !isDead(t.actor) && (mine.payload.heal ? t.disposition === mine.side : t.disposition !== mine.side));

/** Мина срабатывает: основной эффект — карточкой, остальные камни — как при обычном применении. entering —
 * кто вошёл (в v14 в хуке перемещения документ токена ещё на старом месте) */
export async function detonateMine(scene, mineId, entering = null) {
    const mines = scene.getFlag(MODULE_ID, 'facetMines') ?? [];
    const mine = mines.find(m => m.id === mineId);
    if (!mine) return;
    await scene.setFlag(MODULE_ID, 'facetMines', mines.filter(m => m.id !== mineId));
    const victims = mineVictims(scene, mine);
    if (entering && !victims.some(t => t.id === entering.id)) victims.push(entering);
    const actor = game.actors.get(mine.payload.actorId), check = mine.payload.check;
    const how = entering ? t('{v} вошёл в точку.', { v: esc(entering.name) }) : t('Начался ход героя — сработала сама.');
    const message = game.messages.get(mine.messageId), card = message?.getFlag(MODULE_ID, 'facetMine');
    if (card) await mineState(message, card, 'fired', victims.length ? how : t('{how} Рядом никого — впустую.', { how }));
    boom({ sceneId: scene.id, x: mine.x, y: mine.y, radius: scene.grid.size * 1.5, color: mine.payload.heal ? 0x7dd87a : 0xff7a1a });
    if (!victims.length) return noteCard(actor, t('Мина — {name}', { name: mine.payload.name }), t('{how} Рядом никого — сработала впустую.', { how }));
    await effectCard(actor, { title: t('Мина — {name}', { name: mine.payload.name }), victims, amount: mine.payload.amount, type: mine.payload.type, heal: mine.payload.heal, check,
        why: t('Мина: {how}', { how }) });
    // Остальные камни — от тех, кого мина задела (атака мимо — не задела)
    const hit = check?.kind === 'attack' && !mine.payload.heal ? victims.filter(t => hits(check, t)) : victims;
    if (hit.length) await facetCast({ ...mine.payload, range: null, targets: hit.map(uuidOf) });
}

/**
 * Пройденный путь токена (левый верхний угол), с шагом в четверть клетки — от начала движения по пройденным точкам
 * (moveToken — и перетаскивание, и обновление x, y). Перенос (Выброс, Рокировка, телепорт Мастера) — не путь:
 * только клетка, куда встал
 */
function pathOf(token, movement, operation) {
    const jump = !!operation?.[`${MODULE_ID}Jump`];
    const step = token.parent.grid.size / 4, path = [];
    let from = movement?.origin ?? { x: token.x, y: token.y };
    for (const to of movement?.passed?.waypoints ?? []) {
        if (jump || to.action === 'displace') { path.push({ x: to.x, y: to.y, jump: true }); from = to; continue; }
        const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
        for (let k = 1; k <= n; k++) path.push({ x: from.x + (to.x - from.x) * k / n, y: from.y + (to.y - from.y) * k / n });
        from = to;
    }
    return path;
}

// Кто-то прошёл через клетку мины или встал на неё. Соседние клетки и диагональ не взрывают
Hooks.on('moveToken', (token, movement, operation) => {
    if (!isActiveGM() || !token.actor || isDead(token.actor)) return;
    const scene = token.parent, mines = scene?.getFlag(MODULE_ID, 'facetMines') ?? [];
    if (!mines.length) return;
    const path = pathOf(token, movement, operation);
    for (const mine of mines) {
        const side = mine.payload.heal ? token.disposition === mine.side : token.disposition !== mine.side;
        if (side && path.some(at => onMine(token, mine, at))) detonateMine(scene, mine.id, token).catch(error => console.error(`${MODULE_ID} | огранка: мина`, error));
    }
});

// Мины на сцене — значком в точке, у всех
const MINE_LAYER = 'gdFacetMines';
function drawMines() {
    if (!canvas?.ready) return;
    const parent = canvas.interface ?? canvas.controls;
    parent.getChildByName?.(MINE_LAYER)?.destroy({ children: true });
    const mines = canvas.scene.getFlag(MODULE_ID, 'facetMines') ?? [];
    if (!mines.length) return;
    const layer = new PIXI.Container();
    layer.name = MINE_LAYER;
    layer.eventMode = 'none';
    const r = canvas.grid.size * 0.22;
    for (const mine of mines) {
        const color = mine.payload.heal ? 0x7dd87a : 0xffc94a;
        const pts = Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + i * Math.PI / 3; return [mine.x + r * Math.cos(a), mine.y + r * Math.sin(a)]; }).flat();
        const g = new PIXI.Graphics();
        g.beginFill(0x1a1410, 0.75).lineStyle(2, color, 0.95).drawPolygon(pts).endFill();
        g.beginFill(color, 0.9).drawCircle(mine.x, mine.y, r * 0.32).endFill();
        layer.addChild(g);
    }
    parent.addChild(layer);
}
Hooks.on('canvasReady', drawMines);
Hooks.on('updateScene', (scene, changes) => { if (scene.id === canvas?.scene?.id && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) drawMines(); });

// ==========================================
// ЦЕНА: В долг, Плата кровью
// ==========================================

/** В долг: сколько костей хитов стоит способность — по кости за уровень ячейки, кость вместо заряда; без цены — 0 */
function debtDice(activity, usage) {
    const item = activity.item, actor = item.actor;
    if (item.type === 'spell' && (item.system.level ?? 0) > 0) {
        const slot = usage?.spell?.slot ?? '';
        const level = slot === 'pact' ? Number(actor.system.spells?.pact?.level) : Number(String(slot).match(/\d+/)?.[0]);
        return level || item.system.level;
    }
    return activity.consumption?.targets?.length || item.system.uses?.max ? 1 : 0;
}
const hitDiceLeft = actor => Object.values(actor.classes ?? {}).reduce((sum, cls) => sum + (Number(cls.system.hd?.value) || 0), 0);

// В долг — уже после окна применения: ячейка выбрана. Хватает костей — ячейка и заряды не тратятся; не хватает — цена обычная
Hooks.on('dnd5e.preActivityConsumption', (activity, usage) => {
    if (!stonesFor(activity).includes('debt') || !usage || usage.consume === false) return;
    const dice = debtDice(activity, usage);
    if (!dice) return;
    if (dice > hitDiceLeft(activity.item.actor)) return void ui.notifications.warn(t('В долг: не хватает костей хитов ({dice}) — цена обычная.', { dice }));
    usage.consume = { ...(typeof usage.consume === 'object' ? usage.consume : { action: true }), resources: [], spellSlot: false };
    usage.gdDebtDice = dice;
});
Hooks.on('dnd5e.postUseActivity', (activity, usage) => {
    const actor = activity?.item?.actor;
    if (actor && usage?.gdDebtDice) spendHitDice(actor, usage.gdDebtDice, activity.item.name).catch(error => console.error(`${MODULE_ID} | огранка: долг`, error));
});
/** Кости хитов — сначала меньшие; долгий отдых возвращает их как обычно */
async function spendHitDice(actor, dice, name) {
    const faces = cls => Number(String(cls.system.hd.denomination).slice(1)) || 0;
    const left = hitDiceLeft(actor) - dice, updates = [];
    let need = dice;
    for (const cls of Object.values(actor.classes).sort((a, b) => faces(a) - faces(b))) {
        const take = Math.min(need, Number(cls.system.hd.value) || 0);
        if (take) updates.push({ _id: cls.id, 'system.hd.spent': (Number(cls.system.hd.spent) || 0) + take });
        need -= take;
    }
    await actor.updateEmbeddedDocuments('Item', updates);
    await noteCard(actor, t('В долг — {name}', { name }), t('Без ячейки и заряда: потрачено костей хитов — {dice}, осталось {left}.', { dice, left }));
}

/** Цена Платы кровью: уровень героя, у заклинания с ячейкой — ещё 5 × уровень ячейки (два огненных шара за ход дороги) */
function bloodCost(message, actor) {
    const item = messageItem(message);
    const slot = Number(message.getFlag?.('dnd5e', 'use')?.spellLevel ?? item?.system?.level) || 0;
    return levelOf(actor) + (item?.type === 'spell' && slot > 0 ? 5 * slot : 0);
}

// Плата кровью — игрок сам отмечает, что применил без траты действия или реакции: кнопка в карточке, раз в раунд
async function payBlood(message, actor) {
    const key = game.combat?.started ? `${game.combat.round}` : null;
    if (key && actor.getFlag(MODULE_ID, 'facetPaid') === key) return ui.notifications.warn(t('Плата кровью — раз в раунд.'));
    if (key) await actor.setFlag(MODULE_ID, 'facetPaid', key);
    await message.setFlag(MODULE_ID, 'facetPaidHere', true);
    await payHp(actor, bloodCost(message, actor), t('Плата кровью — {v}', { v: messageItem(message)?.name ?? '' }), t('Это применение — без траты действия или реакции. Раз в раунд.'));
}

// ==========================================
// ДВИЖЕНИЕ: Разбег, Рокировка
// ==========================================

/** Разбег: герой прошёл в этот ход 20 фт и больше прямо к цели (ближе к ней на 20 фт от клетки начала хода) */
export function charged(actor, target) {
    const token = tokenOf(actor)?.document, combat = game.combat;
    const start = token?.getFlag?.(MODULE_ID, 'turnStart');
    if (!token || !target || !combat?.started || combat.combatant?.actor?.id !== actor.id || !start || start.round !== combat.round || start.turn !== combat.turn) return false;
    const grid = token.parent.grid, ft = grid.size / grid.distance;
    const now = centerOf(token), t = centerOf(target);
    const moved = Math.hypot(now.x - start.x, now.y - start.y) / ft;
    const closer = (Math.hypot(t.x - start.x, t.y - start.y) - Math.hypot(t.x - now.x, t.y - now.y)) / ft;
    return moved >= 20 - 0.1 && closer >= 20 - 0.1;
}
const firstTarget = () => [...game.user.targets][0]?.document ?? null;

// Атака с Разбегом — с преимуществом
Hooks.on('dnd5e.preRollAttackV2', config => {
    const activity = config?.subject, actor = activity?.item?.actor;
    if (!actor || !stonesFor(activity).includes('charge') || !charged(actor, firstTarget())) return;
    config.advantage = true;
    for (const roll of config.rolls ?? []) (roll.options ??= {}).advantage = true;
});
// Применение с Разбегом — отметка в карточке (спасбросок цели с помехой — по правилу, строкой)
Hooks.on('dnd5e.postUseActivity', (activity, usage, results) => {
    const actor = activity?.item?.actor, message = results?.message;
    if (!actor || !message || !stonesFor(activity).includes('charge') || !charged(actor, firstTarget())) return;
    message.setFlag?.(MODULE_ID, 'facetCharge', true);
});

/**
 * Перенос токена — не ходьба: действие displace (без пути, без цены движения и без ограничения скоростью: у героя
 * со скоростью 0 обычное перемещение dnd5e отклонит); мины по дороге молчат
 */
function jump(token, x, y) {
    const options = { animate: false, [`${MODULE_ID}Jump`]: true };
    if (typeof token.move === 'function') return token.move([{ x, y, action: 'displace' }], options);
    return token.update({ x, y }, options);
}

/**
 * Выброс: герой переносится в клетку в 30 фт, которую видит, и применяет способность оттуда — раз за ход.
 * Щелчок по клетке у игрока; переносит Мастер
 */
function blinkPick(message, actor) {
    const caster = tokenOf(actor)?.document, combat = game.combat;
    if (!canvas?.ready || !caster || caster.parent?.id !== canvas.scene.id) return ui.notifications.warn(t('Герой не на этой сцене.'));
    const key = combat?.started ? `${combat.round}.${combat.turn}` : null;
    if (key && actor.getFlag(MODULE_ID, 'facetBlink') === key) return ui.notifications.warn(t('Выброс — раз за ход.'));
    const target = firstTarget();
    if (!target) return ui.notifications.warn(t('Сначала выберите цель: Выброс переносит ближе к ней.'));
    ui.notifications.info(t('Щёлкните клетку в 30 футах, ближе к цели, — герой перенесётся туда.'));
    canvas.stage.once('pointerdown', async event => {
        const point = event.getLocalPosition?.(canvas.stage) ?? event.data?.getLocalPosition?.(canvas.stage) ?? canvas.mousePosition;
        const grid = canvas.scene.grid, size = grid.size;
        const cell = grid.getCenterPoint?.(point) ?? point, from = centerOf(caster);
        const feet = Math.hypot(cell.x - from.x, cell.y - from.y) / size * grid.distance;
        if (feet > 30 + grid.distance / 2) return ui.notifications.warn(t('Дальше 30 футов — туда не перенестись.'));
        // Рывок, а не отход: клетка ближе к цели, чем герой стоит
        const aim = centerOf(target);
        if (Math.hypot(cell.x - aim.x, cell.y - aim.y) >= Math.hypot(from.x - aim.x, from.y - aim.y)) return ui.notifications.warn(t('Только ближе к цели, чем вы стоите.'));
        // Клетка свободна: ни одного токена, кроме самого героя
        const busy = canvas.scene.tokens.some(tok => tok.id !== caster.id && !tok.hidden && cell.x >= tok.x && cell.x < tok.x + (tok.width || 1) * size && cell.y >= tok.y && cell.y < tok.y + (tok.height || 1) * size);
        if (busy) return ui.notifications.warn(t('Клетка занята.'));
        if (key) await actor.setFlag(MODULE_ID, 'facetBlink', key);
        requestGM('facetBlink', { messageId: message.id, sceneId: canvas.scene.id, tokenId: caster.id, actorId: actor.id, x: cell.x, y: cell.y, feet: Math.round(feet / 5) * 5 });
    });
}
onSocket('facetBlink', ({ payload }) => { if (isActiveGM()) blink(payload).catch(error => console.error(`${MODULE_ID} | огранка: выброс`, error)); });
async function blink({ messageId, sceneId, tokenId, actorId, x, y, feet }) {
    const scene = game.scenes.get(sceneId), token = scene?.tokens.get(tokenId), size = scene?.grid.size;
    if (!token) return;
    await jump(token, x - (token.width || 1) * size / 2, y - (token.height || 1) * size / 2);
    await game.messages.get(messageId)?.setFlag(MODULE_ID, 'facetBlinkDone', true);
    await noteCard(game.actors.get(actorId), t('Выброс'), t('{v} перенёсся на {feet} футов — способность применяется отсюда: бросайте атаку или урон из карточки. Он остаётся здесь, рядом с теми, кого задел.', { v: esc(token.name), feet }));
}

/**
 * На бегу: срабатывает от применения — считается только движение после него, до половины скорости. Прицел сам переходит
 * на всех, мимо кого герой прошёл (в 5 фт от пути, с диагональю). Забег живёт у применившего клиента и заканчивается
 * его броском атаки или урона, новым применением или концом хода
 */
const RUNS = new Map();
const turnKey = () => game.combat?.started ? `${game.combat.id}.${game.combat.round}.${game.combat.turn}` : null;
Hooks.on('dnd5e.postUseActivity', (activity, usage, results) => {
    const actor = activity?.item?.actor, message = results?.message;
    if (!actor || !stonesFor(activity).includes('run')) return;
    const caster = tokenOf(actor)?.document;
    if (!caster) return;
    // Скорость 0 (схвачен, опутан) — бежать некуда
    const speed = Number(actor.system.attributes?.movement?.walk ?? 30) || 0;
    RUNS.set(caster.id, { key: turnKey(), left: Math.floor(speed / 2), hit: new Set(), message });
    message?.setFlag?.(MODULE_ID, 'facetRun', '');
});
Hooks.on('moveToken', (token, movement, operation) => {
    const run = RUNS.get(token.id);
    if (!run) return;
    if (run.key !== turnKey()) return void RUNS.delete(token.id);
    const scene = token.parent, size = scene.grid.size, ftPerPx = scene.grid.distance / size;
    const w = (token.width || 1) * size, h = (token.height || 1) * size;
    const pool = scene.tokens.filter(t => t.id !== token.id && t.actor && !t.hidden && !isDead(t.actor));
    let at = movement?.origin ?? { x: token.x, y: token.y };
    for (const p of pathOf(token, movement, operation)) {
        if (p.jump) { at = p; continue; }
        run.left -= Math.hypot(p.x - at.x, p.y - at.y) * ftPerPx;
        if (run.left < -0.01) break;
        at = p;
        const cx = p.x + w / 2, cy = p.y + h / 2;
        for (const t of pool) if (cx >= t.x - size && cx < t.x + (t.width || 1) * size + size && cy >= t.y - size && cy < t.y + (t.height || 1) * size + size) run.hit.add(t.id);
    }
    const hit = pool.filter(t => run.hit.has(t.id));
    if (!hit.length) return;
    hit.forEach((t, i) => t.object?.setTarget(true, { releaseOthers: i === 0 }));
    run.message?.setFlag?.(MODULE_ID, 'facetRun', hit.map(t => t.name).join(', '));
});
const endRun = (rolls, data) => {
    const activity = data?.subject;
    if (!stonesFor(activity).includes('run')) return;
    const id = tokenOf(activity.item.actor)?.document?.id;
    if (id) RUNS.delete(id);
};
Hooks.on('dnd5e.rollAttackV2', endRun);
Hooks.on('dnd5e.rollDamageV2', endRun);

/** Рокировка: цели способности в 15 фт — на выбор; меняется местами Мастер */
async function swapDialog(message, actor) {
    const caster = tokenOf(actor)?.document, combat = game.combat;
    if (!caster) return ui.notifications.warn(t('Герой не на сцене.'));
    const key = combat?.started ? `${combat.round}.${combat.turn}` : null;
    if (key && actor.getFlag(MODULE_ID, 'facetSwap') === key) return ui.notifications.warn(t('Рокировка — раз за ход.'));
    const aimed = new Set([...game.user.targets].map(tok => tok.id));
    const pool = around(caster, 15).filter(tok => aimed.has(tok.id));
    if (!pool.length) return ui.notifications.warn(t('В 15 футах нет целей этой способности.'));
    const pick = await foundry.applications.api.DialogV2.wait({
        window: { title: t('Рокировка') },
        content: t('<p>С кем поменяться местами?</p>'),
        buttons: pool.map(tok => ({ action: tok.id, label: tok.name })),
        rejectClose: false
    }).catch(() => null);
    if (!pick) return;
    if (key) await actor.setFlag(MODULE_ID, 'facetSwap', key);
    requestGM('facetSwap', { sceneId: caster.parent.id, a: caster.id, b: pick, actorId: actor.id });
}
onSocket('facetSwap', ({ payload }) => { if (isActiveGM()) swapPlaces(payload).catch(error => console.error(`${MODULE_ID} | огранка: рокировка`, error)); });
async function swapPlaces({ sceneId, a, b, actorId }) {
    const scene = game.scenes.get(sceneId), x = scene?.tokens.get(a), y = scene?.tokens.get(b);
    if (!x || !y) return;
    const [ax, ay, bx, by] = [x.x, x.y, y.x, y.y];
    await jump(x, bx, by);
    await jump(y, ax, ay);
    await noteCard(game.actors.get(actorId), t('Рокировка'), t('{v} и {v2} поменялись местами.', { v: esc(x.name), v2: esc(y.name) }));
}

// ==========================================
// СТАЛЬ: Выверено — среднее вместо костей
// ==========================================

const average = formula => String(formula).replace(/(\d*)d(\d+)/gi, (m, n, f) => String(Math.ceil((Number(n) || 1) * (Number(f) + 1) / 2)));
Hooks.on('dnd5e.preRollDamageV2', config => {
    if (!stonesFor(config?.subject).includes('steady')) return;
    for (const roll of config.rolls ?? []) roll.parts = (roll.parts ?? []).map(average);
});
/** Есть ли у способности кости урона: «+1» безоружного удара — не кость; значение из @ может быть костью */
const hasDamageDice = activity => (activity?.damage?.parts ?? []).some(part => /\dd\d|\bd\d|@/i.test(String(part.formula ?? '')));
Hooks.on('dnd5e.preRollAttackV2', config => {
    const activity = config?.subject;
    if (!stonesFor(activity).includes('steady') || hasDamageDice(activity)) return;
    for (const roll of config.rolls ?? []) Object.assign((roll.options ??= {}), { minimum: 10, maximum: 10 });
});

// ==========================================
// ХОДЫ: Раскат и мины — в начале хода героя
// ==========================================

Hooks.on('combatTurnChange', (combat, prev, cur) => {
    if (!isActiveGM() || !combat?.started) return;
    startTurn(combat.combatants.get(cur?.combatantId)).catch(error => console.error(`${MODULE_ID} | огранка: ход`, error));
});
async function startTurn(combatant) {
    const actor = combatant?.actor;
    if (!actor) return;
    // Клетка начала хода — для Разбега
    const token = combatant.token, combat = combatant.parent;
    if (token && facetablesWith(actor, 'charge')) {
        const c = centerOf(token);
        await token.setFlag(MODULE_ID, 'turnStart', { x: c.x, y: c.y, round: combat.round, turn: combat.turn });
    }
    const echo = actor.getFlag(MODULE_ID, 'facetEcho');
    if (echo?.length) {
        await actor.unsetFlag(MODULE_ID, 'facetEcho');
        for (const e of echo) {
            const victims = (await Promise.all(e.targets.map(tokenFrom))).filter(t => t?.actor && !isDead(t.actor));
            await effectCard(actor, { title: t('Раскат — {name}', { name: e.name }), victims, amount: e.amount, type: e.type, heal: e.heal, check: e.check,
                why: t('Раскат: начался ваш ход — те же цели получают ещё половину.') });
        }
    }
    const scene = combatant.token?.parent;
    for (const mine of (scene?.getFlag(MODULE_ID, 'facetMines') ?? []).filter(m => m.payload.actorId === actor.id)) await detonateMine(scene, mine.id);
}
// Конец боя: Раскат и мины уходят
Hooks.on('deleteCombat', combat => {
    if (!isActiveGM()) return;
    (async () => {
        for (const combatant of combat.combatants) {
            const actor = combatant.actor;
            if (!actor) continue;
            if (actor.getFlag(MODULE_ID, 'facetEcho')) await actor.unsetFlag(MODULE_ID, 'facetEcho');
        }
        if (combat.scene?.getFlag(MODULE_ID, 'facetMines')?.length) await combat.scene.unsetFlag(MODULE_ID, 'facetMines');
    })().catch(error => console.error(`${MODULE_ID} | огранка: конец боя`, error));
});

// ==========================================
// ЧАТ: строка огранки в карточке способности, кнопки камней
// ==========================================

onRenderChatMessage((message, html) => {
    if (!html?.querySelector) return;
    bindStoneButtons(message, html);
    if (html.querySelector('.gd-facet-line') || (message.type !== 'usage' && message.getFlag?.('dnd5e', 'messageType') !== 'usage')) return;
    const activity = messageActivity(message);
    const stones = activity ? stonesFor(activity) : [];
    if (!stones.length) return;
    const actor = activity.item.actor;
    const line = document.createElement('div');
    line.className = 'gd-facet-line';
    line.innerHTML = `<i class="fas fa-gem"></i> ${t('Огранка: {v}', { v: stones.map(id => `<span data-tooltip="${esc(STONES[id].text)}">${gem(id)}<b>${STONES[id].name}</b></span>`).join(', ') })}`
        + (message.getFlag(MODULE_ID, 'facetCharge') ? t(' · <b>Разбег</b>: атака с преимуществом, спасбросок цели с помехой') : '')
        + (message.getFlag(MODULE_ID, 'facetRun') === undefined ? '' : message.getFlag(MODULE_ID, 'facetRun')
            ? ` · <b>${t('На бегу')}</b>${t(': цели — все, мимо кого вы прошли: {v}', { v: esc(message.getFlag(MODULE_ID, 'facetRun')) })}`
            : t(' · <b>На бегу</b>: можно пройти до половины скорости, цели станут все, мимо кого вы пройдёте; это перемещение всегда провоцирует атаки по возможности'))
        + (stones.includes('pay') && actor?.isOwner && !message.getFlag(MODULE_ID, 'facetPaidHere')
            ? ` <button type="button" class="gd-stone-pay"><i class="fas fa-droplet"></i> ${t('Без траты действия — {v} ПЗ', { v: bloodCost(message, actor) })}</button>` : '')
        + (stones.includes('swap') && actor?.isOwner ? ` <button type="button" class="gd-stone-swap"><i class="fas fa-people-arrows"></i> ${t('Рокировка')}</button>` : '')
        + (stones.includes('cast') && actor?.isOwner && !message.getFlag(MODULE_ID, 'facetBlinkDone')
            ? ` <button type="button" class="gd-stone-blink" data-tooltip="${t('Сначала перенос в клетку в 30 футах, ближе к цели, потом бросок — уже оттуда')}"><i class="fas fa-person-running"></i> ${t('Выброс: перенестись')}</button>` : '');
    line.querySelector('.gd-stone-pay')?.addEventListener('click', event => { event.preventDefault(); event.currentTarget.disabled = true; payBlood(message, actor); });
    line.querySelector('.gd-stone-swap')?.addEventListener('click', event => { event.preventDefault(); swapDialog(message, actor); });
    line.querySelector('.gd-stone-blink')?.addEventListener('click', event => { event.preventDefault(); blinkPick(message, actor); });
    // Содержимое карточки dnd5e перерисовывает после хука — строка под шапкой сообщения
    const header = html.querySelector('.message-header');
    if (header) header.after(line); else html.prepend(line);
});

function bindStoneButtons(message, html) {
    const pass = message.getFlag?.(MODULE_ID, 'facetPass');
    if (pass) {
        const owner = game.user.isGM || game.actors.get(pass.actorId)?.isOwner;
        html.querySelectorAll('[data-gd-pass]').forEach(b => {
            b.disabled = !owner || pass.used;
            b.classList.toggle('on', pass.used);
            b.addEventListener('click', event => { event.preventDefault(); requestGM('facetPassPick', { messageId: message.id }); });
        });
    }
    const mine = message.getFlag?.(MODULE_ID, 'facetMine');
    if (mine) {
        const actor = game.actors.get(mine.payload.actorId);
        const owner = game.user.isGM || actor?.isOwner;
        html.querySelectorAll('[data-gd-mine]').forEach(b => {
            b.disabled = !owner || mine.state !== 'wait';
            b.classList.toggle('on', (mine.state === 'placed' && b.dataset.gdMine === 'place') || (mine.state === 'now' && b.dataset.gdMine === 'now'));
            b.addEventListener('click', event => {
                event.preventDefault();
                if (b.dataset.gdMine === 'now') requestGM('facetMineNow', { messageId: message.id });
                else pickPoint(actor, message.id, mine.payload.reach ?? 30);
            });
        });
    }
}
