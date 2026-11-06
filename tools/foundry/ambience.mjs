// Фон арены в настоящей Foundry: node tools/foundry/ambience.mjs [--headed]
// Фон по месту и погоде (флаг сцены): день — лес, ночь — насекомые, ливень и ветер заменяют фон, «Снять погоду»
// возвращает; вариант не повторяется подряд; нет файла фона — тишина. Играет у каждого клиента сам — у Мастера и
// у игрока без выбранного токена; в бою стихает до четверти (или замолкает — настройка), после боя возвращается.
// В «Управление громкостью» — блок модуля: «Gacha: всё», фон арены, Терминал, тема героя; ползунок фона меняет
// громкость сразу. Звуки — assets/sounds/arena (docs/arena-sounds.md).
import { connect, joinAs, joinSpectator, checker, moduleErrors, done } from './harness.mjs';
import { install, scene } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const sleep = ms => new Promise(r => setTimeout(r, ms));

await install(page);
const ids = await scene(page, { hero: { level: 1 }, enemies: [] });
const back = await ev(() => game.scenes.active?.id ?? canvas.scene.id);
const flagOf = sc => sc.getFlag('gachadnd', 'arenaAmbience') ?? null;

// ---------- Выбор фона: день, ещё дважды день, ночь
const days = await ev(async ({ hero, flagOf }) => {
    const fn = new Function(`return ${flagOf}`)();
    const out = [];
    for (const mood of ['day', 'day', 'day', 'night']) {
        const { scene } = await game.gachadnd.arena.generate({ seed: `amb-${out.length}`, mood, scheme: 'glade', party: [hero], enemies: [], view: false });
        out.push({ mood, flag: fn(scene) });
    }
    return out;
}, { hero: ids.hero, flagOf: flagOf.toString() });
const file = d => d.flag?.path?.split('/').pop();
check('день — фон «лес днём», ночь — «лес ночью»', days[0].flag?.key === 'forest-day' && /^forest-day/.test(file(days[0])) && days[3].flag?.key === 'forest-night', JSON.stringify(days.map(d => [d.flag?.key, file(d)])));
check('вариант фона не повторяется подряд', file(days[1]) !== file(days[0]) && file(days[2]) !== file(days[1]), JSON.stringify(days.slice(0, 3).map(file)));

// ---------- Погода заменяет фон; снять — вернуть; фон без файла — тишина
const weather = await ev(async ({ hero, flagOf }) => {
    const fn = new Function(`return ${flagOf}`)();
    const { applyWeather, clearWeather } = await gdt.mod('arena/weather.js');
    const { setAmbience } = await gdt.mod('arena/ambience.js');
    const { scene } = await game.gachadnd.arena.generate({ seed: 'amb-w', mood: 'day', scheme: 'glade', party: [hero], enemies: [], view: false });
    await applyWeather(scene, 'rain', { seed: 'a' });
    const rain = fn(scene)?.key;
    await applyWeather(scene, 'wind', { seed: 'a' });
    const wind = fn(scene)?.key;
    await clearWeather(scene);
    const calm = fn(scene)?.key;
    const none = { set: await setAmbience(scene, 'net-takogo-fona'), flag: fn(scene) };
    await setAmbience(scene);
    return { rain, wind, calm, none: !none.set && !none.flag };
}, { hero: ids.hero, flagOf: flagOf.toString() });
check('ливень и ветер заменяют фон; «Снять погоду» возвращает лес; фон без файла — тишина',
    weather.rain === 'rain' && weather.wind === 'wind' && weather.calm === 'forest-day' && weather.none, JSON.stringify(weather));

// ---------- Играет у Мастера и у игрока без токена
const arenaId = await ev(async hero => {
    const { scene } = await game.gachadnd.arena.generate({ seed: 'amb-play', mood: 'day', scheme: 'glade', party: [hero], enemies: [] });
    await scene.activate();
    return scene.id;
}, ids.hero);
const player = await joinAs(f, 'Claude_player');
const spectator = await joinSpectator(f);
const pev = (fn, arg) => player.page.evaluate(fn, arg);
// Особенность стенда: последняя вошедшая вкладка не получает рассылок — после игрока вошёл «зритель»
const since = f.log.length;
const playing = async (on, id) => on.evaluate(async id => {
    for (let i = 0; i < 60 && (canvas.scene?.id !== id || !canvas.ready); i++) await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 2500));
    const { ambiencePlaying } = await import('/modules/gachadnd/scripts/arena/ambience.js');
    return { now: ambiencePlaying(), controlled: canvas.tokens.controlled.length, path: canvas.scene.getFlag('gachadnd', 'arenaAmbience')?.path };
}, id);
// Браузер не даёт звук до первого действия пользователя — нажатие клавиши у обоих
for (const p of [page, player.page]) { await p.mouse.move(700, 400); await p.keyboard.press('Shift'); }
const gm = await playing(page, arenaId), pl = await playing(player.page, arenaId);
check('фон играет у Мастера и у игрока без выбранного токена — тот же файл, по кругу',
    gm.now?.playing && gm.now.path === gm.path && pl.now?.playing && pl.now.path === gm.path && pl.controlled === 0, JSON.stringify({ gm, pl }));

// ---------- Бой: тише или тишина; после боя — как было
const combat = await ev(async sceneId => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const { ambiencePlaying } = await gdt.mod('arena/ambience.js');
    const round = async () => {
        // Бой без участников Foundry не считает начатым — герой арены в бою
        const c = await Combat.create({ scene: sceneId, active: true });
        await c.createEmbeddedDocuments('Combatant', game.scenes.get(sceneId).tokens.map(t => ({ tokenId: t.id, sceneId, actorId: t.actorId })));
        await c.startCombat(); await sleep(2200);
        const during = ambiencePlaying();
        await c.delete(); await sleep(2500);
        return { during, after: ambiencePlaying() };
    };
    const calm = ambiencePlaying()?.volume;
    await game.settings.set('gachadnd', 'arenaAmbience', 'quiet');
    const quiet = await round();
    await game.settings.set('gachadnd', 'arenaAmbience', 'off');
    const off = await round();
    await game.settings.set('gachadnd', 'arenaAmbience', 'quiet');
    return { calm, quiet, off };
}, arenaId);
check('в бою фон — четверть громкости, после — обычная; «Выключить» — замолкает на бой',
    combat.quiet.during?.volume === Math.round(combat.calm * 25) / 100 && combat.quiet.after?.volume === combat.calm && !combat.off.during && combat.off.after?.playing, JSON.stringify(combat));

// ---------- «Управление громкостью»: блок модуля, ползунок фона — сразу
const panel = await pev(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.('playlists', 'primary');
    await sleep(1200);
    const root = ui.playlists.element;
    const rows = [...root.querySelectorAll('.gd-volume [data-gd-volume]')].map(i => i.dataset.gdVolume);
    const { ambiencePlaying } = await import('/modules/gachadnd/scripts/arena/ambience.js');
    const before = ambiencePlaying()?.volume;
    const input = root.querySelector('[data-gd-volume="arenaAmbienceVolume"]');
    input.value = '0.5'; input.dispatchEvent(new Event('change'));
    await sleep(1500);
    const half = ambiencePlaying()?.volume;
    await game.settings.set('gachadnd', 'arenaAmbienceVolume', 1);
    return { rows, before, half, setting: game.settings.get('gachadnd', 'volume') };
});
await player.shot('ambience-volume-panel');
check('«Управление громкостью»: Gacha — всё, фон арены, Терминал, тема героя; ползунок фона сразу меняет громкость',
    panel.rows.join() === 'volume,arenaAmbienceVolume,soundsVolume,auraMusicVolume' && panel.half === Math.round(panel.before * 50) / 100, JSON.stringify(panel));

await ev(async back => { for (const c of game.combats.contents) await c.delete(); await game.scenes.get(back)?.activate(); }, back);
await spectator.close();
await player.close();
const errors = moduleErrors(f.log.slice(since)).concat(moduleErrors(player.log));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
