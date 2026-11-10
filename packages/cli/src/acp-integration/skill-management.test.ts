/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Storage,
  type Config,
  type SkillLevel,
} from '@qwen-code/qwen-code-core';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

const downloadSkillMock = vi.hoisted(() => vi.fn());
type RenameFn = typeof import('node:fs/promises').rename;
const renameOverride = vi.hoisted(() => ({
  fn: null as RenameFn | null,
  realRename: null as RenameFn | null,
}));

vi.mock('./skill-source-download.js', () => ({
  downloadSkill: downloadSkillMock,
}));

vi.mock('node:fs/promises', async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  renameOverride.realRename = actual.rename;
  return {
    ...actual,
    rename: ((...args: Parameters<RenameFn>) => {
      if (renameOverride.fn) return renameOverride.fn(...args);
      return actual.rename(...args);
    }) as RenameFn,
  };
});

import {
  deleteManagedSkill,
  installManagedSkill,
  setManagedSkillEnabled,
} from './skill-management.js';

type SkillManager = NonNullable<ReturnType<Config['getSkillManager']>>;

function configWith(skillManager: object): Config {
  return {
    getSkillManager: () => skillManager as SkillManager,
  } as unknown as Config;
}

function managerFor(name: string) {
  const parseSkillContent = vi.fn(
    (_content: string, filePath: string, level: SkillLevel) => ({
      name,
      description: `${name} skill`,
      level,
      filePath,
      skillRoot: path.dirname(filePath),
      body: 'Body',
    }),
  );
  const refreshCache = vi.fn().mockResolvedValue(undefined);
  return { parseSkillContent, refreshCache };
}

async function writeSkill(root: string, relativeDir: string, name: string) {
  const skillDir = path.join(root, relativeDir, name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`,
    'utf8',
  );
  return { skillDir, skillFile };
}

afterEach(() => {
  downloadSkillMock.mockReset();
  vi.restoreAllMocks();
});

describe('managed Skill mutations', () => {
  it('installs every downloaded file and refreshes the cache', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const manager = managerFor('pptx');
    downloadSkillMock.mockResolvedValue({
      skillContent:
        '---\nname: pptx\ndescription: Create slide decks\n---\nBody\n',
      files: [
        {
          relativePath: 'SKILL.md',
          content: Buffer.from('---\nname: pptx\n---\nBody\n'),
        },
        {
          relativePath: 'references/editing.md',
          content: Buffer.from('# Editing guide\n'),
        },
      ],
    });

    try {
      const result = await installManagedSkill(configWith(manager), {
        skill: {
          id: 'pptx-id',
          slug: 'pptx',
          name: 'PPTX',
          sourceUrl:
            'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
        },
      });
      const installedPath = path.join(tempHome, 'skills', 'pptx', 'SKILL.md');

      expect(result).toMatchObject({
        id: 'pptx-id',
        slug: 'pptx',
        installed: true,
        installedPath,
      });
      await expect(fs.readFile(installedPath, 'utf8')).resolves.toContain(
        'name: pptx',
      );
      await expect(
        fs.readFile(
          path.join(tempHome, 'skills', 'pptx', 'references', 'editing.md'),
          'utf8',
        ),
      ).resolves.toBe('# Editing guide\n');
      expect(manager.parseSkillContent).toHaveBeenCalledWith(
        expect.stringContaining('name: pptx'),
        installedPath,
        'user',
      );
      expect(manager.refreshCache).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('enables, disables, and deletes a global Skill', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const { skillDir, skillFile } = await writeSkill(
      tempHome,
      'skills',
      'pptx',
    );
    const manager = managerFor('pptx');
    const config = configWith(manager);

    try {
      await expect(
        setManagedSkillEnabled(config, {
          skill: { slug: 'pptx', enabled: false },
        }),
      ).resolves.toMatchObject({
        slug: 'pptx',
        enabled: false,
        installedPath: skillFile,
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );

      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: true },
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.not.toContain(
        'disable-model-invocation',
      );

      await expect(
        deleteManagedSkill(config, { skill: { slug: 'pptx' } }),
      ).resolves.toEqual({ slug: 'pptx', deleted: true });
      await expect(fs.stat(skillDir)).rejects.toThrow();
      expect(manager.refreshCache).toHaveBeenCalledTimes(3);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('can disable and delete a legacy artifact-shaped global Skill', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const slug = 'foo.backup-1-2';
    const { skillDir, skillFile } = await writeSkill(tempHome, 'skills', slug);
    const manager = managerFor(slug);
    const config = configWith(manager);

    try {
      await expect(
        setManagedSkillEnabled(config, {
          skill: { slug, enabled: false },
        }),
      ).resolves.toMatchObject({
        slug,
        enabled: false,
        installedPath: skillFile,
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );

      await expect(
        deleteManagedSkill(config, { skill: { slug } }),
      ).resolves.toEqual({ slug, deleted: true });
      await expect(fs.stat(skillDir)).rejects.toThrow();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('preserves comments and nested hooks when toggling frontmatter', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const skillDir = path.join(tempHome, 'skills', 'pptx');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      skillFile,
      '---\n# keep this comment\nname: pptx\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      command: echo hi\n---\nBody\n',
      'utf8',
    );
    const config = configWith(managerFor('pptx'));

    try {
      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: false },
      });
      let content = await fs.readFile(skillFile, 'utf8');
      expect(content).toContain('# keep this comment');
      expect(content).toContain('hooks:');
      expect(content).toContain('matcher: Bash');
      expect(content).toContain('disable-model-invocation: true');

      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: true },
      });
      content = await fs.readFile(skillFile, 'utf8');
      expect(content).toContain('# keep this comment');
      expect(content).toContain('hooks:');
      expect(content).not.toContain('disable-model-invocation');
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves user and project Skills through the existing manager fallbacks', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    const tempProject = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-project-skill-'),
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const userSkill = await writeSkill(tempHome, '.agents/skills', 'course');
    const projectSkill = await writeSkill(
      tempProject,
      '.qwen/skills',
      'project-course',
    );
    const manager = managerFor('unused');
    manager.parseSkillContent.mockImplementation(
      (content: string, filePath: string, level: SkillLevel) => {
        const name = content.match(/^name:\s*(.+)$/m)?.[1] ?? 'unknown';
        return {
          name,
          description: `${name} skill`,
          level,
          filePath,
          skillRoot: path.dirname(filePath),
          body: 'Body',
        };
      },
    );
    const listSkills = vi.fn(({ level }: { level: 'user' | 'project' }) =>
      Promise.resolve(
        level === 'user'
          ? [{ name: 'course', filePath: userSkill.skillFile }]
          : [{ name: 'project-course', filePath: projectSkill.skillFile }],
      ),
    );
    const config = configWith({ ...manager, listSkills });

    try {
      await setManagedSkillEnabled(config, {
        skill: { slug: 'course', enabled: false },
      });
      await setManagedSkillEnabled(config, {
        skill: {
          slug: 'project-course',
          enabled: false,
          scope: 'project',
        },
      });

      await expect(fs.readFile(userSkill.skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );
      await expect(
        fs.readFile(projectSkill.skillFile, 'utf8'),
      ).resolves.toContain('disable-model-invocation: true');
      expect(listSkills).toHaveBeenCalledWith({ level: 'user' });
      expect(listSkills).toHaveBeenCalledWith({ level: 'project' });
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempProject, { recursive: true, force: true });
    }
  });

  it('resolves project Skills from the requested working directory', async () => {
    const tempProject = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-project-cwd-skill-'),
    );
    const skillDir = path.join(tempProject, '.qwen', 'skills', 'issue-fixer');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      skillFile,
      '---\nname: bugfix\ndescription: Bugfix skill\n---\nBody\n',
      'utf8',
    );
    const manager = managerFor('bugfix');
    const loadSkillsFromDir = vi.fn().mockResolvedValue([
      {
        name: 'bugfix',
        filePath: skillFile,
      },
    ]);
    const listSkills = vi.fn().mockResolvedValue([]);
    const config = configWith({ ...manager, loadSkillsFromDir, listSkills });

    try {
      await expect(
        setManagedSkillEnabled(
          config,
          {
            skill: { slug: 'bugfix', enabled: false, scope: 'project' },
          },
          tempProject,
        ),
      ).resolves.toMatchObject({
        slug: 'bugfix',
        enabled: false,
        installedPath: skillFile,
      });
      expect(loadSkillsFromDir).toHaveBeenCalledWith(
        path.join(tempProject, '.qwen', 'skills'),
        'project',
      );
      expect(listSkills).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempProject, { recursive: true, force: true });
    }
  });

  it('cleans up the backup directory on a successful reinstall', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    await writeSkill(tempHome, 'skills', 'pptx');
    const manager = managerFor('pptx');
    downloadSkillMock.mockResolvedValue({
      skillContent:
        '---\nname: pptx\ndescription: Create slide decks\n---\nNew body\n',
      files: [
        {
          relativePath: 'SKILL.md',
          content: Buffer.from('---\nname: pptx\n---\nNew body\n'),
        },
      ],
    });

    try {
      await installManagedSkill(configWith(manager), {
        skill: {
          id: 'pptx-id',
          slug: 'pptx',
          name: 'PPTX',
          sourceUrl:
            'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
        },
      });

      const skillsDir = path.join(tempHome, 'skills');
      const entries = await fs.readdir(skillsDir);
      // Only the real skill dir should remain; no leftover .backup-* siblings.
      expect(entries).toEqual(['pptx']);
      const installedPath = path.join(skillsDir, 'pptx', 'SKILL.md');
      await expect(fs.readFile(installedPath, 'utf8')).resolves.toContain(
        'name: pptx',
      );
      // Verify the reinstall actually replaced the skill content, not just
      // that the pre-existing SKILL.md is still present.
      await expect(fs.readFile(installedPath, 'utf8')).resolves.toContain(
        'New body',
      );
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('restores the original skill when the swap rename fails', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const originalContent =
      '---\nname: pptx\ndescription: Original skill\n---\nOriginal body\n';
    const { skillFile } = await writeSkill(tempHome, 'skills', 'pptx');
    // Overwrite with known content so we can assert restoration exactly.
    await fs.writeFile(skillFile, originalContent, 'utf8');

    const manager = managerFor('pptx');
    downloadSkillMock.mockResolvedValue({
      skillContent:
        '---\nname: pptx\ndescription: New version\n---\nNew body\n',
      files: [
        {
          relativePath: 'SKILL.md',
          content: Buffer.from('---\nname: pptx\n---\nNew body\n'),
        },
      ],
    });

    // Make the staging → final rename fail with EPERM, but let the
    // original → backup rename succeed so the rollback path is exercised.
    const realRename = renameOverride.realRename!;
    let renameCalled = false;
    renameOverride.fn = (async (
      oldPath: Parameters<RenameFn>[0],
      newPath: Parameters<RenameFn>[1],
    ) => {
      const dest = String(newPath);
      const skillsRoot = path.join(tempHome, 'skills');
      // The swap rename: staging dir → final skill dir.
      if (
        dest === path.join(skillsRoot, 'pptx') &&
        String(oldPath).includes('.installing-')
      ) {
        renameCalled = true;
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRename(oldPath, newPath);
    }) as RenameFn;

    try {
      await expect(
        installManagedSkill(configWith(manager), {
          skill: {
            id: 'pptx-id',
            slug: 'pptx',
            name: 'PPTX',
            sourceUrl:
              'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
          },
        }),
      ).rejects.toThrow('EPERM');

      // Sanity: the failing rename was actually hit.
      expect(renameCalled).toBe(true);

      // Original content must be intact after the rollback.
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toBe(
        originalContent,
      );

      // No leftover .backup-* or .installing-* siblings.
      const skillsDir = path.join(tempHome, 'skills');
      const entries = await fs.readdir(skillsDir);
      expect(entries).toEqual(['pptx']);
    } finally {
      renameOverride.fn = null;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects traversal slugs before downloading or touching disk', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const sentinel = path.join(tempHome, 'settings.json');
    await fs.writeFile(sentinel, '{"keep":true}', 'utf8');
    const config = configWith(managerFor('unused'));

    try {
      for (const slug of ['..', '.']) {
        await expect(
          installManagedSkill(config, {
            skill: {
              slug,
              sourceUrl:
                'https://github.com/anthropics/skills/blob/main/SKILL.md',
            },
          }),
        ).rejects.toThrow('Invalid skill.slug');
        await expect(
          deleteManagedSkill(config, { skill: { slug } }),
        ).rejects.toThrow('Invalid skill.slug');
        await expect(
          setManagedSkillEnabled(config, {
            skill: { slug, enabled: false },
          }),
        ).rejects.toThrow('Invalid skill.slug');
      }
      expect(downloadSkillMock).not.toHaveBeenCalled();
      await expect(fs.readFile(sentinel, 'utf8')).resolves.toContain('keep');
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects artifact-shaped slugs reserved by the reinstall swap', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const config = configWith(managerFor('unused'));

    try {
      // Names shaped exactly like the swap artifacts
      // (`<slug>.backup-<pid>-<timestamp>` / `.installing-...`) are
      // skipped by the skill loaders, so installing them must fail loudly
      // instead of reporting success for a skill that never loads.
      for (const slug of ['foo.backup-1-2', 'foo.installing-12345-67890']) {
        await expect(
          installManagedSkill(config, {
            skill: {
              slug,
              sourceUrl:
                'https://github.com/anthropics/skills/blob/main/SKILL.md',
            },
          }),
        ).rejects.toThrow('Invalid skill.slug');
      }
      expect(downloadSkillMock).not.toHaveBeenCalled();
      await expect(fs.readdir(path.join(tempHome, 'skills'))).rejects.toThrow();

      for (const slug of ['foo.backup-1-2-extra', 'foo-backup-1-2']) {
        downloadSkillMock.mockResolvedValueOnce({
          skillContent: `---\nname: ${slug}\n---\nBody\n`,
          files: [
            {
              relativePath: 'SKILL.md',
              content: Buffer.from(`---\nname: ${slug}\n---\nBody\n`),
            },
          ],
        });

        await expect(
          installManagedSkill(configWith(managerFor(slug)), {
            skill: {
              slug,
              sourceUrl:
                'https://github.com/anthropics/skills/blob/main/SKILL.md',
            },
          }),
        ).resolves.toMatchObject({ slug, installed: true });
      }
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects a downloaded file whose relativePath resolves to the skill directory root', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const manager = managerFor('pptx');
    downloadSkillMock.mockResolvedValue({
      skillContent: '---\nname: pptx\n---\nBody\n',
      files: [
        {
          relativePath: 'SKILL.md',
          content: Buffer.from('---\nname: pptx\n---\nBody\n'),
        },
        {
          relativePath: '.',
          content: Buffer.from('overwrite root'),
        },
      ],
    });

    try {
      await expect(
        installManagedSkill(configWith(manager), {
          skill: {
            slug: 'pptx',
            sourceUrl:
              'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
          },
        }),
      ).rejects.toThrow('Invalid skill file path: .');
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('validates tar entry bounds, path segments, depth, and file count in extractFilesFromTarGz', async () => {
    const { extractFilesFromTarGz } = await vi.importActual<
      typeof import('./skill-source-download.js')
    >('./skill-source-download.js');

    function rawTarEntry(
      name: string,
      content: string,
      sizeField?: string,
    ): Buffer {
      const header = Buffer.alloc(512);
      header.write(name, 0, 'utf8');
      const size = Buffer.byteLength(content);
      header.write(
        sizeField ?? `${size.toString(8).padStart(11, '0')}\0`,
        124,
        'utf8',
      );
      header.write('0', 156, 'utf8');
      const data = Buffer.alloc(Math.ceil(size / 512) * 512);
      data.write(content, 0, 'utf8');
      return Buffer.concat([header, data]);
    }

    // Truncated archive where declared size exceeds remaining buffer.
    const truncatedHeader = Buffer.alloc(512);
    truncatedHeader.write('repo-main/skills/SKILL.md', 0, 'utf8');
    truncatedHeader.write(
      `${(4096).toString(8).padStart(11, '0')}\0`,
      124,
      'utf8',
    );
    truncatedHeader.write('0', 156, 'utf8');
    const truncatedArchive = new Uint8Array(gzipSync(truncatedHeader));
    await expect(
      extractFilesFromTarGz(truncatedArchive, 'skills'),
    ).rejects.toThrow('Invalid or truncated skill archive');

    // Non-octal / NaN size field.
    const nanSizeArchive = new Uint8Array(
      gzipSync(
        Buffer.concat([
          rawTarEntry('repo-main/skills/SKILL.md', 'hi', 'not-octal\0'),
          Buffer.alloc(1024),
        ]),
      ),
    );
    await expect(
      extractFilesFromTarGz(nanSizeArchive, 'skills'),
    ).rejects.toThrow('Invalid or truncated skill archive');

    // Dot or dot-dot path segments.
    const traversalArchive = new Uint8Array(
      gzipSync(
        Buffer.concat([
          rawTarEntry('repo-main/skills/../evil.md', 'hi'),
          Buffer.alloc(1024),
        ]),
      ),
    );
    await expect(
      extractFilesFromTarGz(traversalArchive, 'skills'),
    ).rejects.toThrow('Invalid skill file path');

    // Directory depth limit.
    const deepArchive = new Uint8Array(
      gzipSync(
        Buffer.concat([
          rawTarEntry('repo-main/skills/a/b/c/SKILL.md', 'hi'),
          Buffer.alloc(1024),
        ]),
      ),
    );
    await expect(
      extractFilesFromTarGz(deepArchive, 'skills', { maxDirDepth: 2 }),
    ).rejects.toThrow(
      'Skill directory nesting exceeds the maximum allowed depth',
    );

    // File count limit.
    const manyFilesArchive = new Uint8Array(
      gzipSync(
        Buffer.concat([
          rawTarEntry('repo-main/skills/SKILL.md', 'one'),
          rawTarEntry('repo-main/skills/two.md', 'two'),
          Buffer.alloc(1024),
        ]),
      ),
    );
    await expect(
      extractFilesFromTarGz(manyFilesArchive, 'skills', { maxFileCount: 1 }),
    ).rejects.toThrow('Skill directory contains too many files');
  });

  it('does not swallow validation RequestErrors from the GitHub Contents API and only falls back to archive on API fetch errors', async () => {
    const { downloadSkill } = await vi.importActual<
      typeof import('./skill-source-download.js')
    >('./skill-source-download.js');

    const directoryUrl =
      'https://api.github.com/repos/anthropics/skills/contents/skills/pptx?ref=main';
    const archiveUrl =
      'https://codeload.github.com/anthropics/skills/tar.gz/main';

    // 1. Disallowed download_url host in Contents API response must throw RequestError without calling archiveUrl.
    const disallowedFetchMock = vi.fn(async (url: string) => {
      if (url === directoryUrl) {
        return {
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue([
            {
              name: 'SKILL.md',
              path: 'skills/pptx/SKILL.md',
              type: 'file',
              download_url: 'https://evil.example.com/SKILL.md',
            },
          ]),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', disallowedFetchMock);

    try {
      await expect(
        downloadSkill(
          'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
        ),
      ).rejects.toThrow('Skill sourceUrl host is not allowed');
      expect(disallowedFetchMock).toHaveBeenCalledTimes(1);

      // 2. HTTP 403 from Contents API falls back to archive download.
      const header = Buffer.alloc(512);
      const body = '---\nname: pptx\n---\nArchive body\n';
      header.write('skills-main/skills/pptx/SKILL.md', 0, 'utf8');
      header.write(
        `${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`,
        124,
        'utf8',
      );
      header.write('0', 156, 'utf8');
      const dataBlock = Buffer.alloc(512);
      dataBlock.write(body, 0, 'utf8');
      const gz = gzipSync(
        Buffer.concat([header, dataBlock, Buffer.alloc(1024)]),
      );

      const fallbackFetchMock = vi.fn(async (url: string) => {
        if (url === directoryUrl) {
          return {
            ok: false,
            status: 403,
            headers: { get: (): string | null => null },
          };
        }
        if (url === archiveUrl) {
          return {
            ok: true,
            status: 200,
            headers: { get: (): string | null => null },
            arrayBuffer: vi
              .fn()
              .mockResolvedValue(
                gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
              ),
          };
        }
        throw new Error(`Unexpected fetch to ${url}`);
      });
      vi.stubGlobal('fetch', fallbackFetchMock);

      const downloaded = await downloadSkill(
        'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
      );
      expect(downloaded.skillContent).toBe(body);
      expect(fallbackFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
