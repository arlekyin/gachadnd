/**
 * Сборка журналов правил: src/rules/<журнал>/*.md → dist/packs/<компендиум>/*.json
 *
 * Текст страниц — упрощённый Markdown: заголовки (#, ##, ###), абзацы, списки (- и 1.),
 * таблицы (| a | b |), **жирный**, *курсив*, `код`. Справочные таблицы не пишутся руками,
 * а генерируются из данных модуля вставками {{имя}}, поэтому не расходятся с кодом:
 *   {{tags}}       — теги и пороги синергий
 *   {{skills}}     — реестр навыков по категориям со ссылками на компендиум
 *   {{economy}}    — золото, кристаллы и услуги по этажам 1–10 (значения по умолчанию)
 *   {{risks}}      — встроенные испытания Риска
 *   {{horsemen}}   — всадники Погибели
 */

import fs from 'fs';
import path from 'path';

const JOURNALS = [
    { dir: 'player', pack: 'gacha-rules', name: 'Правила Лабиринта' },
    { dir: 'gm', pack: 'gacha-gm', name: 'Справочник Мастера' }
];

const RARITY_LABELS = { gray: 'Серый', green: 'Зелёный', blue: 'Синий', purple: 'Фиолетовый', red: 'Красный', orange: 'Оранжевый' };
const RARITY_ORDER = Object.keys(RARITY_LABELS);
const SKILL_LABELS = {
    acr: 'Акробатика', ani: 'Уход за животными', arc: 'Магия', ath: 'Атлетика', dec: 'Обман', his: 'История',
    ins: 'Проницательность', itm: 'Запугивание', inv: 'Анализ', med: 'Медицина', nat: 'Природа', prc: 'Восприятие',
    prf: 'Выступление', per: 'Убеждение', rel: 'Религия', slt: 'Ловкость рук', ste: 'Скрытность', sur: 'Выживание'
};

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text) {
    return esc(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
}

function table(rows) {
    const [head, ...body] = rows;
    return `<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead>`
        + `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// Упрощённый Markdown → HTML
export function markdown(source, generators = {}) {
    const lines = source.replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) { i++; continue; }
        const directive = trimmed.match(/^\{\{(\w+)\}\}$/);
        if (directive) {
            if (!generators[directive[1]]) throw new Error(`неизвестная вставка {{${directive[1]}}}`);
            out.push(generators[directive[1]]());
            i++;
            continue;
        }
        const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
            i++;
            continue;
        }
        if (trimmed.startsWith('|')) {
            const rows = [];
            while (i < lines.length && lines[i].trim().startsWith('|')) {
                const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
                if (!cells.every(c => /^:?-+:?$/.test(c))) rows.push(cells.map(inline));
                i++;
            }
            out.push(table(rows));
            continue;
        }
        const list = trimmed.match(/^(-|\d+\.)\s+/);
        if (list) {
            const ordered = list[1] !== '-';
            const items = [];
            while (i < lines.length && /^\s*(-|\d+\.)\s+/.test(lines[i])) {
                items.push(inline(lines[i].trim().replace(/^(-|\d+\.)\s+/, '')));
                i++;
            }
            out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(t => `<li>${t}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
            continue;
        }
        const paragraph = [];
        while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||-\s|\d+\.\s|\{\{)/.test(lines[i].trim())) {
            paragraph.push(inline(lines[i].trim()));
            i++;
        }
        out.push(`<p>${paragraph.join('<br>')}</p>`);
    }
    return out.join('\n');
}

// ==========================================
// ВСТАВКИ ИЗ ДАННЫХ МОДУЛЯ
// ==========================================

function makeGenerators({ items, risks, synergyDictionary }) {
    const skills = items.map(i => i.item);
    const link = item => `@UUID[Compendium.gachadnd.gacha-skills.Item.${item._id}]{${esc(item.name)}}`;

    return {
        tags() {
            const dictionary = synergyDictionary;
            return Object.entries(dictionary).map(([tag, config]) => `<h3>${esc(tag)}</h3>` + table([
                ['Навыков', 'Синергия', 'Эффект'],
                ...config.thresholds.map(t => [String(t.count), esc(t.name), esc(t.desc ?? '')])
            ])).join('\n');
        },

        skills() {
            const byCategory = {};
            for (const item of skills) (byCategory[item.flags.gachadnd.category] ??= []).push(item);
            return Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b)).map(([category, list]) => {
                list.sort((a, b) => RARITY_ORDER.indexOf(a.flags.gachadnd.rarity) - RARITY_ORDER.indexOf(b.flags.gachadnd.rarity) || a.name.localeCompare(b.name));
                return `<h3>${esc(category)} — ${list.length}</h3>` + table([
                    ['Навык', 'Редкость', 'Теги', 'Перезарядка', 'Рангов'],
                    ...list.map(item => {
                        const f = item.flags.gachadnd;
                        return [link(item), RARITY_LABELS[f.rarity], esc((f.tags ?? []).join(', ') || '—'), esc(f.cooldown ?? 'Нет'), f.stacking ? '∞' : String(f.max_rank ?? 1)];
                    })
                ]);
            }).join('\n');
        },

        economy() {
            const base = floor => 100 * 1.5 ** (floor - 1);
            const r = n => Math.round(n);
            const rows = [['Этаж', 'База', 'Монстры', 'Элита', 'Босс', 'Кристаллы (сер./зел./син./фиол.)', 'Очистка', 'Обновление', 'Предметы в магазине']];
            for (let f = 1; f <= 10; f++) {
                const b = base(f);
                const items = f >= 7 ? 'обычные, необычные, редкие' : f >= 4 ? 'обычные, необычные' : 'обычные';
                rows.push([String(f), `${r(b)}`, `${r(b * 0.05)}–${r(b * 0.15)}`, `${r(b * 0.2)}–${r(b * 0.5)}`, `${r(b * 0.7)}–${r(b)}`,
                    [0.2, 0.5, 1.2, 3].map(k => r(b * k)).join(' / '), `${r(b * 0.5)}`, `${r(b * 0.2)}`, items]);
            }
            return table(rows);
        },

        risks() {
            return risks.map(risk => `<h3>${esc(risk.name)}</h3><p><em>${esc(risk.intro)}</em></p>` + table([
                ['Этап', 'Подходы'],
                ...risk.stages.map(s => [esc(s.name) + (s.group ? ' <strong>(все вместе)</strong>' : ''),
                    s.approaches.map(a => `${esc(a.label)} — ${SKILL_LABELS[a.skill] ?? a.skill}, Сл ${a.dc ? (a.dc > 0 ? `+${a.dc}` : a.dc) : '±0'}`).join('<br>')])
            ]) + `<p><strong>Обвал:</strong> ${esc(risk.collapse.text)}</p>`).join('\n');
        },

        horsemen() {
            return skills.filter(i => i.flags.gachadnd.horseman)
                .map(item => `<h3>${link(item)}</h3>${item.system.description.value.split('<hr>')[1] ?? ''}`)
                .join('\n');
        }
    };
}

// ==========================================
// СБОРКА
// ==========================================

export function buildRules({ srcDir, distDir, items, risks, stableId, synergyDictionary }) {
    const generators = makeGenerators({ items, risks, synergyDictionary });
    const built = [];
    for (const journal of JOURNALS) {
        const dir = path.join(srcDir, journal.dir);
        if (!fs.existsSync(dir)) continue;
        const journalId = stableId('rules', journal.pack);
        const pages = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map((file, index) => {
            const source = fs.readFileSync(path.join(dir, file), 'utf8');
            const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(file, '.md');
            const body = source.replace(/^#\s+.+$/m, '');
            const pageId = stableId('rules', journal.pack, file);
            let content;
            try {
                content = markdown(body, generators);
            } catch (e) {
                throw new Error(`rules/${journal.dir}/${file}: ${e.message}`);
            }
            return {
                _id: pageId,
                _key: `!journal.pages!${journalId}.${pageId}`,
                name: title,
                type: 'text',
                title: { show: true, level: 1 },
                text: { format: 1, content },
                sort: (index + 1) * 100000,
                ownership: { default: -1 },
                flags: {}
            };
        });
        const entry = {
            _id: journalId,
            _key: `!journal!${journalId}`,
            name: journal.name,
            pages,
            folder: null,
            sort: 0,
            ownership: { default: 0 },
            flags: {}
        };
        const out = path.join(distDir, journal.pack);
        fs.rmSync(out, { recursive: true, force: true });
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, `${journal.pack}.json`), JSON.stringify(entry, null, 2) + '\n', 'utf8');
        built.push({ name: journal.name, pages: pages.length });
    }
    return built;
}
