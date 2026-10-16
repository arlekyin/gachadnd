// Дымовая проверка всех навыков компендиума: node tools/foundry/smoke.mjs [--only=Имя,Имя] [--click | --clicks=N] [--headed]
// Каждый навык по очереди выдаётся герою, экипируется и применяется по ближнему врагу. Окна
// использования подтверждаются; навык, который ждёт клика по сцене, отменяется и помечается.
// Итог — навыки с ошибками, с устаревшими вызовами Foundry/dnd5e из кода модуля и «ждёт мыши».
// Механику навыков не проверяет: это сито перед ручной проверкой и прогоном после обновлений.
import { connect, args, done } from './harness.mjs';
import { install, scene, skills } from './fixtures.mjs';

const f = await connect();
const { page } = f;
await install(page);
const ids = await scene(page, {
    hero: { level: 10 },
    enemies: [{ name: 'Цель', x: 6, y: 5 }, { name: 'Второй', x: 7, y: 6 }, { name: 'Союзник', x: 4, y: 5, disposition: 1 }]
});

const only = args().only ? String(args().only).split(',') : null;
const names = (await page.evaluate(async () => {
    const pack = game.packs.get('gachadnd.gacha-skills');
    const index = await pack.getIndex({ fields: ['flags.gachadnd.rarity', 'system.activities'] });
    return index.filter(i => i.flags?.gachadnd?.rarity).map(i => i.name).sort();
})).filter(n => !only || only.includes(n));
console.log(`Навыков: ${names.length}`);

const ours = line => /modules\/gachadnd\//.test(line) || /gachadnd/i.test(line);
const rows = [];
for (const name of names) {
    const from = f.log.length;
    let note = '';
    try {
        // Чистый герой: без навыков Памяти, полные ПЗ, цель — ближний враг, токен выбран.
        // Пауза: dnd5e ещё дописывает заряды прошлого навыка — удалить его раньше значит гонку на сервере
        await page.waitForTimeout(700);
        await page.evaluate(async ({ hero, enemy }) => {
            const actor = game.actors.get(hero);
            const old = actor.items.filter(i => i.flags?.gachadnd?.rarity).map(i => i.id);
            if (old.length) await actor.deleteEmbeddedDocuments('Item', old);
            const regions = canvas.scene.regions.map(r => r.id);
            if (regions.length) await canvas.scene.deleteEmbeddedDocuments('Region', regions);
            const tiles = canvas.scene.tiles.map(t => t.id);
            if (tiles.length) await canvas.scene.deleteEmbeddedDocuments('Tile', tiles);
            const extra = canvas.scene.tokens.filter(t => t.flags?.gachadnd?.cat?.originalId || !t.actor).map(t => t.id);
            if (extra.length) await canvas.scene.deleteEmbeddedDocuments('Token', extra);
            await actor.update({ 'system.attributes.hp.value': actor.system.attributes.hp.max });
            for (const id of [enemy]) {
                const a = game.actors.get(id);
                await a.update({ 'system.attributes.hp.value': a.system.attributes.hp.max });
            }
            actor.getActiveTokens()[0]?.control({ releaseOthers: true });
            canvas.tokens.setTargets([game.actors.get(enemy).getActiveTokens()[0].id]);
            await gdt.closeForeign();
            gdt.mark();
        }, { hero: ids.hero, enemy: ids.enemies[0] });
        const id = (await skills(page, ids.hero, [name]))[name];
        const snap = () => page.evaluate(hero => {
            const t = game.actors.get(hero).getActiveTokens()[0]?.document;
            const sc = canvas.scene;
            return { regions: sc.regions.size, at: t ? `${t.x},${t.y}` : '', chat: game.messages.size,
                warnings: gdt.warnings.length, docs: { токенов: sc.tokens.size, тайлов: sc.tiles.size, стен: sc.walls.size, рисунков: sc.drawings.size, света: sc.lights.size } };
        }, ids.hero);
        const was = await snap();
        const before = (await page.evaluate(() => gdt.windows())).map(w => w.id);
        await page.evaluate(({ hero, id }) => {
            const act = game.actors.get(hero).items.get(id).system.activities.contents[0];
            gdt.smoke = { done: false, result: null };
            if (!act) { gdt.smoke = { done: true, result: 'нет активности' }; return; }
            Promise.resolve(act.use()).then(r => { gdt.smoke = { done: true, result: r == null ? String(r) : typeof r }; },
                e => { gdt.smoke = { done: true, result: `ошибка: ${e?.message ?? e}` }; });
        }, { hero: ids.hero, id });
        const seen = new Set(before);
        const end = Date.now() + 5000;
        let quietFrom = Date.now();
        while (Date.now() < end) {
            const ws = (await page.evaluate(() => gdt.windows())).filter(w => !seen.has(w.id));
            for (const w of ws) {
                seen.add(w.id);
                quietFrom = Date.now();
                const sel = `#${w.id}`;
                for (const action of ['use', 'ok', 'yes', 'confirm', 'submit']) {
                    const button = await page.$(`${sel} button[data-action="${action}"], ${sel} button[type="submit"]`);
                    if (button) { await button.click().catch(() => {}); break; }
                }
            }
            const state = await page.evaluate(() => gdt.smoke);
            if (state.done && Date.now() - quietFrom > 800) break;
            await page.waitForTimeout(150);
        }
        let state = await page.evaluate(() => gdt.smoke);
        // --click: навык мог ждать клика по сцене и после возврата use() (выбор клетки модуля) —
        // щёлкнуть по свободной клетке над героем, затем дать хукам доработать
        if (args().click || args().clicks) {
            // Свободные клетки над героем: (5,4), (3,3), (6,2)
            const cells = [[550, 450], [350, 350], [650, 250]].slice(0, Number(args().clicks) || 1);
            for (const [x, y] of cells) {
                await page.waitForTimeout(600);
                const p = await page.evaluate(q => { const c = canvas.clientCoordinatesFromCanvas(q); return { x: c.x, y: c.y }; }, { x, y });
                await page.mouse.move(p.x - 30, p.y - 30);
                await page.mouse.move(p.x, p.y, { steps: 6 });
                await page.waitForTimeout(250);
                if (args().debug) console.log('   под курсором:', await page.evaluate(p => { const e = document.elementFromPoint(p.x, p.y); return `${e?.tagName}#${e?.id}.${e?.className}`; }, p), JSON.stringify(p));
                await page.mouse.down();
                await page.mouse.up();
            }
            await page.waitForTimeout(1500);
            for (let i = 0; i < 20 && !(await page.evaluate(() => gdt.smoke.done)); i++) await page.waitForTimeout(150);
            state = await page.evaluate(() => gdt.smoke);
            if (state.done) note = `клик по клетке ×${cells.length}`;
            // Выбор, который всё ещё ждёт клика, не должен достаться следующему навыку
            await page.keyboard.press('Escape');
            // Esc без активного выбора открывает главное меню Foundry — закрыть
            await page.waitForTimeout(200);
            await page.evaluate(() => ui.menu?.rendered && ui.menu.close());
        }
        if (!state.done) {
            // Ждёт клика по сцене (шаблон, клетка, токен) — отменить
            note = 'ждёт мыши';
            await page.keyboard.press('Escape');
            const p = await page.evaluate(() => { const c = canvas.clientCoordinatesFromCanvas({ x: 1500, y: 1200 }); return { x: c.x, y: c.y }; });
            await page.mouse.click(p.x, p.y, { button: 'right' });
            await page.evaluate(() => ui.menu?.rendered && ui.menu.close());
            await page.waitForTimeout(800);
            state = await page.evaluate(() => gdt.smoke);
        }
        await page.evaluate(async () => {
            await gdt.settle();
            for (const w of foundry.applications.instances.values()) if (/Dialog/.test(w.constructor.name)) await w.close().catch(() => {});
        });
        const now = await snap();
        const trace = [now.regions !== was.regions && `регионов ${was.regions}→${now.regions}`, now.at !== was.at && 'герой сдвинут',
            now.chat > was.chat && `чат +${now.chat - was.chat}`,
            ...Object.keys(now.docs).filter(k => now.docs[k] !== was.docs[k]).map(k => `${k} ${was.docs[k]}→${now.docs[k]}`)].filter(Boolean).join(', ');
        const warned = await page.evaluate(n => gdt.warnings.slice(n), was.warnings);
        note = [note, state.done ? `use() → ${state.result}` : 'use() не вернулся', trace, ...warned.map(w => `«${String(w).slice(0, 90)}»`)].filter(Boolean).join('; ');
    } catch (error) {
        note = `упала: ${error.message.split('\n')[0]}`;
    }
    if (args().debug) console.log('   после:', JSON.stringify(await page.evaluate(() => {
        const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        return { center: `${e?.tagName}#${e?.id}.${String(e?.className).slice(0, 60)}`, windows: gdt.windows().map(w => `${w.cls}:${w.title}`),
            stage: { x: canvas.stage.position.x, rot: canvas.stage.rotation, pivot: canvas.stage.pivot.x }, layer: canvas.activeLayer?.constructor.name };
    })));
    const lines = f.log.slice(from);
    const errors = lines.filter(l => /^pageerror|^error/.test(l) && ours(l) && !/fifthpendium|combatbooster/.test(l));
    const deprecated = [...new Set(lines.filter(l => /deprecated|устарел/i.test(l) && /modules\/gachadnd\//.test(l)).map(l => l.split('\n')[0].slice(0, 160)))];
    const bad = errors.length || deprecated.length || /ждёт|не вернулся|упала|ошибка/.test(note);
    rows.push({ name, note, errors, deprecated });
    console.log(`${bad ? '✘' : '✔'} ${name} — ${note}`);
    for (const e of errors) console.log(`     ошибка: ${e.split('\n')[0].slice(0, 220)}`);
    for (const d of deprecated) console.log(`     устарело: ${d}`);
}

const problems = rows.filter(r => r.errors.length || r.deprecated.length || /ждёт|не вернулся|упала|ошибка/.test(r.note));
console.log(`\nИтог: ${rows.length - problems.length}/${rows.length} без замечаний`);
await f.close();
done(problems.some(r => r.errors.length || /упала/.test(r.note)));
