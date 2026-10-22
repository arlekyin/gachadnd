/**
 * Выпуск модуля: node tools/release.mjs [--no-build]
 *
 * Собирает компендиумы (npm run build — мир Foundry должен быть закрыт: открытый держит паки), складывает в
 * release/gachadnd/ только то, что нужно Foundry, и пакует в release/gachadnd.zip. Рядом — release/module.json
 * со ссылкой download на архив этой версии. Оба файла прикладываются к GitHub-релизу с тегом v<версия>:
 * manifest в module.json смотрит на releases/latest/download/module.json, поэтому Foundry видит новую версию сама.
 *
 * Архив — файлы модуля в корне, пути через «/»: на Windows — системный tar (bsdtar), иначе zip.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release");
const STAGE = path.join(OUT, "gachadnd");
const ZIP = path.join(OUT, "gachadnd.zip");

// Что входит в выпуск; внутри — что пропустить
const INCLUDE = ["module.json", "scripts", "styles", "templates", "packs", "data", "assets", "README.md", "LICENSE", "LICENSE-CONTENT.md"];
const SKIP = [
    /^packs\/_old_json/, /^packs\/[^/]+\.db$/, /^packs\/[^/]+\/(LOCK|LOG|LOG\.old)$/,
    /^assets\/battlemap\/weapons\//, /^assets\/bestiary\/devourer\.png$/,
    /^scripts\/synergy-tiers\.js$/
];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "module.json"), "utf8"));
const version = manifest.version;
const repo = manifest.url;
if (!version || !repo) throw new Error("В module.json нет version или url");

if (!process.argv.includes("--no-build")) {
    console.log("Сборка компендиумов…");
    execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
}
// Без собранных синергий модуль не загрузится
if (!fs.existsSync(path.join(ROOT, "scripts/memory/synergy/synergy-tiers.js"))) throw new Error("Нет scripts/memory/synergy/synergy-tiers.js — нужен npm run build");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
let files = 0, bytes = 0;
const copy = rel => {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) throw new Error(`Нет ${rel}`);
    if (fs.statSync(src).isDirectory()) {
        for (const name of fs.readdirSync(src)) copy(`${rel}/${name}`);
        return;
    }
    if (SKIP.some(re => re.test(rel))) return;
    const dst = path.join(STAGE, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    files++; bytes += fs.statSync(src).size;
};
INCLUDE.forEach(copy);

// Манифест выпуска: download — архив именно этой версии
const released = { ...manifest, download: `${repo}/releases/download/v${version}/gachadnd.zip` };
const text = JSON.stringify(released, null, 2) + "\n";
fs.writeFileSync(path.join(STAGE, "module.json"), text);
fs.writeFileSync(path.join(OUT, "module.json"), text);

const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : null;
// Верхний уровень перечислен по именам: в архиве пути без «./»
const top = fs.readdirSync(STAGE);
const pack = tar
    ? spawnSync(tar, ["-a", "-cf", ZIP, "-C", STAGE, ...top], { stdio: "inherit" })
    : spawnSync("zip", ["-qr", ZIP, ...top], { cwd: STAGE, stdio: "inherit" });
if (pack.status !== 0) throw new Error("Архив не собран");

console.log(`Версия ${version}: ${files} файлов, ${(bytes / 1048576).toFixed(1)} МБ → ${path.relative(ROOT, ZIP)} (${(fs.statSync(ZIP).size / 1048576).toFixed(1)} МБ)`);
console.log(`К релизу v${version} приложить: release/gachadnd.zip и release/module.json`);
