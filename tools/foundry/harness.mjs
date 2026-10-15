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
export async function ensureWorld() {
    let st = await status();
    if (st.active) {
        if (st.world !== WORLD) throw new Error(`Активен мир «${st.world}», а не тестовый «${WORLD}» — останавливаюсь`);
        return st;
    }
    const res = await fetch(`${URL}/setup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'launchWorld', world: WORLD })
    });
    if (!res.ok) throw new Error(`Не удалось запустить мир «${WORLD}»: ${res.status} ${await res.text()}`);
    for (let i = 0; i < 120; i++) {
        st = await status();
        if (st.active && st.world === WORLD) return st;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Мир «${WORLD}» не запустился за 2 минуты`);
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
 * Войти в мир и дождаться game.ready.
 * @returns {{ page, browser, shot, close, log }}
 */
export async function connect({ width = 1600, height = 900, headless = !args().headed, slowMo = slowArg() } = {}) {
    await ensureWorld();
    fs.mkdirSync(OUT, { recursive: true });

    const browser = await chromium.launch({ headless: headless && !slowMo, slowMo, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width, height } });
    const log = [];
    page.on('pageerror', e => {
        const where = (e.stack ?? '').split('\n').slice(1, 4).map(l => l.trim()).join(' ← ');
        log.push(`pageerror: ${e.message} ${where}`);
        console.log('ОШИБКА СТРАНИЦЫ', e.message, '\n   ', where);
    });
    page.on('console', m => {
        const t = m.text();
        if (m.type() === 'error' || m.type() === 'warning' || /gachadnd/i.test(t)) log.push(`${m.type()}: ${t}`);
        if (m.type() === 'error' || (m.type() === 'warning' && /gachadnd/i.test(t))) console.log('  ›', m.type(), t);
    });

    await page.goto(`${URL}/join`);
    await page.waitForSelector('select[name="userid"]', { timeout: 60000 });
    const userId = await page.$eval('select[name="userid"]', (el, name) => [...el.options].find(o => o.textContent.trim() === name)?.value, USER);
    if (!userId) throw new Error(`Нет пользователя «${USER}» на странице входа`);
    await page.selectOption('select[name="userid"]', userId);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([page.waitForURL(/\/game/, { timeout: 60000 }), page.click('button[name="join"]')]);
    await page.waitForFunction(() => window.game?.ready, null, { polling: 250, timeout: 120000 });
    // Слой анимаций модуля и сцена иногда дорисовываются после ready
    await page.waitForTimeout(1500);

    return {
        page, browser, log,
        shot: name => page.screenshot({ path: path.join(OUT, `${name}.png`) }),
        close: () => browser.close()
    };
}

/** --slow — пауза 400 мс перед каждым действием браузера, --slow=1000 — своя; с ней окно всегда видно */
function slowArg() {
    const slow = args().slow;
    return slow === undefined ? 0 : slow === true ? 400 : Number(slow) || 0;
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
