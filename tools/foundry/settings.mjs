// Настройки модуля в настоящей Foundry: node tools/foundry/settings.mjs [--headed] [--slow[=мс]]
// В общем списке — только общие настройки и кнопки подменю; подменю показывают и сохраняют свои поля;
// режим эффектов (полные / спокойные / выключены) и общая громкость доходят до кода; подсказки
// Мастеру слушаются общего и своих переключателей (шёпот Запаха, строка атмосферы, шёпот Пульса).
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, combat } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
// После смены хода — ожидание тишины: хуки модуля у Мастера дописывают своё (fixtures: gdt.settle)
const settle = () => page.evaluate(() => gdt.settle());

await install(page);
const ids = await scene(page, { hero: { x: 5, y: 5, level: 3 }, enemies: [{ name: 'Враг', x: 7, y: 5 }] });
const since = f.log.length;
// Запоминаем значения, чтобы вернуть мир как был
const saved = await ev(() => Object.fromEntries(['effects', 'volume', 'gmHints', 'hintScent', 'hintAtmosphere', 'hintPulse', 'goldBase'].map(k => [k, game.settings.get('gachadnd', k)])));

// ---------- Общий список
const listed = await ev(() => ({
    settings: [...game.settings.settings.values()].filter(s => s.namespace === 'gachadnd' && s.config).map(s => s.key).sort(),
    menus: [...game.settings.menus.keys()].filter(k => k.startsWith('gachadnd.')).map(k => k.slice(9)).sort()
}));
check('в общем списке — 6 общих настроек', JSON.stringify(listed.settings) === JSON.stringify(['anchorSceneId', 'automation', 'effects', 'gmHints', 'rudeNames', 'volume']), listed.settings.join(', '));
check('кнопки подменю: экономика, звуки, подсказки, свои названия, Риск, срабатывания', JSON.stringify(listed.menus) === JSON.stringify(['automationMenu', 'economyMenu', 'hintsMenu', 'namesMenu', 'riskMenu', 'soundsMenu']), listed.menus.join(', '));

// Окно настроек Foundry, вкладка модуля
await ev(async () => {
    await gdt.closeForeign();
    const app = new foundry.applications.settings.SettingsConfig();
    await app.render({ force: true });
    gdt.settingsApp = app;
    await gdt.sleep(600);
    app.changeTab?.('gachadnd', 'categories');
});
await wait(800);
// Строки вкладки модуля: подписи настроек и кнопок подменю
const shown = await ev(() => {
    const root = gdt.settingsApp.element;
    const tab = [...root.querySelectorAll('[data-tab="gachadnd"], [data-category="gachadnd"]')].find(el => el.querySelector('label, button')) ?? root;
    const labels = [...tab.querySelectorAll('.form-group > label')].map(l => l.textContent.trim()).filter(Boolean);
    return { count: labels.length, labels };
});
await f.shot('settings_list');
check('в окне настроек у модуля 12 строк: 6 кнопок подменю и 6 настроек', shown.count === 12, shown.labels.join(' · '));
await ev(() => gdt.settingsApp.close());

// ---------- Подменю: поля и сохранение
const openMenu = key => ev(async key => {
    const Menu = game.settings.menus.get(`gachadnd.${key}`).type;
    const app = new Menu();
    await app.render({ force: true });
    gdt.menuApp = app;
    await gdt.sleep(400);
    return { id: app.id, fields: app.element.querySelectorAll('.form-group').length };
}, key);
let m = await openMenu('economyMenu');
check('Экономика забега: 9 полей', m.fields === 9, JSON.stringify(m));
await f.shot('settings_economy');
await page.fill(`#${m.id} input[name="gachadnd.goldBase"]`, '150');
await page.click(`#${m.id} button[type="submit"]`);
await wait(800);
check('Экономика: изменённое поле сохранилось', await ev(() => game.settings.get('gachadnd', 'goldBase')) === 150);
m = await openMenu('soundsMenu');
check('Звуки и эффекты: 10 полей у Мастера', m.fields === 10, JSON.stringify(m));
await ev(() => gdt.menuApp.close());
m = await openMenu('hintsMenu');
check('Подсказки Мастеру: 3 переключателя', m.fields === 3, JSON.stringify(m));
await page.uncheck(`#${m.id} input[name="gachadnd.hintPulse"]`);
await page.click(`#${m.id} button[type="submit"]`);
await wait(800);
check('Подсказки: снятая галочка сохранилась', await ev(() => game.settings.get('gachadnd', 'hintPulse')) === false);
m = await openMenu('riskMenu');
check('Испытания Риска: 2 поля', m.fields === 2, JSON.stringify(m));
await ev(() => gdt.menuApp.close());

// ---------- Эффекты и громкость
const fx = () => ev(async () => {
    const p = await gdt.mod('core/prefs.js');
    const reveal = await gdt.mod('memory/effects/loot-reveal.js');
    const t = performance.now();
    const shown = await reveal.playReveal('purple');
    return { on: p.fxOn(), calm: p.fxCalm(), reveal: shown, ms: Math.round(performance.now() - t) };
});
await ev(() => game.settings.set('gachadnd', 'effects', 'full'));
let r = await fx();
check('эффекты полные: вспышка добычи идёт', r.on && !r.calm && r.reveal === true, JSON.stringify(r));
await ev(() => game.settings.set('gachadnd', 'effects', 'calm'));
r = await fx();
check('эффекты спокойные: вспышка мягкая, но есть', r.on && r.calm && r.reveal === true, JSON.stringify(r));
await ev(() => game.settings.set('gachadnd', 'effects', 'off'));
r = await fx();
check('эффекты выключены: сцены добычи нет', !r.on && r.calm && r.reveal === false && r.ms < 50, JSON.stringify(r));
await ev(() => game.settings.set('gachadnd', 'volume', 0.5));
const vol = await ev(async () => { const p = await gdt.mod('core/prefs.js'); return { sfx: p.sfxVolume(), music: p.musicVolume(), raw: game.settings.get('gachadnd', 'soundsVolume') }; });
check('громкость модуля множит частные: 0,5 × громкость звуков', Math.abs(vol.sfx - 0.5 * vol.raw) < 1e-9, JSON.stringify(vol));

// ---------- Подсказки Мастеру: Запах (шёпот и атмосфера) и Пульс
// Отряд — персонажи с владельцем-игроком; в тестовом мире игроков нет: герой помечается на время проверки
await ev(async hero => {
    const a = game.actors.get(hero);
    Object.defineProperty(a, 'hasPlayerOwner', { get: () => true, configurable: true });
    const inv = await gdt.mod('memory/inventory.js');
    await inv.giveCrystal(a, { skillName: 'Серия обычных ударов' });
    await inv.giveCrystal(a, { skillName: 'Перспектива' });
}, ids.hero);
const scentMessages = async () => {
    await ev(() => gdt.mark());
    await ev(async () => (await gdt.mod('labyrinth/anchor.js')).announceScent('mob'));
    await wait(500);
    return ev(() => ({
        whisper: game.messages.contents.slice(gdt._mark).filter(m => m.whisper?.length && /Запах/.test(m.content)).length,
        atmosphere: game.messages.contents.slice(gdt._mark).filter(m => !m.whisper?.length && /atmosphere/.test(m.content)).length
    }));
};
await ev(() => Promise.all([game.settings.set('gachadnd', 'gmHints', true), game.settings.set('gachadnd', 'hintScent', true), game.settings.set('gachadnd', 'hintAtmosphere', true)]));
let s = await scentMessages();
check('Запах в Охоте: шёпот Мастеру и строка атмосферы', s.whisper === 1 && s.atmosphere === 1, JSON.stringify(s));
await ev(() => game.settings.set('gachadnd', 'hintAtmosphere', false));
s = await scentMessages();
check('без строк атмосферы — только шёпот Мастеру', s.whisper === 1 && s.atmosphere === 0, JSON.stringify(s));
await ev(() => Promise.all([game.settings.set('gachadnd', 'hintAtmosphere', true), game.settings.set('gachadnd', 'gmHints', false)]));
s = await scentMessages();
check('общий переключатель снят — ни шёпота, ни атмосферы', s.whisper === 0 && s.atmosphere === 0, JSON.stringify(s));
await ev(() => game.settings.set('gachadnd', 'gmHints', true));
// Пульс: бой с героем и врагом закончился — шёпот, если подсказка Пульса включена
const pulseAfterFight = async () => {
    await combat(page, ids.scene, [ids.hero, ids.enemies[0]]);
    await wait(500);
    await ev(() => gdt.mark());
    await ev(() => game.combat.delete());
    await wait(1200);
    return ev(() => game.messages.contents.slice(gdt._mark).filter(m => /Пульс|Бой —/.test(m.content) || m.speaker?.alias === 'Пульс отряда').length);
};
await ev(() => game.settings.set('gachadnd', 'hintPulse', false));
check('шёпот Пульса выключен — после боя тишина', (await pulseAfterFight()) === 0);
await ev(() => game.settings.set('gachadnd', 'hintPulse', true));
check('шёпот Пульса включён — после боя шёпот Мастеру', (await pulseAfterFight()) === 1);

// Вернуть мир как был
await ev(saved => Promise.all(Object.entries(saved).map(([k, v]) => game.settings.set('gachadnd', k, v))), saved);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
