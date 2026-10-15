/**
 * Фикстуры проверок в Foundry: сцена, персонаж, враги, навыки и помощники в странице (window.gdt).
 *
 * Всё создаётся с префиксом «GD-тест» и пересоздаётся при каждом запуске, поэтому проверки не зависят
 * от прошлых прогонов. Навыки кладутся тем же путём, что и в игре: addSkillToMemory из компендиума,
 * затем setSkillEquipped.
 */

export const PREFIX = 'GD-тест';

/** Установить window.gdt: помощники для кода проверок в странице */
export async function install(page) {
    await page.evaluate(() => {
        const MODULE = 'gachadnd';
        const queue = [];
        const original = CONFIG.Dice.randomUniform;
        window.gdt = {
            MODULE,
            /** Модуль по пути от корня модуля — тот же экземпляр, что загрузила Foundry */
            mod: path => import(`/modules/${MODULE}/scripts/${path}`),
            /**
             * Подложить результаты костей: gdt.dice(100, 18, 33) — следующие к100 дадут 18, затем 33.
             * Остальные кости бросаются как обычно.
             */
            dice(faces, ...values) {
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
            resetDice() { queue.length = 0; CONFIG.Dice.randomUniform = original; },
            sleep: ms => new Promise(r => setTimeout(r, ms)),
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
 * @param {object} opts  { enemies: [{ name, x, y, wis }] , hero: { x, y, cha } } — клетки сетки
 */
export async function scene(page, opts = {}) {
    return page.evaluate(async ({ PREFIX, opts }) => {
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
            tokenVision: false, fog: { exploration: false }, environment: { globalLight: { enabled: true } }
        });
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
        const enemies = [];
        for (const [i, e] of (opts.enemies ?? [{}]).entries()) {
            enemies.push(await Actor.create({
                name: `${PREFIX}: ${e.name ?? `Враг ${i + 1}`}`, type: 'npc',
                system: {
                    abilities: { wis: { value: e.wis ?? 10 } },
                    attributes: { hp: { value: 30, max: 30 }, ac: { calc: 'flat', flat: e.ac ?? 12 } },
                    details: { cr: 1 }
                },
                prototypeToken: { actorLink: true, disposition: -1 }
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
        return ids;
    }, { actorId, names, equip });
}
