// Окна модуля в настоящей Foundry: node tools/foundry/windows.mjs [--headed]
// Каждое окно забега и Памяти открывается через game.gachadnd, должно отрисоваться без ошибок
// модуля и устаревших вызовов; снимок — в tools/foundry/out/window-*.png, затем окно закрывается.
// Кнопки модуля на панели токенов нажимаются тоже. Содержимое окон не проверяется.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
await install(page);
const ids = await scene(page, { hero: { level: 5 } });
await skills(page, ids.hero, ['Догони меня... Кирпичи?', 'Голос предков']);
await page.evaluate(hero => game.actors.get(hero).getActiveTokens()[0]?.control({ releaseOthers: true }), ids.hero);

const opened = () => page.evaluate(() => [...foundry.applications.instances.values()].filter(a => a.rendered).map(a => ({ id: a.id, cls: a.constructor.name, title: a.title })));
const closeAll = ids => page.evaluate(async ids => {
    for (const a of [...foundry.applications.instances.values()]) if (a.rendered && !ids.includes(a.id)) await a.close({ animate: false }).catch(() => {});
}, ids);
const base = (await opened()).map(w => w.id);

const WINDOWS = [
    ['Терминал Памяти', 'openTerminal(game.actors.get(hero))'],
    ['Терминал (окно)', 'openTerminalWindow(game.actors.get(hero))'],
    ['Терминал лута', 'openLootTerminal()'],
    ['Алтарь Памяти', 'openMemoryAltar(game.actors.get(hero))'],
    ['Хранилище', 'openStash(game.actors.get(hero))'],
    ['Догони меня... Кирпичи?', 'openTetris(game.actors.get(hero))'],
    ['Карта этажа', 'openMapTerminal()'],
    ['Награды события', 'openEventRewards()'],
    ['Кладбище', 'openGraveyard()']
];

for (const [name, call] of WINDOWS) {
    const from = f.log.length;
    let error = null;
    try {
        await page.evaluate(async ({ hero, call }) => { await new Function('hero', `return game.gachadnd.${call}`)(hero); }, { hero: ids.hero, call });
    } catch (e) { error = e.message.split('\n')[0]; }
    let wins = [];
    for (let i = 0; i < 20; i++) {
        wins = (await opened()).filter(w => !base.includes(w.id));
        if (wins.length) break;
        await page.waitForTimeout(150);
    }
    await page.waitForTimeout(800);
    await f.shot(`window-${name.replace(/\s+/g, '-').replace(/[?<>:"/\|*]/g, '')}`);
    const lines = f.log.slice(from);
    const errs = moduleErrors(lines);
    const deprecated = [...new Set(lines.filter(l => /deprecated/i.test(l) && /modules\/gachadnd\//.test(l)).map(l => l.split('\n')[0].slice(0, 140)))];
    check(`${name}: окно открылось без ошибок`, !error && wins.length && !errs.length && !deprecated.length,
        [error, wins.map(w => `${w.cls}: ${w.title}`).join(', ') || 'окна нет', ...errs.map(e => e.slice(0, 160)), ...deprecated].filter(Boolean).join(' | '));
    await closeAll(base);
    await page.waitForTimeout(300);
}

// Окна узлов: на тестовой сцене чертится карта этажа, отряд по очереди встаёт на узел нужного типа
const floorBefore = await page.evaluate(() => game.settings.get('gachadnd', 'runFloor'));
// Окна узлов проверяются на карте рядами: режим, оставшийся в мире от паутины, на время проверки — ряды
const modeBefore = await page.evaluate(async () => {
    const mode = { mode: game.settings.get('gachadnd', 'mapMode'), scene: game.settings.get('gachadnd', 'floorSceneId') };
    await game.settings.set('gachadnd', 'mapMode', 'rows');
    // Запомненная сцена этажа (песочница бывает с паутиной) — на время проверки эта
    await game.settings.set('gachadnd', 'floorSceneId', canvas.scene.id);
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
    return mode;
});
const NODES = [['Алтарь Рока', 'doom', 'openDoomAltar()'], ['Магазин', 'shop', 'openShop()'], ['Риски', 'risk', 'openRisk()'], ['Портал в Предел', 'rest', 'openPortal()']];
let types = [];
for (let attempt = 0; attempt < 6 && !NODES.every(([, type]) => types.includes(type)); attempt++) {
    await page.evaluate(() => game.gachadnd.openMapTerminal());
    await page.waitForSelector('#gachadnd-map-terminal [name="length"], [data-action="generate"]', { timeout: 10000 }).catch(() => {});
    // Уведомления Foundry перекрывают шапку окна — поле и кнопка нажимаются из кода страницы
    await page.evaluate(() => {
        const length = document.querySelector('[name="length"]');
        if (length) length.value = '15';
        document.querySelector('[data-action="generate"]')?.click();
    });
    await page.waitForTimeout(1200);
    types = await page.evaluate(() => (canvas.scene.getFlag('gachadnd', 'floorMap')?.nodes ?? []).map(n => n.type));
    await closeAll(base);
}
check('карта этажа сгенерирована на тестовой сцене', types.length > 0, [...new Set(types)].join(', '));
for (const [name, type, call] of NODES) {
    const from = f.log.length;
    const placed = await page.evaluate(async type => {
        const map = foundry.utils.deepClone(canvas.scene.getFlag('gachadnd', 'floorMap'));
        const node = map?.nodes?.find(n => n.type === type);
        if (!node) return false;
        map.currentNodeId = node.id;
        await canvas.scene.setFlag('gachadnd', 'floorMap', map);
        return true;
    }, type);
    let error = null;
    try { await page.evaluate(call => new Function(`return game.gachadnd.${call}`)(), call); } catch (e) { error = e.message.split('\n')[0]; }
    let wins = [];
    for (let i = 0; i < 20; i++) {
        wins = (await opened()).filter(w => !base.includes(w.id));
        if (wins.length) break;
        await page.waitForTimeout(150);
    }
    await page.waitForTimeout(800);
    await f.shot(`window-${name.replace(/\s+/g, '-').replace(/[?<>:"/\|*]/g, '')}`);
    const lines = f.log.slice(from);
    const errs = moduleErrors(lines);
    const deprecated = [...new Set(lines.filter(l => /deprecated/i.test(l) && /modules\/gachadnd\//.test(l)).map(l => l.split('\n')[0].slice(0, 140)))];
    const warned = await page.evaluate(() => gdt.warnings.slice(-1)[0] ?? '');
    check(`${name}: окно на узле «${type}» открылось без ошибок`, placed && !error && wins.length && !errs.length && !deprecated.length,
        [placed ? '' : 'узла нет', error, wins.map(w => `${w.cls}: ${w.title}`).join(', ') || `окна нет (${warned})`, ...errs.map(e => e.slice(0, 160)), ...deprecated].filter(Boolean).join(' | '));
    await closeAll(base);
    await page.waitForTimeout(300);
}
await page.evaluate(async ({ floor, mode }) => {
    await canvas.scene.unsetFlag('gachadnd', 'floorMap');
    await game.settings.set('gachadnd', 'runFloor', floor);
    await game.settings.set('gachadnd', 'mapMode', mode.mode);
    await game.settings.set('gachadnd', 'floorSceneId', mode.scene);
}, { floor: floorBefore, mode: modeBefore });

// Функции без окна
for (const [name, call] of [['Якорь: открыть', 'setAnchor(true)'], ['Якорь: закрыть', 'setAnchor(false)'], ['Запах отряда', 'scent()'],
    ['Пульс', 'pulse()'], ['Предвестие 3', "omen('3')"], ['Предвестие снято', "omen('off')"]]) {
    const from = f.log.length;
    let error = null, result = null;
    try {
        result = await page.evaluate(async call => { const r = await new Function(`return game.gachadnd.${call}`)(); return r === undefined ? 'undefined' : typeof r; }, call);
    } catch (e) { error = e.message.split('\n')[0]; }
    await page.waitForTimeout(800);
    const errs = moduleErrors(f.log.slice(from));
    check(`${name}: без ошибок`, !error && !errs.length, [error ?? result, ...errs.map(e => e.slice(0, 160))].join(' | '));
    await closeAll(base);
}

// Кнопки модуля на панели токенов
const tools = await page.evaluate(() => {
    const token = ui.controls.controls?.tokens ?? ui.controls.controls?.token;
    return Object.values(token?.tools ?? {}).filter(t => t.name?.startsWith('gachadnd')).map(t => t.name);
});
check('кнопки модуля на панели токенов', tools.length >= 3, tools.join(', '));
for (const name of tools) {
    const from = f.log.length;
    await page.evaluate(() => ui.controls.activate?.({ control: 'tokens' }));
    await page.waitForTimeout(300);
    const button = await page.$(`#scene-controls-tools [data-tool="${name}"], [data-tool="${name}"]`);
    if (button) await button.click().catch(() => {});
    await page.waitForTimeout(1200);
    // «Убрать блоки и порталы» спрашивает подтверждение — закрыть
    const wins = (await opened()).filter(w => !base.includes(w.id));
    const lines = f.log.slice(from);
    const errs = moduleErrors(lines);
    const deprecated = [...new Set(lines.filter(l => /deprecated/i.test(l) && /modules\/gachadnd\//.test(l)).map(l => l.split('\n')[0].slice(0, 140)))];
    check(`кнопка ${name}`, button && !errs.length && !deprecated.length, [button ? wins.map(w => w.cls).join(', ') || 'без окна' : 'кнопки нет', ...errs, ...deprecated].join(' | '));
    await closeAll(base);
    // Якорь — кнопка-переключатель: вернуть закрытым
    if (name === 'gachadnd-anchor') await page.evaluate(() => game.gachadnd.setAnchor(false));
}

check('ошибок модуля в консоли нет', !moduleErrors(f.log).length, moduleErrors(f.log).slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
