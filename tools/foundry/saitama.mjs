// Удар Сайтамы в настоящей Foundry: node tools/foundry/saitama.mjs [--headed]
// Анимацию играет модуль impact-frames (api.launch), цель отлетает на 30 футов; автокадры модуля выключены —
// кадр один. Без api.launch (модуль не включён) — только отлёт: он правило навыка.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene, skills } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
const ids = await scene(page, { hero: { level: 5 }, enemies: [{ name: 'Враг', x: 6, y: 5 }] });
const since = f.log.length;
const sk = await skills(page, ids.hero, ['Серия обычных ударов']);
const skill = sk['Серия обычных ударов'];

const module = await ev(() => ({ active: !!game.modules.get('impact-frames')?.active, launch: typeof game.modules.get('impact-frames')?.api?.launch, auto: game.modules.get('impact-frames')?.active ? game.settings.get('impact-frames', 'auto') : null }));
check('модуль impact-frames включён в мире, у него есть api.launch, автокадры выключены', module.active && module.launch === 'function' && module.auto === false, JSON.stringify(module));

// Удар: навык взводится, бросок урона, урон применяется с исходным сообщением — как лоток dnd5e
const strike = () => ev(async ({ hero, skill, enemy }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const actor = game.actors.get(hero), item = actor.items.get(skill);
    await item.update({ 'system.uses.spent': 0 });
    const target = canvas.tokens.placeables.find(t => t.actor?.id === enemy);
    await target.document.update({ x: 600, y: 500 });
    await game.actors.get(enemy).update({ 'system.attributes.hp.value': 300, 'system.attributes.hp.max': 300 });
    await sleep(500);
    target.setTarget(true, { releaseOthers: true });
    const frames = [];
    const hook = Hooks.on('impactFrames.play', d => frames.push({ style: d.style, move: d.move }));
    const activity = item.system.activities.contents[0];
    await activity.use({}, { configure: false }, {});
    await sleep(800);
    await activity.rollDamage({}, { configure: false }, {});
    await sleep(500);
    const message = game.messages.contents.at(-1);
    await game.actors.get(enemy).applyDamage([{ value: 20, type: 'bludgeoning' }], { isDelta: true, originatingMessage: message });
    // Подъезд, вдох, рывок, удары, полёт и приземление — несколько секунд
    for (let i = 0; i < 40 && target.document.x === 600; i++) await sleep(300);
    await sleep(800);
    Hooks.off('impactFrames.play', hook);
    return { frames, moved: Math.round(Math.hypot(target.document.x - 600, target.document.y - 500) / canvas.grid.size), alpha: target.mesh?.alpha };
}, { hero: ids.hero, skill, enemy: ids.enemies[0] });

const withModule = await strike();
check('с модулем: один кадр «launch» с переносом, цель отлетела на 6 клеток (30 футов) и видна',
    withModule.frames.length === 1 && withModule.frames[0].style === 'launch' && withModule.frames[0].move && withModule.moved >= 5 && withModule.alpha > 0.5, JSON.stringify(withModule));
await f.shot('saitama-1-module');

// Без api.launch — как если модуль не включён: только отлёт
await ev(() => { const api = game.modules.get('impact-frames').api; window.__launch = api.launch; delete api.launch; });
const without = await strike();
await ev(() => { game.modules.get('impact-frames').api.launch = window.__launch; });
check('без модуля: кадра нет, цель всё равно отлетела — это правило навыка', without.frames.length === 0 && without.moved >= 5, JSON.stringify(without));

const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
