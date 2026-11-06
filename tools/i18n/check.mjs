// Что ещё не обёрнуто в t(): node tools/i18n/check.mjs [--list путь] [--all]
// Строки на русском в scripts/ и текст на русском в templates/, которые показываются как есть. Не в счёт:
// фразы внутри t(…) и {{t …}}, идентификаторы (теги, категории — scripts/core/ids.js), журнал разработчика
// (console.*), комментарии, строки с пометкой «// i18n: данные» (по ним модуль сравнивает и ищет), шейдеры GLSL,
// сборочные файлы (synergy-tiers.js — из YAML, переводится вместе с содержимым).
// Без аргументов — сводка по файлам (больше всего — сверху); --list файл — сами строки; --all — все файлы.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments, idsOf } from './extract.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '../..');
const CYR = /[А-Яа-яЁё]/;
const SKIP = [/synergy-tiers\.js$/, /^scripts[\\/]synergy-tiers\.js$/];
const IDS = new Set(idsOf(fs.readFileSync(path.join(ROOT, 'scripts/core/ids.js'), 'utf8')));

const walk = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
});

/** Русские литералы кода вне t(), console.* и идентификаторов: [{ line, text }] */
/**
 * Строки кода: проход по символам — кавычки, шаблонные строки с вложенными ${…}, комментарии, регулярки.
 * @returns {{ kind: 'str'|'tpl', text: string, at: number }[]}  у шаблонной строки text — только её текст, без ${…}
 */
function literals(code) {
    const out = [];
    let i = 0;
    const prevSignificant = at => { let k = at - 1; while (k >= 0 && /\s/.test(code[k])) k--; return k >= 0 ? code[k] : ''; };
    const readQuoted = q => { const start = i; i++; while (i < code.length && code[i] !== q) { if (code[i] === '\\') i++; i++; } i++; return { start, end: i }; };
    // Шаблонная строка с позиции `; вложенные ${…} разбираются как код
    const readTemplate = () => {
        const start = i; let textOut = ''; i++;
        while (i < code.length && code[i] !== '`') {
            if (code[i] === '\\') { textOut += code[i] + (code[i + 1] ?? ''); i += 2; continue; }
            if (code[i] === '$' && code[i + 1] === '{') { i += 2; scan('}'); i++; continue; }
            textOut += code[i++];
        }
        i++;
        out.push({ kind: 'tpl', text: textOut, at: start });
    };
    // Код до закрывающей скобки close (или до конца)
    const scan = close => {
        let depth = 0;
        while (i < code.length) {
            const c = code[i];
            if (close && c === close && depth === 0) return;
            if (c === '{') depth++;
            else if (c === '}') depth--;
            if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
            if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2); i = i < 0 ? code.length : i + 2; continue; }
            if (c === '/' && /[(,=:[!&|?{};]|^$/.test(prevSignificant(i))) {
                i++; let cls = false;
                while (i < code.length && (code[i] !== '/' || cls)) { if (code[i] === '\\') i++; else if (code[i] === '[') cls = true; else if (code[i] === ']') cls = false; i++; }
                i++; continue;
            }
            if (c === '\'' || c === '"') { const { start, end } = readQuoted(c); out.push({ kind: 'str', text: code.slice(start + 1, end - 1), at: start }); continue; }
            if (c === '`') { readTemplate(); continue; }
            i++;
        }
    };
    scan(null);
    return out;
}

export function codeLeftovers(code) {
    const out = [];
    const lineAt = at => code.slice(0, at).split('\n').length;
    for (const lit of literals(code)) {
        if (!CYR.test(lit.text) || IDS.has(lit.text)) continue;
        const lineStart = code.lastIndexOf('\n', lit.at) + 1;
        const before = code.slice(lineStart, lit.at);
        if (/(?<![\w$.])t\(\s*$/.test(before)) continue;
        const lineEnd = code.indexOf('\n', lit.at);
        const line = code.slice(lineStart, lineEnd < 0 ? code.length : lineEnd);
        if (/console\.(log|warn|error|info|debug)\(/.test(line)) continue;
        // Помеченные данные (по ним модуль сравнивает и ищет); шейдеры GLSL — русские у них только комментарии
        if (/i18n: данные/.test(line) || /^\s*(#version|precision )/.test(lit.text)) continue;
        const text = lit.text.replace(/\s+/g, ' ').trim();
        out.push({ line: lineAt(lit.at), text: text.length > 90 ? text.slice(0, 90) + '…' : text });
    }
    return out;
}

/** Текст шаблона на русском вне {{t …}}: между тегами и в подписях-атрибутах */
export function templateLeftovers(html) {
    const out = [];
    html.replace(/\{\{!--[\s\S]*?--\}\}/g, m => m.replace(/[^\n]/g, ' ')).split('\n').forEach((line, i) => {
        // {{t "… {имя} …"}}: в фразе есть фигурные скобки — помощник перевода убрать целиком до прочих мустачей
        line = line.replace(/\{\{\s*t\s+(["'])(?:\\.|(?!\1)[^\\])*\1[^}]*\}\}/g, ' ');
        const plain = line.replace(/\{\{[^}]*\}\}/g, ' ');
        for (const chunk of plain.split(/<[^>]*>/)) if (CYR.test(chunk) && chunk.trim()) out.push({ line: i + 1, text: chunk.trim().slice(0, 90) });
        for (const m of line.matchAll(/(?:title|placeholder|data-tooltip|aria-label|alt)="([^"]*)"/g)) if (CYR.test(m[1].replace(/\{\{[^}]*\}\}/g, ''))) out.push({ line: i + 1, text: `${m[0].split('=')[0]}: ${m[1].slice(0, 80)}` });
    });
    return out;
}

export function report() {
    const files = [];
    for (const f of walk(path.join(ROOT, 'scripts'), '.js')) {
        const rel = path.relative(ROOT, f);
        if (SKIP.some(r => r.test(rel))) continue;
        files.push({ file: rel, left: codeLeftovers(fs.readFileSync(f, 'utf8')) });
    }
    for (const f of walk(path.join(ROOT, 'templates'), '.hbs')) files.push({ file: path.relative(ROOT, f), left: templateLeftovers(fs.readFileSync(f, 'utf8')) });
    return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
    const args = process.argv.slice(2);
    const files = report();
    const listAt = args.indexOf('--list');
    if (listAt >= 0) {
        const want = path.normalize(args[listAt + 1] ?? '');
        for (const { file, left } of files.filter(x => path.normalize(x.file) === want)) for (const l of left) console.log(`${file}:${l.line}  ${l.text}`);
    } else {
        const todo = files.filter(x => x.left.length).sort((a, b) => b.left.length - a.left.length);
        const total = todo.reduce((s, x) => s + x.left.length, 0);
        const clean = files.length - todo.length;
        console.log(`Не обёрнуто: ${total} строк в ${todo.length} файлах; готовы ${clean} из ${files.length}.`);
        for (const { file, left } of args.includes('--all') ? todo : todo.slice(0, 25)) console.log(`${String(left.length).padStart(5)}  ${file}`);
    }
}
