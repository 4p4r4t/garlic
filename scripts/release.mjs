#!/usr/bin/env node
// Выпуск релиза Garlic (ТЗ §12):
//
//   npm run release -- <версия> [--dry-run] [--notes <файл.md>]
//
// Шаги: проверки (semver, ветка main, чистое дерево, gh) -> подъём версии в
// package.json, package-lock.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml
// (+ Cargo.lock через cargo) -> `npm run tauri build` -> архив
// garlic-vX.Y.Z-windows-x64.zip (Garlic.exe + установщик NSIS + README.txt + LICENSE,
// в папке garlic-vX.Y.Z-windows-x64/ как у 0.1.0) -> коммит «Release vX.Y.Z» и тег
// vX.Y.Z -> push коммита и тега -> `gh release create`.
//
// Коммит и тег делаются ПОСЛЕ успешной сборки: упавшая сборка не оставляет
// в истории релизный коммит и тег (при любой ошибке версии откатываются).
//
// --dry-run: всё локально (проверки, подъём версии, сборка, архив), но без
// коммита, тега, push и релиза; изменённые файлы возвращаются как были.
// Заметки релиза: --notes <файл> или (без редактора) текст по умолчанию со
// списком коммитов с прошлого тега; к ним добавляется SHA-256 архива.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const GH_FALLBACK = "C:\\Program Files\\GitHub CLI\\gh.exe";

/** Файлы, в которых поднимается версия (и которые возвращаются при откате). */
const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

// ---- аргументы ----

function parseArgs(argv) {
  const args = { version: null, dryRun: false, notes: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--notes") args.notes = argv[++i] ?? "";
    else if (a.startsWith("--notes=")) args.notes = a.slice("--notes=".length);
    else if (a.startsWith("-")) fail(`неизвестный параметр: ${a}`);
    else if (args.version === null) args.version = a.replace(/^v/, "");
    else fail(`лишний аргумент: ${a}`);
  }
  return args;
}

function usage() {
  console.log(`Использование: npm run release -- <версия> [--dry-run] [--notes <файл.md>]

  <версия>        semver без «v»: 0.2.0, 1.0.0-beta.1
  --dry-run       всё, кроме коммита, тега, push и релиза; версии возвращаются
  --notes <файл>  текст заметок релиза (иначе — список коммитов с прошлого тега)`);
}

// ---- утилиты ----

function fail(msg) {
  console.error(`\nОшибка: ${msg}`);
  throw new ReleaseError(msg);
}
class ReleaseError extends Error {}

const step = (msg) => console.log(`\n==> ${msg}`);
const note = (msg) => console.log(`    ${msg}`);

/** Запуск команды; `capture` — вернуть stdout, иначе вывод идёт в консоль. */
function run(cmd, args, opts = {}) {
  const { capture = false, cwd = ROOT, allowFail = false, shell = false, env } = opts;
  const r = spawnSync(cmd, args, {
    cwd,
    shell,
    env: env ?? process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    if (allowFail) return { ok: false, out: "", err: String(r.error) };
    fail(`не удалось запустить «${cmd}»: ${r.error.message}`);
  }
  const ok = r.status === 0;
  if (!ok && !allowFail) fail(`«${[cmd, ...args].join(" ")}» завершилась с кодом ${r.status}\n${r.stderr ?? ""}`);
  return { ok, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const git = (args, opts) => run("git", args, { capture: true, ...opts });

function findGh() {
  const onPath = run(WIN ? "where.exe" : "which", ["gh"], { capture: true, allowFail: true });
  if (onPath.ok && onPath.out) return onPath.out.split(/\r?\n/)[0];
  if (existsSync(GH_FALLBACK)) return GH_FALLBACK;
  return null;
}

function cmpSemver(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  // Пререлиз меньше релиза.
  if (pa[4] && !pb[4]) return -1;
  if (!pa[4] && pb[4]) return 1;
  return (pa[4] ?? "") < (pb[4] ?? "") ? -1 : (pa[4] ?? "") > (pb[4] ?? "") ? 1 : 0;
}

// ---- подъём версии ----

/** Заменяет первое вхождение `re` (с группой 1 — префикс); ошибка, если не нашли. */
function bump(rel, re, version) {
  const path = join(ROOT, rel);
  const text = readFileSync(path, "utf8");
  if (!re.test(text)) fail(`в ${rel} не найдена строка версии`);
  writeFileSync(path, text.replace(re, `$1${version}$2`));
}

function bumpAll(version) {
  bump("package.json", /^(\s*"version":\s*")[^"]+(")/m, version);
  bump("src-tauri/tauri.conf.json", /^(\s*"version":\s*")[^"]+(")/m, version);
  bump("src-tauri/Cargo.toml", /^(version\s*=\s*")[^"]+(")/m, version);
  // package-lock.json: корневая версия и версия пакета «» (первые два вхождения).
  const lockPath = join(ROOT, "package-lock.json");
  if (existsSync(lockPath)) {
    let n = 0;
    const lock = readFileSync(lockPath, "utf8").replace(/^(\s*"version":\s*")[^"]+(")/gm, (m, a, b) =>
      n++ < 2 ? `${a}${version}${b}` : m,
    );
    writeFileSync(lockPath, lock);
  }
  // Cargo.lock: только записи пакетов рабочей области (garlic).
  run("cargo", ["update", "--workspace", "--offline"], {
    cwd: join(ROOT, "src-tauri"),
    env: cargoEnv(),
  });
  const cargoLock = readFileSync(join(ROOT, "src-tauri/Cargo.lock"), "utf8");
  if (!new RegExp(`name = "garlic"\\r?\\nversion = "${version.replace(/\./g, "\\.")}"`).test(cargoLock)) {
    fail("Cargo.lock не обновился до новой версии");
  }
}

function cargoEnv() {
  const env = { ...process.env };
  const bin = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cargo", "bin");
  // На Windows ключ обычно «Path»: в копии process.env регистр важен, поэтому
  // дописываем к существующему ключу, а не заводим второй «PATH».
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  if (existsSync(bin)) env[key] = `${bin}${WIN ? ";" : ":"}${env[key] ?? ""}`;
  return env;
}

// ---- артефакты ----

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function mb(path) {
  return `${(statSync(path).size / 1024 / 1024).toFixed(1)} МБ`;
}

function assemble(version) {
  const tag = `v${version}`;
  const name = `garlic-${tag}-windows-x64`;
  const exe = join(ROOT, "src-tauri/target/release/garlic.exe");
  const setup = join(ROOT, `src-tauri/target/release/bundle/nsis/Garlic_${version}_x64-setup.exe`);
  for (const f of [exe, setup]) if (!existsSync(f)) fail(`после сборки нет файла ${f}`);

  const outDir = join(ROOT, "release");
  const stage = join(outDir, name);
  const zip = join(outDir, `${name}.zip`);
  rmSync(stage, { recursive: true, force: true });
  rmSync(zip, { force: true });
  mkdirSync(stage, { recursive: true });

  copyFileSync(exe, join(stage, "Garlic.exe"));
  copyFileSync(setup, join(stage, `Garlic_${version}_x64-setup.exe`));
  copyFileSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
  // README.txt: шаблон scripts/release-readme.txt; UTF-8 с BOM и CRLF, как у 0.1.0.
  const readme = readFileSync(join(ROOT, "scripts/release-readme.txt"), "utf8")
    .replace(/^\uFEFF/, "")
    .replaceAll("{{VERSION}}", version)
    .replace(/\r?\n/g, "\r\n");
  writeFileSync(join(stage, "README.txt"), `\uFEFF${readme}`);

  // zip: bsdtar из Windows (записи с «/», папка архива — как у 0.1.0); иначе PowerShell.
  const sysTar = WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  if (existsSync(sysTar) || !WIN) {
    run(sysTar, ["-a", "-c", "-f", zip, "-C", outDir, name]);
  } else {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${stage}' -DestinationPath '${zip}' -Force`,
    ]);
  }
  if (!existsSync(zip)) fail("архив не создан");
  return { zip, name, tag };
}

// ---- заметки ----

function buildNotes({ version, tag, zip, name, notesFile, prevTag }) {
  const hash = sha256(zip);
  let body;
  if (notesFile) {
    if (!existsSync(notesFile)) fail(`файл заметок не найден: ${notesFile}`);
    body = readFileSync(notesFile, "utf8").trim();
  } else {
    const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
    const log = git(["log", "--no-merges", "--pretty=format:%s", range], { allowFail: true }).out;
    const commits = log
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !/^Release v\d/.test(s))
      .map((s) => `- ${s}`)
      .join("\n");
    body = [
      `Garlic ${tag}${prevTag ? ` (с ${prevTag})` : ""}`,
      "",
      "## Скачать",
      "",
      `**\`${name}.zip\`** — внутри:`,
      "- `Garlic.exe` — запускается без установки;",
      `- \`Garlic_${version}_x64-setup.exe\` — установщик с ярлыком в меню «Пуск»;`,
      "- `README.txt`, `LICENSE`.",
      "",
      "Нужны Windows 10/11 x64 и WebView2 Runtime (в Windows 11 уже установлен).",
      "",
      "## Изменения",
      "",
      commits || "- (без изменений в истории)",
      "",
      "Сборка не подписана, поэтому Windows SmartScreen может показать предупреждение: «Подробнее» → «Выполнить в любом случае».",
    ].join("\n");
  }
  return `${body}\n\nSHA-256 (zip): \`${hash}\`\n`;
}

// ---- основной ход ----

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.version) {
    usage();
    if (!args.help) process.exitCode = 1;
    return;
  }
  const { version, dryRun } = args;
  const tag = `v${version}`;
  if (dryRun) console.log("РЕЖИМ --dry-run: коммита, тега, push и релиза не будет; версии вернутся.");

  step("Проверки");
  if (!SEMVER.test(version)) fail(`«${version}» — не semver (ожидается X.Y.Z[-пререлиз])`);
  const current = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  if (cmpSemver(version, current) <= 0) {
    const msg = `версия ${version} не больше текущей ${current}`;
    if (dryRun) note(`предупреждение: ${msg}`);
    else fail(msg);
  }
  if (git(["tag", "--list", tag]).out) fail(`тег ${tag} уже существует`);

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (branch !== "main") {
    const msg = `релиз делается с ветки main, сейчас: ${branch}`;
    if (dryRun) note(`предупреждение (в настоящем релизе — ошибка): ${msg}`);
    else fail(msg);
  }
  const dirty = git(["status", "--porcelain"]).out;
  if (dirty) {
    const msg = `в рабочем дереве есть незакоммиченные изменения:\n${dirty}`;
    if (dryRun) note(`предупреждение (в настоящем релизе — ошибка): ${msg}`);
    else fail(msg);
  }
  const gh = findGh();
  if (!gh) {
    const msg = "не найден gh (GitHub CLI): установите или добавьте в PATH";
    if (dryRun) note(`предупреждение: ${msg}`);
    else fail(msg);
  } else {
    note(`gh: ${gh}`);
    if (!dryRun) run(gh, ["auth", "status"], { capture: true });
  }
  if (!existsSync(join(ROOT, "scripts/release-readme.txt"))) fail("нет scripts/release-readme.txt");
  const prevTag = git(["describe", "--tags", "--abbrev=0", "--match", "v*"], { allowFail: true }).out || null;
  note(`версия ${current} -> ${version}, предыдущий тег: ${prevTag ?? "нет"}`);

  // Снимок файлов версий для отката.
  const snapshot = new Map(
    VERSION_FILES.filter((f) => existsSync(join(ROOT, f))).map((f) => [f, readFileSync(join(ROOT, f))]),
  );
  const restore = () => {
    for (const [f, data] of snapshot) writeFileSync(join(ROOT, f), data);
  };
  let committed = false;
  process.once("SIGINT", () => {
    if (!committed) restore();
    process.exit(130);
  });

  try {
    step("Подъём версии");
    bumpAll(version);
    for (const f of VERSION_FILES) note(`${f} -> ${version}`);

    step("Сборка (npm run tauri build)");
    run("npm", ["run", "tauri", "build"], { shell: WIN, env: cargoEnv() });

    step("Архив");
    const art = assemble(version);
    note(`${art.zip} (${mb(art.zip)})`);
    note(`SHA-256: ${sha256(art.zip)}`);

    const notes = buildNotes({ version, tag, zip: art.zip, name: art.name, notesFile: args.notes, prevTag });
    const notesPath = join(ROOT, "release", `${art.name}-notes.md`);
    writeFileSync(notesPath, notes);
    note(`заметки: ${notesPath}`);

    if (dryRun) {
      step("Пропущено из-за --dry-run");
      note(`git commit -m "Release ${tag}"`);
      note(`git tag -a ${tag}`);
      note("git push origin main + git push origin " + tag);
      note(`gh release create ${tag} ${art.zip} --notes-file ${notesPath}`);
      restore();
      step("Версии возвращены");
      console.log(`\nГотово (dry-run). Архив: ${art.zip}`);
      return;
    }

    step("Коммит и тег");
    git(["add", ...VERSION_FILES.filter((f) => existsSync(join(ROOT, f)))]);
    git(["commit", "-m", `Release ${tag}`]);
    committed = true;
    git(["tag", "-a", tag, "-m", `Garlic ${tag}`]);

    step("Push");
    run("git", ["push", "origin", "main"]);
    run("git", ["push", "origin", tag]);

    step("GitHub Release");
    run(gh, ["release", "create", tag, art.zip, "--title", `Garlic ${tag}`, "--notes-file", notesPath, "--verify-tag"]);
    console.log(`\nГотово: релиз ${tag} опубликован.`);
  } catch (e) {
    if (!committed) {
      restore();
      console.error("Версии возвращены к исходным.");
    } else {
      console.error(
        "Коммит и тег уже созданы локально; повторите push/релиз вручную (git push origin main; git push origin " +
          tag +
          "; gh release create ...).",
      );
    }
    throw e;
  }
}

try {
  main();
} catch (e) {
  if (!(e instanceof ReleaseError)) console.error(e);
  process.exitCode = 1;
}
