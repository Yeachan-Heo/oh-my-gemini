import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import {
  discoverNpmPluginCandidates,
  loadNpmPlugins,
} from '../../src/plugins/loader.js';
import { loadPluginRegistry, PluginRegistry } from '../../src/plugins/registry.js';
import type { RuntimeBackend } from '../../src/team/runtime/runtime-backend.js';
import { createTempDir, removeDir } from '../utils/runtime.js';

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

interface PluginPackageFixture {
  name: string;
  version?: string;
  source: string;
  entryFile?: string;
  pluginEntry?: string;
  extraFiles?: Record<string, string>;
}

async function seedPluginPackage(
  cwd: string,
  fixture: PluginPackageFixture,
): Promise<void> {
  const packageRoot = path.join(cwd, 'node_modules', fixture.name);
  const entryFile = fixture.entryFile ?? 'index.cjs';

  const packageJson = {
    name: fixture.name,
    version: fixture.version ?? '1.0.0',
    main: entryFile,
    ohMyGemini: fixture.pluginEntry
      ? {
          plugin: fixture.pluginEntry,
        }
      : undefined,
  };

  await writeJson(path.join(packageRoot, 'package.json'), packageJson);
  await writeText(path.join(packageRoot, entryFile), fixture.source);

  for (const [relativePath, content] of Object.entries(fixture.extraFiles ?? {})) {
    await writeText(path.join(packageRoot, relativePath), content);
  }
}

describe('reliability: npm plugin loader and registry', () => {
  test('discovers plugin package candidates from explicit, env, project config, and dependencies', async () => {
    const tempRoot = createTempDir('omg-plugin-discover-');

    try {
      await writeJson(path.join(tempRoot, 'package.json'), {
        name: 'fixture-project',
        version: '1.0.0',
        dependencies: {
          'oh-my-gemini-plugin-alpha': '1.0.0',
          '@acme/oh-my-gemini-plugin-beta': '1.0.0',
          'left-pad': '1.0.0',
        },
        devDependencies: {
          'oh-my-gemini-plugin-dev': '1.0.0',
        },
        optionalDependencies: {
          'oh-my-gemini-plugin-opt': '1.0.0',
        },
        ohMyGemini: {
          plugins: ['project-plugin', 'oh-my-gemini-plugin-alpha'],
        },
      });

      const candidates = await discoverNpmPluginCandidates({
        cwd: tempRoot,
        env: {
          OMG_NPM_PLUGINS: 'env-plugin,oh-my-gemini-plugin-alpha',
        },
        explicitPackages: ['explicit-plugin'],
      });

      expect(candidates.map((entry) => `${entry.source}:${entry.packageName}`)).toStrictEqual([
        'explicit:explicit-plugin',
        'env:env-plugin',
        'env:oh-my-gemini-plugin-alpha',
        'project-config:project-plugin',
        'dependencies:@acme/oh-my-gemini-plugin-beta',
        'devDependencies:oh-my-gemini-plugin-dev',
        'optionalDependencies:oh-my-gemini-plugin-opt',
      ]);
    } finally {
      removeDir(tempRoot);
    }
  });

  test('returns plugins_disabled when loader is not enabled', async () => {
    const tempRoot = createTempDir('omg-plugin-disabled-');

    try {
      await writeJson(path.join(tempRoot, 'package.json'), {
        name: 'fixture-project',
        version: '1.0.0',
      });

      const result = await loadNpmPlugins({
        cwd: tempRoot,
        enabled: false,
      });

      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('plugins_disabled');
      expect(result.plugins).toStrictEqual([]);
      expect(result.failures).toStrictEqual([]);
    } finally {
      removeDir(tempRoot);
    }
  });

  test('loads npm plugins and surfaces deterministic failures for invalid plugin exports', async () => {
    const tempRoot = createTempDir('omg-plugin-load-');

    try {
      await writeJson(path.join(tempRoot, 'package.json'), {
        name: 'fixture-project',
        version: '1.0.0',
        dependencies: {
          'oh-my-gemini-plugin-alpha': '1.0.0',
          'oh-my-gemini-plugin-broken': '1.0.0',
        },
      });

      await seedPluginPackage(tempRoot, {
        name: 'oh-my-gemini-plugin-alpha',
        source: `
module.exports = {
  id: 'alpha-plugin',
  runtimeBackends: [
    {
      name: 'alpha',
      async probePrerequisites() {
        return { ok: true, issues: [] };
      },
      async startTeam(input) {
        return {
          id: 'alpha-handle',
          teamName: input.teamName,
          backend: 'alpha',
          cwd: input.cwd,
          startedAt: new Date(0).toISOString(),
          runtime: {},
        };
      },
      async monitorTeam(handle) {
        return {
          handleId: handle.id,
          teamName: handle.teamName,
          backend: 'alpha',
          status: 'running',
          updatedAt: new Date(0).toISOString(),
          workers: [],
        };
      },
      async shutdownTeam() {},
    },
  ],
};
`,
      });

      await seedPluginPackage(tempRoot, {
        name: 'oh-my-gemini-plugin-broken',
        source: `
module.exports = function brokenPlugin() {
  return { id: 'broken' };
};
`,
      });

      const loadResult = await loadNpmPlugins({
        cwd: tempRoot,
        enabled: true,
      });

      expect(loadResult.enabled).toBe(true);
      expect(loadResult.reason).toBe('ok');
      expect(loadResult.plugins).toHaveLength(1);
      expect(loadResult.failures).toHaveLength(1);

      const [plugin] = loadResult.plugins;
      expect(plugin?.id).toBe('alpha-plugin');
      expect(plugin?.runtimeBackends.map((backend) => backend.name)).toStrictEqual(['alpha']);

      const [failure] = loadResult.failures;
      expect(failure?.packageName).toBe('oh-my-gemini-plugin-broken');
      expect(failure?.reason).toMatch(/must export default or named "plugin" object/i);

      const registry = new PluginRegistry(loadResult.plugins, {
        cwd: tempRoot,
        env: process.env,
      });
      const runtimeRegistry = registry.createRuntimeBackendRegistry([]);

      expect(runtimeRegistry.get('alpha' as RuntimeBackend['name']).name).toBe('alpha');
    } finally {
      removeDir(tempRoot);
    }
  });

  test('supports package-level plugin entry and lifecycle hooks', async () => {
    const tempRoot = createTempDir('omg-plugin-hooks-');

    try {
      await writeJson(path.join(tempRoot, 'package.json'), {
        name: 'fixture-project',
        version: '1.0.0',
        dependencies: {
          'oh-my-gemini-plugin-hooks': '1.0.0',
        },
      });

      await seedPluginPackage(tempRoot, {
        name: 'oh-my-gemini-plugin-hooks',
        entryFile: 'bootstrap.cjs',
        pluginEntry: './dist/plugin.cjs',
        source: 'module.exports = {};',
        extraFiles: {
          'dist/plugin.cjs': `
const { appendFileSync } = require('node:fs');

module.exports = {
  plugin: {
    id: 'hooks-plugin',
    onLoad(context) {
      appendFileSync(context.env.OMG_PLUGIN_HOOK_LOG, 'load\\n');
    },
    onUnload(context) {
      appendFileSync(context.env.OMG_PLUGIN_HOOK_LOG, 'unload\\n');
    },
  },
};
`,
        },
      });

      const hookLogPath = path.join(tempRoot, 'plugin-hooks.log');
      const loaded = await loadPluginRegistry({
        cwd: tempRoot,
        enabled: true,
        env: {
          ...process.env,
          OMG_PLUGIN_HOOK_LOG: hookLogPath,
        },
      });

      expect(loaded.registry.list().map((plugin) => plugin.id)).toStrictEqual(['hooks-plugin']);
      await loaded.registry.invokeUnloadHooks();

      const hookLog = await readFile(hookLogPath, 'utf8');
      expect(hookLog.trim().split('\n')).toStrictEqual(['load', 'unload']);
    } finally {
      removeDir(tempRoot);
    }
  });

  test('fails fast when two plugins register the same runtime backend name', async () => {
    const tempRoot = createTempDir('omg-plugin-collision-');

    try {
      const sharedBackend = {
        name: 'shared-backend',
        async probePrerequisites() {
          return { ok: true, issues: [] };
        },
        async startTeam(input: any) {
          return {
            id: 'shared-handle',
            teamName: input.teamName,
            backend: 'shared-backend',
            cwd: input.cwd,
            startedAt: new Date(0).toISOString(),
            runtime: {},
          };
        },
        async monitorTeam(handle: any) {
          return {
            handleId: handle.id,
            teamName: handle.teamName,
            backend: 'shared-backend',
            status: 'running',
            updatedAt: new Date(0).toISOString(),
            workers: [],
          };
        },
        async shutdownTeam() {},
      } as unknown as RuntimeBackend;

      expect(() =>
        new PluginRegistry(
          [
            {
              id: 'plugin-one',
              packageName: 'oh-my-gemini-plugin-one',
              source: 'explicit',
              modulePath: '/tmp/plugin-one/index.cjs',
              version: '1.0.0',
              manifest: { id: 'plugin-one', runtimeBackends: [sharedBackend] },
              runtimeBackends: [sharedBackend],
            },
            {
              id: 'plugin-two',
              packageName: 'oh-my-gemini-plugin-two',
              source: 'explicit',
              modulePath: '/tmp/plugin-two/index.cjs',
              version: '1.0.0',
              manifest: { id: 'plugin-two', runtimeBackends: [sharedBackend] },
              runtimeBackends: [sharedBackend],
            },
          ],
          {
            cwd: tempRoot,
            env: process.env,
          },
        ),
      ).toThrow(/provided by multiple plugins/i);
    } finally {
      removeDir(tempRoot);
    }
  });
});
