/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Install or verify the unpacked Windows launcher build from WSL (issue #210).
 *
 * Usage:
 *   node scripts/install-win.mjs                   # stop, back up, copy, verify, start
 *   node scripts/install-win.mjs --check           # verify installed stamp matches fork HEAD
 *   node scripts/install-win.mjs --no-process-control --install-dir=/tmp/test
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const EXE_NAME = 'Qwen Remote Launcher.exe';
const INSTALL_BASENAME = 'QwenRemoteLauncher';

function flag(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function commitsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const la = a.trim().toLowerCase();
  const lb = b.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(la) || !/^[0-9a-f]{7,40}$/.test(lb)) {
    return false;
  }
  return la.startsWith(lb) || lb.startsWith(la);
}

function readForkCommit() {
  const override = flag('expected-commit');
  if (override) return override.trim();
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveInstallDir() {
  const explicit =
    flag('install-dir') ?? process.env['QWEN_LAUNCHER_WIN_INSTALL_DIR'];
  if (explicit) return path.resolve(explicit);

  try {
    const winLocalAppData = execFileSync(
      'cmd.exe',
      ['/d', '/c', 'echo %LOCALAPPDATA%'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .replace(/\r/g, '')
      .trim();
    if (winLocalAppData && !winLocalAppData.includes('%LOCALAPPDATA%')) {
      const wslLocalAppData = execFileSync('wslpath', ['-u', winLocalAppData], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (wslLocalAppData) {
        return path.join(wslLocalAppData, 'Programs', INSTALL_BASENAME);
      }
    }
  } catch {
    // Fall back to scanning /mnt/c/Users below.
  }

  const usersRoot = '/mnt/c/Users';
  if (fs.existsSync(usersRoot)) {
    for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (
        ['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)
      ) {
        continue;
      }
      const candidate = path.join(
        usersRoot,
        entry.name,
        'AppData',
        'Local',
        'Programs',
        INSTALL_BASENAME,
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  throw new Error(
    'Could not locate Windows %LOCALAPPDATA%\\Programs\\QwenRemoteLauncher; pass --install-dir=<path> or set QWEN_LAUNCHER_WIN_INSTALL_DIR.',
  );
}

function readStampFile(dir) {
  const stampPath = path.join(dir, 'resources', 'build-stamp.json');
  if (!fs.existsSync(stampPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      commit: typeof parsed.commit === 'string' ? parsed.commit : 'unknown',
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : 'unknown',
    };
  } catch {
    return null;
  }
}

function checkInstalled(installDir, expectedCommit) {
  const exePath = path.join(installDir, EXE_NAME);
  if (!fs.existsSync(exePath)) {
    return {
      ok: false,
      message: `launcher-app check failed: ${exePath} does not exist`,
    };
  }
  const stamp = readStampFile(installDir);
  if (!stamp) {
    return {
      ok: false,
      message:
        `launcher-app check failed: ${path.join(installDir, 'resources', 'build-stamp.json')} is missing ` +
        `(installed copy predates #210; fork HEAD is ${expectedCommit}). Run: npm --prefix packages/launcher-app run install:win`,
    };
  }
  if (expectedCommit !== 'unknown' && !commitsMatch(stamp.commit, expectedCommit)) {
    return {
      ok: false,
      message:
        `launcher-app check failed: installed launcher at ${installDir} is at ${stamp.commit} (built ${stamp.builtAt}), ` +
        `but fork HEAD is ${expectedCommit}. Run: npm --prefix packages/launcher-app run install:win`,
    };
  }
  return {
    ok: true,
    message: `launcher-app check ok: ${installDir} matches fork (${stamp.commit}, built ${stamp.builtAt})`,
  };
}

function backupSuffix(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    '-',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
}

function stopRunningLauncher() {
  try {
    execFileSync('taskkill.exe', ['/IM', EXE_NAME, '/F'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Exit code 128 when not running is normal.
  }
}

function startInstalledLauncher(installDir) {
  const exeWslPath = path.join(installDir, EXE_NAME);
  const winExePath = execFileSync('wslpath', ['-w', exeWslPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const escaped = winExePath.replace(/'/g, "''");
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${escaped}'`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const checkOnly = process.argv.includes('--check');
const noProcessControl = process.argv.includes('--no-process-control');
const expectedCommit = readForkCommit();
const installDir = resolveInstallDir();

if (checkOnly) {
  const verdict = checkInstalled(installDir, expectedCommit);
  if (!verdict.ok) {
    console.error(verdict.message);
    process.exit(1);
  }
  console.log(verdict.message);
  process.exit(0);
}

const unpackedDir = path.resolve(
  flag('unpacked-dir', path.join(root, 'release', 'win-unpacked')),
);
const unpackedCheck = checkInstalled(unpackedDir, expectedCommit);
if (!unpackedCheck.ok) {
  console.error(
    `Refusing to install invalid unpacked build from ${unpackedDir}: ${unpackedCheck.message}`,
  );
  process.exit(1);
}

if (!noProcessControl) {
  stopRunningLauncher();
}

fs.mkdirSync(path.dirname(installDir), { recursive: true });
let backupDir = null;
if (fs.existsSync(installDir)) {
  backupDir = `${installDir}.bak-${backupSuffix()}`;
  fs.renameSync(installDir, backupDir);
  console.log(`backed up previous install to ${backupDir}`);
}

fs.cpSync(unpackedDir, installDir, { recursive: true });

const postCheck = checkInstalled(installDir, expectedCommit);
if (!postCheck.ok) {
  console.error(postCheck.message);
  process.exit(1);
}
console.log(postCheck.message);

if (!noProcessControl && !process.argv.includes('--no-start')) {
  startInstalledLauncher(installDir);
  console.log(`started ${EXE_NAME} from ${installDir}`);
}
