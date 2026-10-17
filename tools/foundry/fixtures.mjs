/**
 * Фикстуры проверок в Foundry: сцена, персонаж, враги, навыки и помощники в странице (window.gdt).
 *
 * Всё создаётся с префиксом «GD-тест» и пересоздаётся при каждом запуске, поэтому проверки не зависят
 * от прошлых прогонов. Навыки кладутся тем же путём, что и в игре: addSkillToMemory из компендиума,
 * затем setSkillEquipped и пересчёт синергий, как в Терминале.
 */

export const PREFIX = 'GD-тест';

/** Установить window.gdt: помощники для кода проверок в странице */
export async function install(page) {
    await page.evaluate(() => {
        const MODULE = 'gachadnd';
        const queue = [];
        // Настоящий генератор — один раз на страницу: под раннером install() зовут много раз
        CONFIG.Dice._gdtOriginal ??= CONFIG.Dice.randomUniform;
        const original = CONFIG.Dice._gdtOriginal;
        CONFIG.Dice.randomUniform = original;
        window.gdt = {
            MODULE,
            /** Модуль по пути от корня модуля — тот же экземпляр, что загрузила Foundry */
            mod: path => import(`/modules/${MODULE}/scripts/${path}`),
            /** Шаблоны сцены: v13 — MeasuredTemplate, v14 — Регионы (туда влиты шаблоны dnd5e) */
            templates: sceneId => [...(game.release.generation >= 14 ? game.scenes.get(sceneId).regions : game.scenes.get(sceneId).templates)],
            /** Предпросмотр шаблона dnd5e на сцене (ждём его, прежде чем кликать) */
            previewing: () => (canvas.regions?.preview?.children?.length || canvas.templates?.preview?.children?.length) > 0,
            /**
             * Подложить результаты костей: gdt.dice(100, 18, 33) — следующие к100 дадут 18, затем 33.
             * Каждый вызов заменяет очередь; после неё кости бросаются как обычно.
             */
            dice(faces, ...values) {
                // Очередь заменяется: остатки прошлых подложенных костей не достаются чужому броску
                queue.length = 0;
                queue.push(...values.map(v => ({ faces, v })));
                CONFIG.Dice.randomUniform = function () {
                    // DiceTerm v13: Math.ceil((1 - randomUniform()) * faces); грань знает только
                    // вызывающий — поэтому очередь отдаёт значение, верное для объявленной грани
                    const next = queue.shift();
                    if (!next) { CONFIG.Dice.randomUniform = original; return original(); }
                    if (!queue.length) CONFIG.Dice.randomUniform = original;
                    return 1 - (next.v - 0.5) / next.faces;
                };
            },
            /** Дописать кости в очередь, не сбрасывая её: gdt.dice(20, 19); gdt.queue(6, 4, 4) */
            queue(faces, ...values) {
                const rest = queue.splice(0);
                gdt.dice(faces, ...values);
                queue.unshift(...rest);
            },
            resetDice() { queue.length = 0; CONFIG.Dice.randomUniform = original; },
            sleep: ms => new Promise(r => setTimeout(r, ms)),
            /** Последнее изменение документов мира (бой, персонажи, токены, чат, эффекты, сцена) */
            lastChange: performance.now(),
            /**
             * Дождаться тишины: quiet мс без изменений документов (не меньше min, не дольше max). Замена
             * фиксированных пауз: хуки модуля у Мастера дописывают флаги и сообщения после действия.
             */
            async settle(quiet = 250, max = 4000, min = 100) {
                const t0 = performance.now();
                await gdt.sleep(min);
                while (performance.now() - t0 < max) {
                    if (performance.now() - gdt.lastChange >= quiet) return true;
                    await gdt.sleep(40);
                }
                return false;
            },
            async until(fn, ms = 5000, step = 100) {
                const end = Date.now() + ms;
                while (Date.now() < end) { const v = await fn(); if (v) return v; await gdt.sleep(step); }
                return null;
            },
            /** Сообщения чата с момента mark() */
            mark() { gdt._mark = game.messages.contents.length; },
            chats() { return game.messages.contents.slice(gdt._mark ?? 0).map(m => m.content + ' ' + (m.flavor ?? '')); },
            warnings: [],
            /** Открытые окна приложений: id, заголовок, класс */
            windows() {
                return [...foundry.applications.instances.values()].filter(a => a.rendered)
                    .map(a => ({ id: a.id, title: a.title, cls: a.constructor.name }));
            }
        };
        // Тишина для settle(): любое изменение документов отодвигает её (хуки — один раз на страницу)
        if (!window._gdtSettleHooks) {
            const touch = () => { if (window.gdt) window.gdt.lastChange = performance.now(); };
            for (const doc of ['Combat', 'Combatant', 'Actor', 'Item', 'Token', 'ChatMessage', 'ActiveEffect', 'Scene', 'Wall', 'AmbientLight', 'MeasuredTemplate', 'Region']) {
                for (const verb of ['create', 'update', 'delete']) Hooks.on(`${verb}${doc}`, touch);
            }
            window._gdtSettleHooks = true;
        }
        // Окна других модулей (журналы изменений и т. п.) перекрывают HUD и кнопки; открываются с задержкой
        gdt.closeForeign = async () => {
            for (const app of [...foundry.applications.instances.values()]) {
                if (app.rendered && app.hasFrame && !String(app.id).startsWith(MODULE)) await app.close();
            }
            for (const app of Object.values(ui.windows)) await app.close();
            document.querySelectorAll('#laaru-changelog').forEach(el => el.remove());
        };
        gdt.closeForeign();
        // Предупреждения ui.notifications — для проверок отказов
        if (!ui.notifications._gdtWrapped) {
            const warn = ui.notifications.warn.bind(ui.notifications);
            ui.notifications.warn = (msg, ...rest) => { gdt.warnings.push(String(msg)); return warn(msg, ...rest); };
            ui.notifications._gdtWrapped = true;
        } else gdt.warnings = [];
    });
}

/**
 * Пересоздать сцену, героя и врагов. Возвращает id: { scene, hero, enemies: [...] }.
 * @param {object} opts  { enemies: [{ name, x, y, wis, ac, traits, disposition }], hero: { x, y, cha, ac, level } } — клетки
 *   сетки; walls: [{ c: [x0, y0, x1, y1] в клетках, door }]; lights: [{ x, y, bright, dim }] в клетках и футах;
 *   dark: true — на сцене ночь (глобальный свет не горит)
 */
export async function scene(page, opts = {}) {
    return page.evaluate(async ({ PREFIX, opts }) => {
        // Чужие хуки после использования навыка (Combat Booster пишет флаг персонажу) успевают до удаления
        await new Promise(r => setTimeout(r, 1000));
        // Бои и документы прошлого прогона
        for (const c of game.combats.filter(c => c.scene?.name?.startsWith(PREFIX) || !c.scene)) await c.delete();
        // Хуки конца боя (аура гаснет) успевают обновить персонажей до удаления
        await new Promise(r => setTimeout(r, 800));
        const old = s => s.name?.startsWith(PREFIX);
        await Actor.deleteDocuments(game.actors.filter(old).map(a => a.id));
        await Scene.deleteDocuments(game.scenes.filter(old).map(s => s.id));
        await ChatMessage.deleteDocuments(game.messages.map(m => m.id));

        const grid = 100;
        const scene = await Scene.create({
            name: `${PREFIX}: сцена`, width: 2000, height: 1400, padding: 0,
            grid: { type: 1, size: grid, distance: 5, units: 'ft' },
            tokenVision: false, fog: { exploration: false },
            environment: opts.dark
                ? { darknessLevel: 1, globalLight: { enabled: true, darkness: { min: 0, max: 0.5 } } }
                : { darknessLevel: 0, globalLight: { enabled: true } }
        });
        if (opts.walls?.length) await scene.createEmbeddedDocuments('Wall', opts.walls.map(w => ({ c: w.c.map(v => v * grid), door: w.door ?? 0 })));
        if (opts.lights?.length) await scene.createEmbeddedDocuments('AmbientLight', opts.lights.map(l => ({
            x: l.x * grid, y: l.y * grid, config: { bright: l.bright ?? 10, dim: l.dim ?? 20 }
        })));
        const h = opts.hero ?? {};
        const hero = await Actor.create({
            name: `${PREFIX}: Герой`, type: 'character',
            system: {
                abilities: { cha: { value: h.cha ?? 16 }, wis: { value: 10 }, dex: { value: 14 }, str: { value: 14 } },
                // КД по умолчанию (10 + Ловкость): у flat dnd5e не прибавляет ac.bonus
                attributes: { hp: { value: 60, max: 60 }, ac: { calc: h.ac ?? 'default' } }
            },
            prototypeToken: { actorLink: true, disposition: 1 },
            ownership: { default: 0 }
        });
        // Уровень персонажа (и бонус мастерства) — через класс, как в игре
        if (h.level) await hero.createEmbeddedDocuments('Item', [{
            name: 'Воин', type: 'class', system: { identifier: 'fighter', levels: h.level, hd: { denomination: 'd10' } }
        }]);
        const enemies = [];
        for (const [i, e] of (opts.enemies ?? [{}]).entries()) {
            enemies.push(await Actor.create({
                name: `${PREFIX}: ${e.name ?? `Враг ${i + 1}`}`, type: 'npc',
                system: {
                    abilities: { wis: { value: e.wis ?? 10 } },
                    attributes: { hp: { value: 30, max: 30 }, ac: { calc: 'flat', flat: e.ac ?? 12 } },
                    details: { cr: 1 },
                    ...(e.traits ? { traits: e.traits } : {})
                },
                prototypeToken: { actorLink: true, disposition: e.disposition ?? -1 }
            }));
        }
        const at = (actor, x, y) => ({ ...actor.prototypeToken.toObject(), actorId: actor.id, name: actor.name, x: x * grid, y: y * grid });
        await scene.createEmbeddedDocuments('Token', [
            at(hero, h.x ?? 5, h.y ?? 5),
            ...enemies.map((a, i) => at(a, opts.enemies?.[i]?.x ?? 7 + i, opts.enemies?.[i]?.y ?? 5))
        ]);
        await scene.activate();
        await scene.view();
        // Canvas дорисовывает токены не сразу
        for (let i = 0; i < 50 && canvas.tokens?.placeables?.length < 1 + enemies.length; i++) await new Promise(r => setTimeout(r, 100));
        return { scene: scene.id, hero: hero.id, enemies: enemies.map(a => a.id) };
    }, { PREFIX, opts });
}

/** Положить навыки из компендиума и экипировать: возвращает { имя: itemId } */
export async function skills(page, actorId, names, { equip = true } = {}) {
    return page.evaluate(async ({ actorId, names, equip }) => {
        const actor = game.actors.get(actorId);
        const inv = await gdt.mod('memory/inventory.js');
        const syn = await gdt.mod('memory/synergy/synergy.js');
        const ids = {};
        for (const name of names) {
            const before = new Set(actor.items.map(i => i.id));
            await inv.addSkillToMemory(actor, name, { forced: true });
            const item = actor.items.find(i => !before.has(i.id));
            if (!item) throw new Error(`Навык «${name}» не добавился`);
            if (equip) await syn.setSkillEquipped(item, true);
            ids[name] = item.id;
        }
        // Как Терминал после экипировки (terminal.js): синергии пересчитываются явно
        if (equip) await syn.updateActorSynergies(actor);
        return ids;
    }, { actorId, names, equip });
}

/**
 * Использовать навык как кнопкой на листе: activity.use() без настроек. Окна по ходу закрываются:
 * окно использования dnd5e — «Использовать», окно с выбором (select[name]) — значением из select,
 * остальные DialogV2 — кнопкой ok. Конец — use() вернулся, новых окон нет, документы затихли.
 * Возвращает, что вернул use(), и какие окна были.
 */
export async function use(page, actorId, itemId, { select = {}, timeout = 6000 } = {}) {
    const windows = () => page.evaluate(() => gdt.windows());
    const before = (await windows()).map(w => w.id);
    let finished = false;
    const result = page.evaluate(async ({ actorId, itemId }) => {
        const item = game.actors.get(actorId).items.get(itemId);
        const r = await item.system.activities.contents[0].use();
        return r === undefined ? 'undefined' : r === null ? 'null' : r === false ? 'false' : 'object';
    }, { actorId, itemId }).finally(() => { finished = true; });
    const seen = [];
    let lastWindow = Date.now();
    const end = Date.now() + timeout;
    // Окна закрываются по мере появления; конец — use() вернулся, 700 мс нет новых окон и прошло
    // не меньше 1,2 с: окно выбора цели (Перезарядка, Батарея) открывается уже после возврата use()
    const start = Date.now();
    let quiet = 700;
    while (Date.now() < end && !(finished && Date.now() - lastWindow >= quiet && Date.now() - start >= 1200)) {
        for (const w of (await windows()).filter(w => !before.includes(w.id) && !seen.some(s => s.id === w.id))) {
            seen.push(w);
            lastWindow = Date.now();
            const sel = `#${w.id}`;
            if (await page.$(`${sel} select`)) quiet = 1500;
            for (const [name, value] of Object.entries(select)) {
                if (await page.$(`${sel} select[name="${name}"]`)) await page.selectOption(`${sel} select[name="${name}"]`, value);
            }
            if (await page.$(`${sel} button[data-action="use"]`)) await page.click(`${sel} button[data-action="use"]`);
            else if (await page.$(`${sel} button[data-action="ok"]`)) await page.click(`${sel} button[data-action="ok"]`);
        }
        await page.waitForTimeout(100);
    }
    const r = await result;
    // Хуки модуля у Мастера дописывают своё после использования
    await page.evaluate(() => gdt.settle());
    return { result: r, windows: seen.map(w => `${w.cls}: ${w.title}`) };
}

/** Бой: участники по порядку инициативы (первый — самый высокий), бой начат */
export async function combat(page, sceneId, actorIds) {
    return page.evaluate(async ({ sceneId, actorIds }) => {
        const s = game.scenes.get(sceneId);
        const combat = await Combat.create({ scene: sceneId, active: true });
        await combat.createEmbeddedDocuments('Combatant', actorIds.map((id, i) => ({
            tokenId: s.tokens.find(t => t.actorId === id).id, sceneId, actorId: id, initiative: 20 - i * 5
        })));
        await combat.startCombat();
        return combat.id;
    }, { sceneId, actorIds });
}

/**
 * Карточка взрыва модуля «как за столом»: цели бросают спасбросок (кнопка карточки), игрок — урон
 * (кнопка урона → окно настройки броска → «Бросить»), Мастер применяет урон каждому задетому:
 * успех спасброска — ½ (или 0, если half: false), осколки и владелец — ½.
 * @param {object} o
 * @param {Object<string, number>} o.saves  к20 спасброска по id персонажа (по умолчанию 10)
 * @param {number[][]} o.dice               кости урона: [[грань, значения…], …]
 * @param {boolean} o.apply                 применить урон (по умолчанию да)
 * @param {string} o.of                     карточка, где задет этот персонаж (id)
 * @param {string} o.title                  карточка с этим текстом
 * @returns {Promise<{ total, lost: Object<string, number>, saved: Object<string, boolean>, card }>} lost — по id персонажа
 */
export async function resolveBlast(page, { saves = {}, dice = [], apply = true, of = null, title = null } = {}) {
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(async () => { await gdt.closeForeign(); ui.sidebar.expand?.(); ui.sidebar.changeTab?.('chat', 'primary'); });
    await page.waitForTimeout(300);
    // Последняя карточка взрыва; of — где задет этот персонаж, title — текст в карточке
    const card = await ev(({ of, title }) => {
        const m = game.messages.contents.findLast(m => {
            const c = m.flags?.gachadnd?.blastCard;
            if (!c) return false;
            if (title && !m.content.includes(title)) return false;
            if (of && !(c.victims ?? []).some(id => game.scenes.get(c.sceneId)?.tokens.get(id)?.actor?.id === of)) return false;
            return true;
        });
        return m ? { id: m.id, ...m.flags.gachadnd.blastCard } : null;
    }, { of, title });
    if (!card) throw new Error('Нет карточки взрыва');
    const scene = id => ev(({ s, id }) => game.scenes.get(s)?.tokens.get(id)?.actor?.id ?? null, { s: card.sceneId, id });
    const victims = [];
    for (const id of card.victims ?? []) victims.push({ tokenId: id, actorId: await scene(id) });
    // Спасброски целей — кнопкой карточки (бросает каждая цель за себя)
    const saved = {};
    if (card.ability) {
        for (const v of victims) {
            const d20 = saves[v.actorId] ?? 10;
            saved[v.actorId] = await ev(async ({ s, tokenId, ability, dc, d20 }) => {
                const actor = game.scenes.get(s).tokens.get(tokenId).actor;
                gdt.dice(20, d20);
                const rolls = await actor.rollSavingThrow({ ability }, { configure: false });
                const r = Array.isArray(rolls) ? rolls[0] : rolls;
                await gdt.settle();
                return r.total >= dc;
            }, { s: card.sceneId, tokenId: v.tokenId, ability: card.ability, dc: card.dc, d20 });
        }
    }
    // Урон — кнопкой карточки и окном настройки броска dnd5e
    const count = await ev(() => game.messages.size);
    await ev(dice => { if (dice.length) { gdt.dice(...dice[0]); for (const d of dice.slice(1)) gdt.queue(...d); } }, dice);
    await page.$eval(`#chat [data-message-id="${card.id}"] a.roll-link-group[data-type="damage"] .roll-link`, el => el.click());
    await ev(() => gdt.until(() => [...foundry.applications.instances.values()].some(a => a.rendered && a.constructor.name === 'DamageRollConfigurationDialog'), 4000));
    await ev(() => {
        const app = [...foundry.applications.instances.values()].find(a => a.rendered && a.constructor.name === 'DamageRollConfigurationDialog');
        const buttons = [...app.element.querySelectorAll('button')];
        (buttons.find(b => /normal|roll/i.test(`${b.dataset.action} ${b.value}`)) ?? buttons.at(-1)).click();
    });
    // Бросок урона — первое новое сообщение с броском урона (в чат может прийти и другое)
    const isDamage = 'm => m.type === "damage" || m.rolls.some(r => r.constructor.name === "DamageRoll")';
    await ev(({ count, isDamage }) => gdt.until(() => game.messages.contents.slice(count).some(eval(isDamage)), 4000), { count, isDamage });
    const rolled = await ev(({ count, isDamage }) => { const m = game.messages.contents.slice(count).find(eval(isDamage)); return { id: m.id, total: m.rolls.reduce((s, r) => s + r.total, 0) }; }, { count, isDamage });
    const lost = {};
    if (apply) {
        const targets = [
            ...victims.map(v => ({ ...v, multiplier: card.ability && saved[v.actorId] ? (card.half === false ? 0 : 0.5) : 1 })),
            ...(card.splash ?? []).map(id => ({ tokenId: id, multiplier: 0.5 })),
            ...(card.self ? [{ actorId: card.self, multiplier: 0.5 }] : [])
        ];
        for (const t of targets) {
            const r = await ev(async ({ s, t, messageId }) => {
                const actor = t.tokenId ? game.scenes.get(s).tokens.get(t.tokenId)?.actor : game.actors.get(t.actorId);
                if (!actor) return null;
                const hp = () => (Number(actor.system.attributes.hp.value) || 0) + (Number(actor.system.attributes.hp.temp) || 0);
                const message = game.messages.get(messageId);
                const damages = message.rolls.map(r => ({ value: r.total, type: r.options.type }));
                const before = hp();
                // Как «Применить» в лотке dnd5e: множитель и сообщение броска в origin
                await actor.applyDamage(damages, { multiplier: t.multiplier, isDelta: true, origin: message, originatingMessage: message });
                await gdt.settle();
                return { id: actor.id, lost: before - hp() };
            }, { s: card.sceneId, t, messageId: rolled.id });
            if (r) lost[r.id] = (lost[r.id] ?? 0) + r.lost;
        }
    }
    return { total: rolled.total, lost, saved, card };
}
