// Погода на арене в настоящей Foundry: node tools/foundry/weather.mjs [--headed]
// Выбор по узлу (Монстры — никогда, Элита — в половине боёв, Застава и Босс — всегда; галочка «Погода на важных
// боях»); ливень — «Грязь» и «Разлив» трудной местностью; в начале боя карточка всем, кнопки — только у Мастера;
// «Другая погода» меняет погоду и карточку; туман режет взгляд игрока и сползает по раундам; ветер — помеха на
// дальние атаки оружием, ближние без неё; «Снять погоду» убирает всё. Снимки: туман глазами игрока.
import { connect, joinAs, checker, moduleErrors, done } from './harness.mjs';
import { install, scene } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
const ids = await scene(page, { hero: { level: 3 }, enemies: [{ name: 'Враг', x: 9, y: 5 }] });
const back = await ev(() => game.scenes.active?.id ?? canvas.scene.id);
// Герой — у игрока; лук и меч для проверки ветра
await ev(async hero => {
    const player = game.users.getName('Claude_player');
    const actor = game.actors.get(hero);
    await actor.update({ [`ownership.${player.id}`]: 3 });
    await actor.createEmbeddedDocuments('Item', [
        { name: 'WX-лук', type: 'weapon', system: { type: { value: 'simpleR', baseItem: 'shortbow' }, range: { value: 80, long: 320 }, damage: { base: { number: 1, denomination: 6, types: ['piercing'] } }, equipped: true, proficient: 1 } },
        { name: 'WX-меч', type: 'weapon', system: { type: { value: 'martialM', baseItem: 'longsword' }, damage: { base: { number: 1, denomination: 8, types: ['slashing'] } }, equipped: true, proficient: 1 } }
    ]);
}, ids.hero);

// Игрок рядом с Мастером. Особенность стенда: два окна одного браузера — изменения от Мастера доходят до игрока,
// только если Мастер подключился позже игрока; в игре так не бывает
const player = await joinAs(f, 'Claude_player');
const pev = (fn, arg) => player.page.evaluate(fn, arg);
await page.reload();
await page.waitForFunction(() => window.game?.ready, null, { polling: 250, timeout: 120000 });
await page.waitForTimeout(1500);
await install(page);
// Ошибки — с этого места: перезагрузка Мастера сама сыплет ошибками Foundry
const since = f.log.length;

// ---------- Выбор погоды по узлу
const choice = await ev(async () => {
    const api = game.gachadnd.encounters;
    const w = (type, r) => api.arena({ type, biome: 'swamp' }, [], { rnd: () => r }).weather;
    const out = { mob: w('mob', 0), eliteLow: w('elite', 0.3), eliteHigh: w('elite', 0.7), outpost: w('outpost', 0.99), boss: w('boss', 0.99) };
    await game.settings.set('gachadnd', 'hintWeather', false);
    out.off = w('boss', 0);
    await game.settings.set('gachadnd', 'hintWeather', true);
    return out;
});
check('погода по узлу: Монстры — нет, Элита — в половине боёв, Застава и Босс — всегда; галочка выключена — нет',
    choice.mob === null && !!choice.eliteLow && choice.eliteHigh === null && !!choice.outpost && !!choice.boss && choice.off === null, JSON.stringify(choice));

// ---------- Ливень: грязь и разлив
const rain = await ev(async ({ hero, enemy }) => {
    const { scene } = await game.gachadnd.arena.generate({ seed: 's1', mood: 'day', scheme: 'crossing', party: [hero], enemies: [enemy], weather: 'rain' });
    await scene.activate();
    const regions = scene.regions.filter(r => r.getFlag('gachadnd', 'weather')).map(r => ({ name: r.name, types: [...(r.behaviors.contents[0]?.system?.types ?? [])] }));
    return { id: scene.id, effect: scene.weather, flag: scene.getFlag('gachadnd', 'arenaWeather')?.kind, regions };
}, { hero: ids.hero, enemy: ids.enemies[0] });
check('ливень: дождь на сцене, тропа — «Грязь» (грязь), ручей — «Разлив» (жидкость)',
    rain.effect === 'rain' && rain.flag === 'rain' && rain.regions.some(r => r.name === 'Грязь' && r.types.includes('mud')) && rain.regions.some(r => r.name === 'Разлив' && r.types.includes('liquid')), JSON.stringify(rain));

await pev(async sceneId => { for (let i = 0; i < 80 && (canvas.scene?.id !== sceneId || !canvas.ready); i++) await new Promise(r => setTimeout(r, 250)); }, rain.id);

const area = poly => { const p = poly?.points ?? []; let a = 0; for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length; a += p[i] * p[j + 1] - p[j] * p[i + 1]; } return Math.abs(a) / 2; };
const losOf = () => pev(async ({ hero, area }) => {
    const fn = new Function(`return ${area}`)();
    // Зрение пересчитывается после перерисовки — ждать, пока у героя появится линия взгляда
    // Героя выбирает сам игрок — зрение строится от выбранного; замер — когда два подряд совпали
    let a = 0, prev = -1, why = '';
    for (let i = 0; i < 60 && (!a || a !== prev); i++) {
        await new Promise(r => setTimeout(r, 500));
        const t = canvas.tokens.placeables.find(t => t.document.actorId === hero);
        if (t && !t.controlled) t.control({ releaseOthers: true });
        prev = a; a = Math.round(fn(t?.vision?.los));
        why = `ready=${canvas.ready} token=${!!t} vision=${!!t?.vision} los=${!!t?.vision?.los}`;
    }
    return a || why;
}, { hero: ids.hero, area: area.toString() });
// Обзор героя у игрока без тумана (ливень стен не ставит)
const clear = await losOf();

// ---------- Начало боя: карточка всем, кнопки у Мастера
const card = await ev(async sceneId => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const c of game.combats.contents) await c.delete();
    const scene = game.scenes.get(sceneId);
    const n = game.messages.size;
    const combat = await Combat.create({ scene: sceneId, active: true });
    await combat.createEmbeddedDocuments('Combatant', scene.tokens.map(t => ({ tokenId: t.id, sceneId, actorId: t.actorId })));
    await combat.startCombat();
    await sleep(1200);
    const msg = game.messages.contents.slice(n).find(m => m.getFlag('gachadnd', 'weather'));
    const el = document.querySelector(`#chat [data-message-id="${msg?.id}"], .chat-log [data-message-id="${msg?.id}"]`);
    return { id: msg?.id, combat: combat.id, whisper: msg?.whisper?.length ?? -1, text: /Ливень/.test(msg?.content ?? '') && /Восприятие/.test(msg?.content ?? ''), gmButtons: el?.querySelectorAll('[data-gd-weather]').length ?? 0 };
}, rain.id);
await player.page.waitForTimeout(1500);
const seen = await pev(async id => {
    // Чат у игрока может быть свёрнут — развернуть вкладку, чтобы карточка отрисовалась
    ui.sidebar?.expand?.(); ui.sidebar?.changeTab?.('chat', 'primary');
    await new Promise(r => setTimeout(r, 1200));
    const els = [...document.querySelectorAll(`[data-message-id="${id}"]`)];
    // Карточка у игрока: в журнале чата или во всплывающем уведомлении
    const el = els.find(e => e.querySelector('.gd-weather-card'));
    return { known: !!game.messages.get(id), shown: !!el, copies: els.length, buttons: els.reduce((n, e) => n + e.querySelectorAll('[data-gd-weather]').length, 0) };
}, card.id);
check('начало боя: карточка «Ливень» с правилом всем; у Мастера «Другая погода» и «Снять погоду», у игрока кнопок нет',
    card.id && card.whisper === 0 && card.text && card.gmButtons === 2 && seen.shown && seen.buttons === 0, JSON.stringify({ card, seen }));

// ---------- «Другая погода»
const other = await ev(async ({ id, sceneId }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const el = document.querySelector(`#chat [data-message-id="${id}"], .chat-log [data-message-id="${id}"]`);
    el.querySelector('[data-gd-weather="other"]').click();
    const scene = game.scenes.get(sceneId);
    // Первый туман рисует и загружает плитку — смена погоды занимает несколько секунд
    for (let i = 0; i < 40 && !(scene.getFlag('gachadnd', 'arenaWeather')?.kind && scene.getFlag('gachadnd', 'arenaWeather').kind !== 'rain' && !/Ливень/.test(game.messages.get(id).content)); i++) await sleep(250);
    await sleep(500);
    return { kind: scene.getFlag('gachadnd', 'arenaWeather')?.kind, mud: scene.regions.some(r => r.name === 'Грязь'), card: game.messages.get(id).content.match(/<strong>([^<]+)<\/strong>/)?.[1] };
}, { id: card.id, sceneId: rain.id });
check('«Другая погода»: ливень сменился, грязь убрана, карточка — о новой погоде',
    other.kind && other.kind !== 'rain' && !other.mud && other.card && other.card !== 'Ливень', JSON.stringify(other));

// ---------- Туман: режет взгляд игрока и сползает по раундам
const fog = await ev(async sceneId => {
    const { applyWeather } = await gdt.mod('arena/weather.js');
    const scene = game.scenes.get(sceneId);
    await applyWeather(scene, 'fog', { seed: 'fogtest' });
    const fog = d => d.getFlag('gachadnd', 'fog') !== undefined;
    const walls = scene.walls.filter(fog);
    return { puffs: scene.tiles.filter(fog).length, walls: walls.length, sight: walls.every(w => w.sight === 10 && w.move === 0) };
}, rain.id);
const foggy = await losOf();
check('туман: 3–5 клочьев — плитка и кольцо стен «ограниченный обзор» (шаг не держит); обзор героя у игрока меньше, чем без тумана',
    fog.puffs >= 3 && fog.puffs <= 5 && fog.walls === fog.puffs * 14 && fog.sight && foggy > 0 && foggy < clear * 0.97, JSON.stringify({ fog, clear, foggy }));
await pev(async () => {
    for (const app of [...foundry.applications.instances.values()]) if (app.hasFrame && app.rendered) await app.close();
    canvas.animatePan({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2, scale: 0.45, duration: 0 });
    document.getElementById('pause')?.classList.remove('paused');
});
await player.page.waitForTimeout(1500);
await player.shot('weather-fog-player');
await ev(() => { canvas.animatePan({ x: canvas.dimensions.width / 2, y: canvas.dimensions.height / 2, scale: 0.45, duration: 0 }); document.getElementById('pause')?.classList.remove('paused'); });
await page.waitForTimeout(1500);
await f.shot('weather-fog-gm');

const drift = await ev(async ({ sceneId, combatId }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const scene = game.scenes.get(sceneId), combat = game.combats.get(combatId);
    const fog = d => d.getFlag('gachadnd', 'fog') !== undefined;
    const at = () => [...scene.tiles.filter(fog).map(t => `${t.x},${t.y}`), ...scene.walls.filter(fog).slice(0, 1).map(w => w.c.join(','))].join(' ');
    const before = at();
    await combat.nextRound();
    await sleep(1500);
    return { before, after: at() };
}, { sceneId: rain.id, combatId: card.combat });
check('туман сползает: в начале раунда клочья сдвинулись', drift.after && drift.after !== drift.before, JSON.stringify(drift));

// ---------- Ветер: помеха на дальние атаки оружием
const wind = await ev(async ({ sceneId, hero }) => {
    const { applyWeather } = await gdt.mod('arena/weather.js');
    const scene = game.scenes.get(sceneId);
    await applyWeather(scene, 'wind', { seed: 'w' });
    const actor = game.actors.get(hero);
    const roll = async name => {
        const activity = actor.items.getName(name)?.system.activities?.find(a => a.type === 'attack');
        if (!activity) return 'нет атаки';
        const rolls = await activity.rollAttack({}, { configure: false }, { create: false });
        return rolls?.[0]?.options?.advantageMode ?? rolls?.[0]?.hasDisadvantage;
    };
    return { effect: scene.weather, bow: await roll('WX-лук'), sword: await roll('WX-меч'), mode: CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE };
}, { sceneId: rain.id, hero: ids.hero });
check('ветер: листья на сцене; лук — с помехой, меч — без', wind.effect === 'leaves' && wind.bow === wind.mode && wind.sword !== wind.mode, JSON.stringify(wind));

// ---------- «Снять погоду»
const off = await ev(async ({ sceneId }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const scene = game.scenes.get(sceneId);
    const { postWeatherCard } = await gdt.mod('arena/weather.js');
    const msg = await postWeatherCard(scene);
    await sleep(800);
    document.querySelector(`#chat [data-message-id="${msg.id}"] [data-gd-weather="off"], .chat-log [data-message-id="${msg.id}"] [data-gd-weather="off"]`)?.click();
    await sleep(2000);
    const mine = d => d.getFlag('gachadnd', 'weather');
    return { flag: scene.getFlag('gachadnd', 'arenaWeather') ?? null, effect: scene.weather, regions: scene.regions.filter(mine).length, tiles: scene.tiles.filter(mine).length, walls: scene.walls.filter(mine).length, lights: scene.lights.filter(mine).length };
}, { sceneId: rain.id });
check('«Снять погоду»: флага, эффекта, регионов, стен, света и плиток погоды нет', !off.flag && !off.effect && !off.regions && !off.tiles && !off.walls && !off.lights, JSON.stringify(off));

// ---------- Уборка
await ev(async ({ hero, back }) => {
    for (const c of game.combats.contents) await c.delete();
    const player = game.users.getName('Claude_player');
    const actor = game.actors.get(hero);
    await actor?.deleteEmbeddedDocuments('Item', actor.items.filter(i => i.name.startsWith('WX-')).map(i => i.id));
    await actor?.update({ [`ownership.${player.id}`]: 0 });
    await game.scenes.get(back)?.activate();
}, { hero: ids.hero, back });
await player.close();

const errors = moduleErrors(f.log.slice(since)).concat(moduleErrors(player.log));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
