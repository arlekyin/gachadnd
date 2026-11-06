// Новый забег в настоящей Foundry: node tools/foundry/newrun.mjs [--headed]
// Приветствие Мастеру при первом запуске с кнопкой; окно — отряд с уровнями (не 1 — предупреждение), режим карты,
// Якорь; «Начать» — сцена этажа с начерченным этажом 1, простая сцена Якоря, Якорь открыт, карточка в чат
// со ссылкой на «Памятку», у Мастера — «Первый забег». Страницы ссылаются на главы правил ([[…]] в src/rules).
// Игроку без персонажа (Claude_trusted) — выбор готового героя dnd5e: при «Начать» герой создан, его и назначен.
// В конце созданные сцены удаляются, настройки — как были.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);

await install(page);
const since = f.log.length;
// Что вернуть в конце: настройки и сцена, на которой был Мастер
const saved = await ev(() => ({
    settings: Object.fromEntries(['anchorSceneId', 'anchorOpen', 'mapMode', 'floorSceneId', 'runFloor', 'welcomeShown'].map(k => [k, game.settings.get('gachadnd', k)])),
    scene: canvas.scene?.id ?? null, active: game.scenes.active?.id ?? null
}));
// Отряд: герой игрока 3 уровня — предупреждение
const heroId = await ev(async () => {
    for (const a of game.actors.filter(a => a.name.startsWith('NR-тест'))) await a.delete();
    const player = game.users.getName('Claude_player');
    const hero = await Actor.create({ name: 'NR-тест: Герой', type: 'character', ownership: { default: 0, [player.id]: 3 } });
    await hero.createEmbeddedDocuments('Item', [{ name: 'Воин', type: 'class', system: { identifier: 'fighter', levels: 3, hd: { denomination: 'd10' } } }]);
    return hero.id;
});

// ---------- Приветствие
const welcome = await ev(async () => {
    await game.settings.set('gachadnd', 'welcomeShown', false);
    const m = await gdt.mod('labyrinth/new-run.js');
    const n = game.messages.size;
    await m.showWelcome();
    await new Promise(r => setTimeout(r, 600));
    const msg = game.messages.contents.slice(n).find(x => x.getFlag('gachadnd', 'welcome'));
    const again = await m.showWelcome();
    return { whisper: !!msg?.whisper?.length, button: /data-gd-new-run/.test(msg?.content ?? ''), once: again === undefined, shown: game.settings.get('gachadnd', 'welcomeShown') };
});
check('первый запуск: шёпот Мастеру с кнопкой «Новый забег», второй раз — нет', welcome.whisper && welcome.button && welcome.once && welcome.shown, JSON.stringify(welcome));

// ---------- Окно
const win = await ev(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    game.gachadnd.newRun(); await sleep(900);
    const el = foundry.applications.instances.get('gachadnd-new-run')?.element;
    const rows = [...el.querySelectorAll('.gd-nr-party li')].map(li => ({ text: li.textContent.replace(/\s+/g, ' ').trim(), warn: li.classList.contains('warn') }));
    const trusted = game.users.getName('Claude_trusted');
    const pick = el.querySelector(`select[name="hero-${trusted.id}"]`);
    const heroes = pick ? [...pick.options].filter(o => o.value).map(o => o.textContent) : [];
    if (pick) pick.value = pick.options[1]?.value ?? '';
    return { free: !!pick, heroes: heroes.length, chosen: pick?.selectedOptions[0]?.textContent ?? null, rows, modes: el.querySelectorAll('input[name="mode"]').length, anchor: [...el.querySelectorAll('select[name="anchor"] option')].map(o => o.value).slice(0, 2) };
});
const mine = win.rows.find(r => /NR-тест/.test(r.text));
check('окно: отряд с уровнями, у героя 3 уровня — предупреждение; ряды или паутина; Якорь — без сцены или создать',
    mine?.warn && /3 ур/.test(mine.text) && win.modes === 2 && win.anchor.join() === 'none,create', JSON.stringify(win));
check('игрок без персонажа — выбор из готовых героев dnd5e (12)', win.free && win.heroes >= 10 && win.chosen, JSON.stringify({ free: win.free, heroes: win.heroes, chosen: win.chosen }));
await f.shot('newrun-1-window');

// ---------- Начать: ряды на 6, простая сцена Якоря
const run = await ev(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const el = foundry.applications.instances.get('gachadnd-new-run').element;
    el.querySelector('input[name="mode"][value="rows"]').checked = true;
    el.querySelector('input[name="length"]').value = 6;
    el.querySelector('select[name="anchor"]').value = 'create';
    const n = game.messages.size;
    el.querySelector('button[type="submit"]').click();
    for (let i = 0; i < 60 && !game.settings.get('gachadnd', 'anchorOpen'); i++) await sleep(200);
    await sleep(1500);
    const floor = game.scenes.find(s => s.getFlag('gachadnd', 'newRun') === 'floor');
    const anchor = game.scenes.find(s => s.getFlag('gachadnd', 'newRun') === 'anchor');
    const map = floor?.getFlag('gachadnd', 'floorMap');
    const card = game.messages.contents.slice(n).find(m => /Забег начинается/.test(m.content));
    return {
        floor: floor?.name, remembered: game.settings.get('gachadnd', 'floorSceneId') === floor?.id, nodes: map?.nodes?.length ?? 0, rows: map ? Math.max(...map.nodes.map(x => x.row ?? x.layer ?? 0)) + 1 : 0,
        runFloor: game.settings.get('gachadnd', 'runFloor'), anchor: anchor?.name, anchorSetting: game.settings.get('gachadnd', 'anchorSceneId') === anchor?.id,
        anchorOpen: game.settings.get('gachadnd', 'anchorOpen'), here: canvas.scene?.id === anchor?.id,
        hero: (u => ({ name: u.character?.name ?? null, owner: !!u.character?.testUserPermission(u, 'OWNER'), level: u.character?.system?.details?.level, folder: u.character?.folder?.name ?? null }))(game.users.getName('Claude_trusted')),
        card: !!card, link: /@UUID\[Compendium\.gachadnd\.gacha-rules[^\]]*\]\{Памятка\}|content-link[^>]*>[^<]*Памятка/.test(card?.content ?? ''),
        guide: (sheet => sheet ? { page: sheet.document.pages.get(sheet.pageId ?? sheet.options?.pageId)?.name ?? null, text: /Шесть шагов/.test(sheet.element?.textContent ?? '') } : null)(
            [...foundry.applications.instances.values()].find(a => /Справочник Мастера/.test(a.title ?? '')))
    };
});
check('«Начать»: сцена «Лабиринт: этаж 1» — сцена карты, на ней начерчен этаж 1', run.floor === 'Лабиринт: этаж 1' && run.remembered && run.nodes > 5 && run.runFloor === 1, JSON.stringify(run));
check('простая сцена Якоря создана и выбрана в настройке; Якорь открыт, отряд перенесён на неё', run.anchor === 'Якорь' && run.anchorSetting && run.anchorOpen && run.here, JSON.stringify(run));
check(`готовый герой «${win.chosen}» создан, назначен Claude_trusted и принадлежит ему; 1 уровень, папка «Лабиринт: герои»`,
    run.hero.name === win.chosen && run.hero.owner && run.hero.level === 1 && run.hero.folder === 'Лабиринт: герои', JSON.stringify(run.hero));
check('в чат — «Забег начинается» со ссылкой на «Памятку»; у Мастера открыт «Первый забег»', run.card && run.link && run.guide?.page === 'Первый забег' && run.guide.text, JSON.stringify(run));
await f.shot('newrun-2-started');

// ---------- Страницы: ссылки на главы правил не битые
const pages = await ev(async () => {
    const out = {};
    for (const [pack, name] of [['gacha-gm', 'Первый забег'], ['gacha-rules', 'Памятка']]) {
        const [entry] = await game.packs.get(`gachadnd.${pack}`).getDocuments();
        const page = entry.pages.find(p => p.name === name);
        const html = await foundry.applications.ux.TextEditor.implementation.enrichHTML(page?.text?.content ?? '');
        const div = document.createElement('div'); div.innerHTML = html;
        const links = [...div.querySelectorAll('a.content-link')];
        out[name] = { first: entry.pages.contents.sort((a, b) => a.sort - b.sort)[0]?.name, links: links.length, broken: div.querySelectorAll('a.broken').length };
    }
    return out;
});
check('«Первый забег» и «Памятка» — первые страницы журналов, ссылки на главы целые',
    Object.entries(pages).every(([name, p]) => p.first === name && p.links >= 4 && !p.broken), JSON.stringify(pages));

// ---------- Уборка: сцены забега, герой, настройки — как были
await ev(async saved => {
    for (const a of foundry.applications.instances.values()) if (/Справочник|new-run/.test(a.title ?? a.id ?? '')) await a.close();
    await game.settings.set('gachadnd', 'anchorOpen', false);
    for (const [k, v] of Object.entries(saved.settings)) if (k !== 'anchorOpen') await game.settings.set('gachadnd', k, v);
    if (saved.active) await game.scenes.get(saved.active)?.activate();
    if (saved.scene) await game.scenes.get(saved.scene)?.view();
    for (const s of game.scenes.filter(s => s.getFlag('gachadnd', 'newRun'))) await s.delete();
    for (const a of game.actors.filter(a => a.name.startsWith('NR-тест'))) await a.delete();
    // Готовый герой — обратно: назначение, герой, папка
    const trusted = game.users.getName('Claude_trusted'), hero = trusted.character;
    await trusted.update({ character: null });
    if (hero?.folder?.name === 'Лабиринт: герои') await hero.delete();
    const folder = game.folders.find(f => f.type === 'Actor' && f.name === 'Лабиринт: герои');
    if (folder && !folder.contents.length) await folder.delete();
    await game.settings.set('gachadnd', 'anchorOpen', saved.settings.anchorOpen);
}, saved);
await wait(800);

const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
