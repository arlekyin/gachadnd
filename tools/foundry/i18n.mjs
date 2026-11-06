// Каркас перевода в настоящей Foundry: node tools/foundry/i18n.mjs [--headed]
// Клиент на английском, словарь i18n/en.json на время проверки — две фразы: t() и {{t}} переводят, фраза без
// перевода остаётся русской, подстановки {имя} работают; {{tagLabel}} — подпись тега, а идентификатор в данных
// прежний; название настройки модуля переведено. В конце — язык клиента и словарь как были.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect, checker, moduleErrors, done } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DICT = path.join(ROOT, 'i18n', 'en.json');
const saved = fs.existsSync(DICT) ? fs.readFileSync(DICT, 'utf8') : null;
const dict = saved ? JSON.parse(saved) : {};
fs.writeFileSync(DICT, JSON.stringify({ ...dict, 'огонь': 'fire', 'Эффекты модуля': 'Module effects', 'Осталось {n}': '{n} left' }, null, 2));

const f = await connect();
const { page } = f;
const { check, summary } = checker();
const ev = (fn, arg) => page.evaluate(fn, arg);
const ready = async () => { await page.waitForFunction(() => window.game?.ready, null, { polling: 250, timeout: 120000 }); await page.waitForTimeout(1500); };
// Смена языка перезагружает страницу сама и с задержкой — вызов может оборваться; ждём, пока мир загрузится уже
// с новым языком, и ещё немного, чтобы перезагрузка точно прошла
const setLang = async lang => {
    await ev(lang => game.settings.set('core', 'language', lang), lang).catch(() => {});
    for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(1000);
        const now = await ev(() => window.game?.ready ? game.i18n.lang : null).catch(() => null);
        if (now === lang) break;
        if (i === 30) await page.reload().catch(() => {});
    }
    await ready();
    await page.waitForTimeout(2500);
    await ready();
};

const lang = await ev(() => game.settings.get('core', 'language'));
try {
    await setLang('en');
    const since = f.log.length;
    const r = await ev(async () => {
        const { t, translating } = await import('/modules/gachadnd/scripts/core/i18n.js');
        const { tagLabel, TAGS } = await import('/modules/gachadnd/scripts/core/ids.js');
        return {
            lang: game.i18n.lang, on: translating(),
            word: t('огонь'), missing: t('Без перевода'), filled: t('Осталось {n}', { n: 3 }), raw: t('Ещё {n} шт', { n: 2 }),
            hbs: Handlebars.compile('{{t "огонь"}} · {{tagLabel tag}} · {{t "Осталось {n}" n=5}}')({ tag: 'огонь' }),
            label: tagLabel('огонь'), id: TAGS.includes('огонь'),
            setting: game.settings.settings.get('gachadnd.effects')?.name
        };
    });
    check('клиент на английском — словарь i18n/en.json загружен', r.lang === 'en' && r.on, JSON.stringify(r));
    check('t(): переведено — «fire»; без перевода — русская фраза; подстановки {n} — в обоих случаях', r.word === 'fire' && r.missing === 'Без перевода' && r.filled === '3 left' && r.raw === 'Ещё 2 шт', JSON.stringify(r));
    check('шаблоны: {{t}} и {{tagLabel}} переводят, подстановка в {{t … n=5}}', r.hbs === 'fire · fire · 5 left', r.hbs);
    check('тег: подпись — «fire», идентификатор в данных — прежний «огонь»', r.label === 'fire' && r.id, JSON.stringify(r));
    check('название настройки модуля переведено', r.setting === 'Module effects', r.setting);
    const errors = moduleErrors(f.log.slice(since));
    check('ошибок модуля в консоли нет', !errors.length, errors.slice(0, 3).join(' | '));
} finally {
    if (saved === null) fs.rmSync(DICT, { force: true }); else fs.writeFileSync(DICT, saved);
    await setLang(lang).catch(() => {});
}
const back = await ev(() => game.i18n.lang);
check('язык клиента и словарь — как были', back === lang && (saved === null || fs.readFileSync(DICT, 'utf8') === saved), `${back} / ${lang}`);
const failed = summary();
await f.close();
done(failed);
