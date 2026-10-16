/**
 * Проверки в настоящей Foundry: вход в тестовый мир через Playwright.
 *
 * Foundry уже запущена с тестовым миром (по умолчанию http://localhost:30000, пользователь Claude
 * без пароля). Харнесс заходит под пользователем, ждёт game.ready и отдаёт страницу; проверки
 * выполняются кодом в странице (page.evaluate) против настоящих dnd5e и модуля.
 * Игровые миры не трогаются: харнесс отказывается работать, если активен не тот мир.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OUT = path.join(ROOT, 'tools/foundry/out');

export const URL = process.env.FOUNDRY_URL ?? 'http://localhost:30000';
export const WORLD = process.env.FOUNDRY_WORLD ?? 'testrogalika';
export const USER = process.env.FOUNDRY_USER ?? 'Claude';
const PASSWORD = process.env.FOUNDRY_PASSWORD ?? '';

/** Состояние сервера: { active, world, version, system, ... } */
export async function status() {
    const res = await fetch(`${URL}/api/status`);
    return res.json();
}

/**
 * Тестовый мир запущен: если в Foundry не запущен ни один мир, запустить тестовый (нужно, чтобы
 * у Foundry не было пароля администратора). Чужой активный мир не закрывается — ошибка.
 */
export async function ensureWorld(browser) {
    let st = await status();
    if (st.active) {
        if (st.world !== WORLD) throw new Error(`Активен мир «${st.world}», а не тестовый «${WORLD}» — останавливаюсь`);
        return st;
    }
    const res = await fetch(`${URL}/setup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'launchWorld', world: WORLD })
    });
    // v14 запускает мир только через сокет со страницы настройки — нажать «запустить» у тестового мира
    if (!res.ok && browser) await launchFromSetup(browser);
    else if (!res.ok) throw new Error(`Не удалось запустить мир «${WORLD}»: ${res.status} ${await res.text()}`);
    for (let i = 0; i < 120; i++) {
        st = await status();
        if (st.active && st.world === WORLD) return st;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Мир «${WORLD}» не запустился за 2 минуты`);
}

async function launchFromSetup(browser) {
    const page = await browser.newPage();
    try {
        await page.goto(`${URL}/setup`);
        const play = `[data-package-id="${WORLD}"] .control.play`;
        await page.waitForSelector(play, { state: 'attached', timeout: 60000 });
        // Обучающий тур и прочие оверлеи перекрывают список миров
        await page.keyboard.press('Escape');
        await page.evaluate(() => document.querySelectorAll('.tour-overlay, .tour-fadeout, .tour').forEach(e => e.remove()));
        await page.$eval(play, el => el.click());
        // Окно миграции появляется, только если мир сделан в старой версии
        const yes = await page.waitForSelector('dialog button[data-action="yes"], dialog button[data-action="confirm"]', { timeout: 5000 }).catch(() => null);
        if (yes) await yes.click();
        await page.waitForURL(/\/(game|join)/, { timeout: 120000 });
    } finally {
        await page.close();
    }
}

/**
 * Закрыть тестовый мир (для сборки компендиумов: Foundry держит их файлы).
 * Нужен вход Мастером: мир закрывает game.shutDown().
 */
export async function shutdownWorld(page) {
    await page.evaluate(() => game.shutDown());
    for (let i = 0; i < 60; i++) {
        if (!(await status()).active) return;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Мир не закрылся за минуту');
}

/**
 * Раннер (run.mjs) гоняет проверки в одном браузере: под ним connect() отдаёт общую страницу, а close()
 * и done() её не закрывают. Без раннера каждая проверка, как раньше, открывает свой браузер.
 */
const runner = () => globalThis.gdRunner ?? null;
let shared = null;

/**
 * Войти в мир и дождаться game.ready.
 * @returns {{ page, browser, shot, close, log }} log — журнал этой проверки
 */
export async function connect(options = {}) {
    if (runner()) {
        // Страница не пережила прошлую проверку (сервер перезапускался, вкладка упала) — новый вход
        if (shared) await reload(shared.session.page).catch(async () => {
            await shared.session.browser.close().catch(() => {});
            shared = await open(options);
        });
        else shared = await open(options);
        shared.log = [];
        return { ...shared.session, log: shared.log, close: async () => {} };
    }
    const own = await open(options);
    own.log = [];
    return { ...own.session, log: own.log, close: () => own.session.browser.close() };
}

async function open({ width = 1600, height = 900, headless = !args().headed, slowMo = slowArg() } = {}) {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch({ headless: headless && !slowMo, slowMo, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
    await ensureWorld(browser);
    const page = await browser.newPage({ viewport: { width, height } });
    const state = { log: [] };
    page.on('pageerror', e => {
        const where = (e.stack ?? '').split('\n').slice(1, 4).map(l => l.trim()).join(' ← ');
        state.log.push(`pageerror: ${e.message} ${where}`);
        console.log('ОШИБКА СТРАНИЦЫ', e.message, '\n   ', where);
    });
    page.on('console', m => {
        const t = m.text();
        if (m.type() === 'error' || m.type() === 'warning' || /gachadnd/i.test(t)) state.log.push(`${m.type()}: ${t}`);
        if (m.type() === 'error' || (m.type() === 'warning' && /gachadnd/i.test(t))) console.log('  ›', m.type(), t);
    });

    await page.goto(`${URL}/join`);
    // Выбор пользователя: v13 — name="userid", v14 — name="userId"
    const select = 'select[name="userid"], select[name="userId"]';
    await page.waitForSelector(select, { timeout: 60000 });
    const userId = await page.$eval(select, (el, name) => [...el.options].find(o => o.textContent.trim() === name)?.value, USER);
    if (!userId) throw new Error(`Нет пользователя «${USER}» на странице входа`);
    await page.selectOption(select, userId);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([page.waitForURL(/\/game/, { timeout: 60000 }), page.click('button[name="join"]')]);
    await page.waitForFunction(() => window.game?.ready, null, { polling: 250, timeout: 120000 });
    // Слой анимаций модуля и сцена иногда дорисовываются после ready
    await page.waitForTimeout(1500);

    // Журнал пишется в state.log: под раннером connect() подменяет его на журнал каждой проверки
    return Object.defineProperty({
        session: { page, browser, shot: name => page.screenshot({ path: path.join(OUT, `${name}.png`) }) }
    }, 'log', { get: () => state.log, set: value => { state.log = value; } });
}

/**
 * Раннер: перед каждой проверкой страница перезагружается — вход сохраняется, мир грузится заново.
 * Одна страница не переживает десятки пересозданных сцен подряд на программном рендере.
 */
async function reload(page) {
    await page.reload();
    await page.waitForFunction(() => window.game?.ready, null, { polling: 250, timeout: 120000 });
    await page.waitForTimeout(1000);
}

/** Раннер: закрыть общий браузер в конце прогона */
export async function closeShared() {
    if (shared) await shared.session.browser.close();
    shared = null;
}

/** Конец проверки: без раннера — код выхода процесса, под раннером — итог в общий счёт */
export function done(failed) {
    const r = runner();
    if (r) { r.failed = (r.failed ?? 0) + (failed ? 1 : 0); return; }
    process.exit(failed ? 1 : 0);
}

/** --slow — пауза 400 мс перед каждым действием браузера, --slow=1000 — своя; с ней окно всегда видно */
function slowArg() {
    const slow = args().slow;
    return slow === undefined ? 0 : slow === true ? 400 : Number(slow) || 0;
}

/**
 * Ошибки модуля в журнале страницы: без ошибок чужих модулей мира (их баги — не наши), а
 * fifthpendium падает на создании любого персонажа (cleanName is not defined).
 */
const FOREIGN = /fifthpendium|combatbooster|image-hover|vision-5e|SLighting/;
export function moduleErrors(log) {
    return log.filter(l => /pageerror|error:.*gachadnd/.test(l) && !FOREIGN.test(l));
}

/** Простой набор проверок с итогом в консоли */
export function checker() {
    const results = [];
    const check = (name, ok, detail = '') => {
        results.push({ name, ok: !!ok, detail });
        console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
    };
    const summary = () => {
        const failed = results.filter(r => !r.ok);
        console.log(`\nИтог: ${results.length - failed.length}/${results.length}`);
        return failed.length;
    };
    return { check, summary, results };
}

/** Аргументы вида --headed --only=x → { headed: true, only: 'x' } */
export function args() {
    return Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
        const [k, v] = a.slice(2).split('=');
        return [k, v ?? true];
    }));
}
