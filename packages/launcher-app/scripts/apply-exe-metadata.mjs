/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Set the version strings and icon on the packaged Windows exe.
 *
 * electron-builder does this with `rcedit`, a small Windows binary it runs
 * under wine. This WSL has no wine32 (`wine: could not load kernel32.dll`,
 * status c0000135), so that step aborts the build and the shipped exe keeps
 * stock Electron metadata. resedit is pure JavaScript, so the same edit runs
 * here with no wine and no Windows host.
 *
 * Run after `electron-builder --win --x64`:
 *
 *   node scripts/apply-exe-metadata.mjs            # edit in place
 *   node scripts/apply-exe-metadata.mjs --check    # only report what is set
 *
 * Note this invalidates a Authenticode signature if the exe ever has one. The
 * `dir` target is unsigned, so there is nothing to invalidate here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** en-US and the default codepage, matching what rcedit writes. */
const LANG = 1033;
const CODEPAGE = 1200;

function flag(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const productName = flag('product-name', 'Qwen Remote Launcher');
const exePath = path.resolve(
  flag('exe', path.join(root, 'release', 'win-unpacked', `${productName}.exe`)),
);
const iconPath = path.resolve(
  flag('icon', path.join(root, 'assets', 'icon.ico')),
);
const version = flag('version', pkg.version ?? '0.0.0');

/** `VS_FIXEDFILEINFO` stores a version as two 32-bit halves, not a string. */
function versionText(ms, ls) {
  return [
    (ms >>> 16) & 0xffff,
    ms & 0xffff,
    (ls >>> 16) & 0xffff,
    ls & 0xffff,
  ].join('.');
}

/** Reads back what the exe currently claims, without changing anything. */
function readBack(file) {
  const res = NtExecutableResource.from(
    NtExecutable.from(fs.readFileSync(file)),
  );
  const [vi] = Resource.VersionInfo.fromEntries(res.entries);
  if (!vi) throw new Error(`${file}: no RT_VERSION resource`);
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const fixed = vi.fixedInfo;
  return {
    groups: groups.length,
    fileVersion: versionText(fixed.fileVersionMS, fixed.fileVersionLS),
    productVersion: versionText(fixed.productVersionMS, fixed.productVersionLS),
    strings: vi.getStringValues({ lang: LANG, codepage: CODEPAGE }),
  };
}

function report(label, info) {
  const keys = [
    'FileDescription',
    'ProductName',
    'CompanyName',
    'InternalName',
    'OriginalFilename',
    'LegalCopyright',
  ];
  console.log(`${label}: ${info.groups} icon group(s)`);
  console.log(
    `  FileVersion=${info.fileVersion} ProductVersion=${info.productVersion}`,
  );
  for (const k of keys)
    console.log(`  ${k}=${JSON.stringify(info.strings[k] ?? null)}`);
}

if (process.argv.includes('--check')) {
  report('current', readBack(exePath));
  process.exit(0);
}

const before = readBack(exePath);
report('before', before);

const exe = NtExecutable.from(fs.readFileSync(exePath));
const res = NtExecutableResource.from(exe);

const [vi] = Resource.VersionInfo.fromEntries(res.entries);
if (!vi) throw new Error(`${exePath}: no RT_VERSION resource`);
vi.setFileVersion(version, LANG);
vi.setProductVersion(version, LANG);
// Only the keys rcedit set, so nothing already present is blanked out.
vi.setStringValues(
  { lang: LANG, codepage: CODEPAGE },
  {
    CompanyName: productName,
    FileDescription: productName,
    ProductName: productName,
    InternalName: productName,
    OriginalFilename: `${productName}.exe`,
    LegalCopyright: `Copyright © 2026 ${productName}`,
  },
);
vi.outputToResourceEntries(res.entries);

const iconFile = Data.IconFile.from(fs.readFileSync(iconPath));
const groups = Resource.IconGroupEntry.fromEntries(res.entries);
if (groups.length === 0) throw new Error(`${exePath}: no icon group`);
for (const group of groups) {
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    group.id,
    LANG,
    iconFile.icons.map((item) => item.data),
  );
}

res.outputResource(exe);
const out = Buffer.from(exe.generate());

// Write to a sibling then rename, so a failure mid-write cannot leave a short
// exe where the launcher used to be.
const tmp = `${exePath}.tmp`;
fs.writeFileSync(tmp, out);
fs.renameSync(tmp, exePath);

const after = readBack(exePath);
report('after', after);
console.log(
  `wrote ${exePath} (${out.length} bytes, ${iconFile.icons.length} icon size(s) from ${path.basename(iconPath)})`,
);
