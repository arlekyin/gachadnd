// Словари перевода: node tools/i18n/extract.mjs [язык…] (по умолчанию — en)
// Собирает все фразы t('…') из scripts/ и {{t "…"}} из templates/, а также идентификаторы для показа (теги,
// категории — scripts/core/ids.js), и обновляет i18n/<язык>.json: новые фразы — с пустым переводом, готовые
// переводы сохраняются, пропавшие фразы — уходят (их список и сколько переведено — в отчёте).
// Перевод фразы с подстановками сохраняет {имя}: «Обмен {a} ⇄ {b}» → «Trade {a} ⇄ {b}».
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '../..');
const langs = process.argv.slice(2).filter(a => !a.startsWith('-'));
if (!langs.length) langs.push('en');

const walk = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
});
const unquote = (q, body) => body.replace(new RegExp(`\\\\${q}`, 'g'), q).replace(/\\n/g, '\n').replace(/\\\\/g, '\\');

/** Фразы: t('…'), t("…"), t(`…` без ${}) — первый аргумент-литерал */
/** Без комментариев: блочных и строчных во всю строку (в примерах в комментариях — не фразы) */
export const stripComments = code => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
export function phrasesOf(code) {
    code = stripComments(code);
    const out = [];
    const re = /(?<![\w$.])t\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    for (const m of code.matchAll(re)) if (!(m[1] === '`' && m[2].includes('${'))) out.push(unquote(m[1], m[2]));
    return out;
}
export function templatePhrases(html) {
    html = html.replace(/\{\{!--[\s\S]*?--\}\}/g, '');
    return [...html.matchAll(/\{\{\s*t\s+(["'])((?:\\.|(?!\1)[^\\])*)\1/g)].map(m => unquote(m[1], m[2]));
}
/** Идентификаторы для показа: массивы TAGS и CATEGORIES в ids.js */
export function idsOf(code) {
    const out = [];
    for (const name of ['TAGS', 'CATEGORIES']) {
        const m = code.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
        if (m) out.push(...[...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
    }
    return out;
}

export function collect() {
    const found = new Map();
    const add = (text, where) => { if (!found.has(text)) found.set(text, where); };
    for (const f of walk(path.join(ROOT, 'scripts'), '.js')) for (const p of phrasesOf(fs.readFileSync(f, 'utf8'))) add(p, path.relative(ROOT, f));
    for (const f of walk(path.join(ROOT, 'templates'), '.hbs')) for (const p of templatePhrases(fs.readFileSync(f, 'utf8'))) add(p, path.relative(ROOT, f));
    for (const p of idsOf(fs.readFileSync(path.join(ROOT, 'scripts/core/ids.js'), 'utf8'))) add(p, 'scripts/core/ids.js');
    return found;
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop())) {
    const found = collect();
    fs.mkdirSync(path.join(ROOT, 'i18n'), { recursive: true });
    for (const lang of langs) {
        const file = path.join(ROOT, 'i18n', `${lang}.json`);
        const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        const next = {};
        for (const text of [...found.keys()].sort((a, b) => a.localeCompare(b, 'ru'))) next[text] = old[text] ?? '';
        const gone = Object.keys(old).filter(k => !found.has(k));
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
        const done = Object.values(next).filter(Boolean).length;
        console.log(`${lang}: фраз ${found.size}, переведено ${done}, новых ${[...found.keys()].filter(k => !(k in old)).length}, ушло ${gone.length}`);
        for (const g of gone) console.log(`  ушла: ${g}${old[g] ? ` → ${old[g]}` : ''}`);
    }
}
