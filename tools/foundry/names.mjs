// Названия навыков в настоящей Foundry: node tools/foundry/names.mjs [--headed]
// Компендиум без прямых отсылок и мата (ревизия docs/naming-review.md); выданные навыки, кристаллы и
// Хранилище со старыми названиями переименовываются при синхронизации (надставка Сингулярности
// сохраняется); «Грубые названия (18+)» и «Свои названия навыков» — в обе стороны; подменю с полем.
import { connect, checker, moduleErrors, done } from './harness.mjs';
import { install, scene } from './fixtures.mjs';

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);

await install(page);
const ids = await scene(page, { hero: { level: 3 } });
const hero = ids.hero;
const since = f.log.length;
const saved = await ev(() => ({ rude: game.settings.get('gachadnd', 'rudeNames'), names: game.settings.get('gachadnd', 'skillNames') }));

// ---------- Компендиум
const pack = await ev(async () => {
    const docs = await game.packs.get('gachadnd.gacha-skills').getDocuments();
    const text = d => `${d.name} ${d.system.description.value}`;
    const OLD = ['Сайтама', 'Гэндальф', 'Леголас', 'Мегумин', 'Китти Прайд', 'Юзейн', 'Вергили', 'Ямато', 'Индианы', 'Тетрис', 'Фелицис', 'Экспеллиармус', 'Джедай',
        'Камехамеха', 'Фус-Ро-Да', "ту'ум", 'Эстус', 'Найт-Сити', 'Сандевистан', 'Хайзенберг', 'Шепард', 'Брейнданс', 'Ведьмач', 'Ведьмак', 'Нейрализатор', 'Фаталити',
        'Уно-', 'Хэнка', 'Fez', 'Ты не пройдёшь', 'Сила скорости', 'тот, кто стучит', 'хуйн', 'Ебаный'];
    const hits = docs.flatMap(d => OLD.filter(o => text(d).includes(o)).map(o => `${d.name}: ${o}`));
    const NEW = ['Серия обычных ударов', 'Не пройдёшь', 'Пули — это скучно', 'Догони меня... Кирпичи?', 'Партейку?', 'Перспектива', 'Сейв-лоад', "Let's go gambling!"];
    return {
        hits, missing: NEW.filter(n => !docs.some(d => d.name === n)),
        explicit: docs.filter(d => d.flags.gachadnd?.explicit_name).map(d => `${d.name} → ${d.flags.gachadnd.explicit_name}`).sort()
    };
});
check('компендиум: нет старых названий и отсылок в названиях и описаниях', !pack.hits.length, pack.hits.join(' | '));
check('компендиум: новые названия на месте', !pack.missing.length, pack.missing.join(', '));
check('компендиум: два грубых варианта (18+) у Сейв-лоада и Let\'s go gambling!', pack.explicit.length === 2 && pack.explicit.every(e => /Сейв-лоад →|gambling! →/.test(e)), pack.explicit.join(' | '));

// ---------- Старый мир: навыки и кристаллы со старыми названиями
await ev(async hero => {
    const actor = game.actors.get(hero);
    const inv = await gdt.mod('memory/inventory.js');
    const stash = await gdt.mod('memory/stash.js');
    for (const n of ['Серия обычных ударов', 'Догони меня... Кирпичи?', 'Сейв-лоад']) await inv.addSkillToMemory(actor, n, { forced: true });
    await inv.giveCrystal(actor, { skillName: 'Не пройдёшь' });
    await inv.giveCrystal(actor, { skillName: 'Партейку?' });
    // Старые названия, как в мире до переименования (а Сингулярность приписала тег)
    const item = n => actor.items.find(i => i.flags.gachadnd?.skill_name === n);
    const old = { 'Серия обычных ударов': 'Сайтама', 'Догони меня... Кирпичи?': 'Тетрис', 'Сейв-лоад': 'Давай по новой Миша, всё хуйня', 'Не пройдёшь': 'Гэндальф', 'Партейку?': 'Сыграем... в гвинт?' };
    await actor.updateEmbeddedDocuments('Item', Object.entries(old).map(([n, o]) => {
        const it = item(n);
        const crystal = it.flags.gachadnd.is_crystal_item;
        return { _id: it.id, name: crystal ? `Кристалл: ${o}` : n === 'Догони меня... Кирпичи?' ? `${o} [огонь]` : o, 'flags.gachadnd.skill_name': o };
    }));
    // Кристалл «Гвинта» — в Хранилище
    await stash.depositCrystal(actor, actor.items.find(i => i.flags.gachadnd?.skill_name === 'Сыграем... в гвинт?'));
}, hero);
const names = () => ev(hero => {
    const actor = game.actors.get(hero);
    return [...actor.items.filter(i => i.flags.gachadnd?.skill_id).map(i => i.name), ...(actor.getFlag('gachadnd', 'stash') ?? []).map(d => `в Хранилище: ${d.name}`)].sort().join(' | ');
}, hero);
check('старый мир: названия старые (как было до переименования)', /Сайтама/.test(await names()) && /Тетрис \[огонь\]/.test(await names()) && /в Хранилище: Кристалл: Сыграем/.test(await names()), await names());
const sync = () => ev(async () => { await (await gdt.mod('memory/skill-names.js')).syncSkillNames(); await gdt.settle(); });
await sync();
let now = await names();
check('синхронизация: навыки, кристаллы и Хранилище — новые названия, тег Сингулярности сохранён',
    now === ['Догони меня... Кирпичи? [огонь]', 'Кристалл: Не пройдёшь', 'Сейв-лоад', 'Серия обычных ударов', 'в Хранилище: Кристалл: Партейку?'].sort().join(' | '), now);

// ---------- Грубые названия (18+)
await ev(() => game.settings.set('gachadnd', 'rudeNames', true));
await ev(() => gdt.settle());
now = await names();
check('«Грубые названия» включены — Сейв-лоад показан исходным названием', now.includes('Давай по новой Миша, всё хуйня') && !now.includes('Сейв-лоад'), now);
await ev(() => game.settings.set('gachadnd', 'rudeNames', false));
await ev(() => gdt.settle());
check('«Грубые названия» выключены — снова Сейв-лоад', (await names()).includes('Сейв-лоад'), await names());

// ---------- Свои названия
await ev(() => game.settings.set('gachadnd', 'skillNames', 'Серия обычных ударов = Сайтама\nНе пройдёшь = Гэндальф\nнет такого навыка = что-то'));
await ev(() => gdt.settle());
now = await names();
check('свои названия: навык и кристалл переименованы, неизвестная строка пропущена', now.includes('Сайтама') && now.includes('Кристалл: Гэндальф') && !now.includes('что-то'), now);
await ev(async hero => { await (await gdt.mod('memory/inventory.js')).giveCrystal(game.actors.get(hero), { skillName: 'Серия обычных ударов' }); await gdt.settle(); }, hero);
check('свои названия: новый кристалл сразу со своим названием', (await names()).includes('Кристалл: Сайтама'), await names());
await ev(() => game.settings.set('gachadnd', 'skillNames', ''));
await ev(() => gdt.settle());
now = await names();
check('свои названия стёрты — вернулись названия модуля', now.includes('Серия обычных ударов') && !now.includes('Сайтама') && now.includes('Кристалл: Не пройдёшь'), now);

// ---------- Подменю «Свои названия навыков»
const menu = await ev(async () => {
    const cls = game.settings.menus.get('gachadnd.namesMenu')?.type;
    if (!cls) return null;
    const app = new cls();
    await app.render({ force: true });
    await gdt.sleep(400);
    const area = app.element.querySelector('textarea[name="gachadnd.skillNames"]');
    const r = { textarea: !!area, placeholder: area?.placeholder ?? '' };
    await app.close();
    return r;
});
check('подменю «Свои названия навыков»: многострочное поле', menu?.textarea && /=/.test(menu.placeholder), JSON.stringify(menu));

await ev(async s => { await game.settings.set('gachadnd', 'rudeNames', s.rude); await game.settings.set('gachadnd', 'skillNames', s.names); }, saved);
const errors = moduleErrors(f.log.slice(since));
check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
const failed = summary();
await f.close();
done(failed);
