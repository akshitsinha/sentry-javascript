// EXPERIMENTAL — Vite plugin that injects
// `diagnostics_channel.tracingChannel` calls into the libraries listed in
// `SENTRY_INSTRUMENTATIONS`, during builds or dev dependency optimization.
//
// This file is published ESM-only via the `@sentry/server-utils/orchestrion/vite`
// subpath export. `@apm-js-collab/code-transformer-bundler-plugins` is
// `"type": "module"`, so consuming it from a CJS build is intentionally
// unsupported — vite.config.ts is almost always ESM in practice. The CJS
// rollup variant still emits this file, but `package.json` only exposes the
// ESM entry, so attempts to `require('@sentry/server-utils/orchestrion/vite')` will
// fail at resolution time rather than producing a half-broken plugin.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UnknownPlugin = any;

import codeTransformerEsbuild from '@apm-js-collab/code-transformer-bundler-plugins/esbuild';
import codeTransformerRollup from '@apm-js-collab/code-transformer-bundler-plugins/rollup';
import codeTransformer from '@apm-js-collab/code-transformer-bundler-plugins/vite';
import { consoleSandbox } from '@sentry/core';
import MagicString from 'magic-string';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { INSTRUMENTED_MODULE_NAMES, SENTRY_INSTRUMENTATIONS } from '../config';

// `vite` types live in the package's ESM-only subpath; under Node16 module
// resolution with TS treating @sentry/server-utils as CJS, importing them produces a
// false positive. We don't need the runtime value for typing — `UnknownPlugin`
// is sufficient — so we omit the import entirely.

export interface SentryOrchestrionPluginOptions {
  /**
   * Whether to register the SDK's channel-subscriber integrations.
   *
   * When enabled, the plugin injects a virtual module into the server entry
   * which registers the integration factories on the global orchestrion marker.
   * SDKs read them through `getRegisteredChannelIntegrations()`. Every registered
   * integration is instantiated regardless of which packages the app bundles;
   * the ones whose channels never fire sit idle.
   *
   * Leave unset for SDKs that wire up the integrations through a static import
   * instead (e.g. `@sentry/node`'s `experimentalUseDiagnosticsChannelInjection()`),
   * which never read the marker.
   */
  registerIntegrations?: boolean;
}

/**
 * Vite plugin that runs the orchestrion code transform in builds and dev.
 *
 * Use when bundling a Node app with Vite (e.g. Vite SSR builds, Nuxt's Nitro
 * pipeline, SvelteKit). For unbundled Node processes use the runtime hooks
 * instead (`@sentry/node`'s `experimentalUseDiagnosticsChannelInjection()`, or
 * `node --import @sentry/server-utils/orchestrion/import-hook app.js`).
 *
 * Both `vite build` and `vite dev` instrument deps, but by different paths
 * because the dev server never bundles:
 *   - Build: Rollup runs the code transform; the marker plugin prepends
 *     `bundler = true` on entry chunks via `renderChunk`.
 *   - Dev: deps are pre-bundled by the optimizer before the Vite `transform`
 *     hook sees them, so the marker plugin wires the transform into the
 *     optimizer (esbuild on classic Vite, Rolldown on Vite 8).
 *
 * With `registerIntegrations`, a registration import is also injected into the
 * server entry (see {@link registerIntegrationsPlugin}); build uses
 * `ModuleInfo.isEntry`, dev uses the first transformed server source module
 * because `isEntry` throws there. Every registered channel integration is
 * instantiated at runtime regardless of which packages the app actually
 * bundles; the ones whose channels never fire sit idle.
 *
 * Returns the following plugins:
 *   1. `sentry-orchestrion-marker` — a `renderChunk` hook that prepends a
 *      banner to entry chunks. The banner sets
 *      `globalThis.__SENTRY_ORCHESTRION__.bundler = true` at app boot, so the
 *      runtime can detect that the bundler path ran.
 *      Also injects every instrumented package name into `ssr.noExternal` via
 *      the `config` hook, since externalized deps are `require()`d at runtime
 *      from `node_modules` and never pass through the transform. And it hooks
 *      the dep optimizer of non-client environments via `configEnvironment`, so
 *      dev-mode dependency pre-bundling (which bypasses the `transform` hook)
 *      also injects the channels.
 *   2. `sentry-orchestrion-register-integrations` (only with
 *      `options.registerIntegrations`) — injects the channel-integration
 *      registration import into the app's server entry, see
 *      {@link SentryOrchestrionPluginOptions.registerIntegrations}.
 *   3. The upstream `@apm-js-collab/code-transformer-bundler-plugins/vite`
 *      plugin, fed our central `SENTRY_INSTRUMENTATIONS` config.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { sentryOrchestrionPlugin } from '@sentry/server-utils/orchestrion/vite';
 * export default { plugins: [sentryOrchestrionPlugin()] };
 * ```
 */
export function sentryOrchestrionPlugin(options: SentryOrchestrionPluginOptions = {}): UnknownPlugin[] {
  const codeTransformerPlugins = codeTransformer({
    instrumentations: SENTRY_INSTRUMENTATIONS,
    // Only the marker-based registration path (`registerIntegrations`) surfaces
    // the failed-transform warning; the runtime `--import` path never does, so
    // we avoid emitting the banner when it wouldn't be consumed.
    ...(options.registerIntegrations ? { injectDiagnostics: makeFailedModulesBanner() } : {}),
  });
  const codeTransformerArray: UnknownPlugin[] = Array.isArray(codeTransformerPlugins)
    ? codeTransformerPlugins
    : [codeTransformerPlugins];
  const serverCodeTransformerArray = codeTransformerArray.map(plugin => serverEnvironmentOnly(plugin));
  return [
    bundlerMarkerPlugin(),
    ...(options.registerIntegrations ? [registerIntegrationsPlugin()] : []),
    ...serverCodeTransformerArray,
  ];
}

/** Keeps environment-aware Vite builds from transforming client bundles. */
function serverEnvironmentOnly(plugin: UnknownPlugin): UnknownPlugin {
  const applyToEnvironment = (plugin as { applyToEnvironment?: (this: unknown, environment: unknown) => unknown })
    .applyToEnvironment;
  return {
    ...plugin,
    applyToEnvironment(this: unknown, environment: { config?: { consumer?: string } }): unknown {
      if (environment.config?.consumer === 'client') return false;
      return applyToEnvironment?.call(this, environment) ?? true;
    },
  };
}

/**
 * Builds the `injectDiagnostics` callback for the code transformer: it records
 * the packages whose transform failed onto the global orchestrion marker, so
 * `getRegisteredChannelIntegrations()` can warn about them at runtime.
 *
 * A failed transform also gets a build-time warning: the package IS in the
 * bundle but its diagnostics channels are not, so its integration is wired up
 * yet records no spans. The callback runs once per emitted chunk, hence the
 * once-guard on the warning.
 *
 * The transformer runs the callback at `renderChunk` and prepends the returned
 * string to each emitted chunk. That's exactly the phase that can't host a
 * bundled `import` (see {@link registerIntegrationsPlugin}), but a
 * self-contained assignment like this one is fine there — it needs nothing
 * from the module graph. Every chunk receives the same complete list (the
 * graph is fully transformed before any chunk renders), so the repeated
 * assignment is idempotent.
 */
function makeFailedModulesBanner(): (diagnostics: { failedModules: string[] }) => string {
  let warnedFailedModules = false;
  return ({ failedModules }) => {
    if (failedModules.length && !warnedFailedModules) {
      warnedFailedModules = true;
      consoleSandbox(() => {
        // eslint-disable-next-line no-console
        console.warn(
          `[Sentry] The orchestrion code transform failed for: ${failedModules.join(', ')}. ` +
            'These packages are bundled without diagnostics channels, so Sentry will not record spans for them.',
        );
      });
    }
    return (
      'globalThis.__SENTRY_ORCHESTRION__=globalThis.__SENTRY_ORCHESTRION__||{};' +
      `globalThis.__SENTRY_ORCHESTRION__.failedModules=${JSON.stringify(failedModules)};\n`
    );
  };
}

// The virtual registration module the plugin injects also acts as the sentinel
// which prevents duplicate injection.
const REGISTER_MODULE_ID = 'virtual:@sentry/orchestrion-register-integrations';
const RESOLVED_REGISTER_MODULE_ID = `\0${REGISTER_MODULE_ID}`;

/**
 * Injects a virtual registration module into the app's server entry.
 *
 * The import is added during `transform`, while Rollup can still include it in
 * the module graph. An import returned from `injectDiagnostics` at
 * `renderChunk` would remain unresolved. The virtual module imports an absolute
 * ESM path because the entry may itself be virtual, with no directory from
 * which to resolve a bare specifier. This also avoids bundling a second,
 * CommonJS copy of `@sentry/core`.
 *
 * All factories are registered and every one is instantiated at runtime; there
 * is no narrowing to the packages the app actually bundled (and no tree-shaking
 * of unused subscriber code — that needs a module-graph-phase hook upstream).
 *
 * Builds identify entries through `ModuleInfo.isEntry`. Vite dev does not
 * support that property, so registration is injected once into the first
 * eligible source module transformed in each server environment.
 */
function registerIntegrationsPlugin(): UnknownPlugin {
  // `createRequire().resolve(REGISTER_MODULE)` would select the package's CJS
  // export. Resolve the package root instead and explicitly target the ESM
  // export which is bundled alongside the ESM-only Vite plugin.
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve('@sentry/server-utils/package.json'));
  const resolvedRegisterModule = resolve(packageRoot, 'build/esm/orchestrion/index.js');

  // The slices of Vite's environment-API / Rollup plugin context we read; typed
  // structurally since we don't import `vite`/`rollup` types here (see note at
  // the top of the file).
  interface PluginContext {
    environment?: { name?: string; config?: { consumer?: string } };
    getModuleInfo?: (id: string) => { isEntry?: boolean } | null;
  }

  // `serve` (vite dev) vs `build`; drives entry detection in `transform`.
  let command = 'build';
  // Dev only: records which source module receives registration in each
  // environment. Re-transforming that module must inject again because HMR can
  // start a fresh isolate from the newly transformed output.
  const injectedServeModules = new Map<string, string>();

  function injectRegisterImport(code: string): { code: string; map: unknown } | null {
    if (code.includes(REGISTER_MODULE_ID)) return null;
    const ms = new MagicString(code);
    const injection = `import ${JSON.stringify(REGISTER_MODULE_ID)};\n`;
    const shebangEnd = code.startsWith('#!') ? code.indexOf('\n') : -1;
    if (code.startsWith('#!') && shebangEnd === -1) {
      ms.append(`\n${injection}`);
    } else {
      ms.appendLeft(shebangEnd + 1, injection);
    }
    return { code: ms.toString(), map: ms.generateMap({ hires: true }) };
  }

  return {
    name: 'sentry-orchestrion-register-integrations',
    configResolved(config: { command: string }): void {
      command = config.command;
    },
    resolveId(id: string): string | null {
      return id === REGISTER_MODULE_ID ? RESOLVED_REGISTER_MODULE_ID : null;
    },
    load(id: string): { code: string; moduleSideEffects: boolean } | null {
      if (id !== RESOLVED_REGISTER_MODULE_ID) return null;
      // Keep this generated rather than moving the side effect into a published
      // entry point: a future allow-list can emit only the requested factory
      // imports here and let Rollup tree-shake the rest of the ESM module.
      return {
        code: [
          `import { registerChannelIntegrations } from ${JSON.stringify(resolvedRegisterModule)};`,
          'registerChannelIntegrations();',
          '',
        ].join('\n'),
        moduleSideEffects: true,
      };
    },
    transform(this: PluginContext | undefined, code: string, id: string): { code: string; map: unknown } | null {
      // Client bundles must never pull in a server SDK's integrations; without
      // environment info (classic non-environment-API Vite) assume server.
      if (this?.environment?.config?.consumer === 'client') return null;

      if (command === 'build') {
        // Inject into the app entry only. It must be the first module request so
        // registration runs before an entry body or a re-exported worker module
        // can initialize Sentry.
        if (!this?.getModuleInfo?.(id)?.isEntry) return null;
        return injectRegisterImport(code);
      }

      // Dev (`vite dev`): reading `getModuleInfo().isEntry` *throws* in the dev
      // server (`The "isEntry" property of ModuleInfo is not supported`), so
      // detect the entry as the first source module transformed per server
      // environment — the module runner requests the worker entry first. Skip
      // pre-bundled deps, node_modules source, and virtual modules so the import
      // lands in the user's entry, not an incidental early module.
      const environment = this?.environment?.name ?? '';
      const cleanId = id.split('?')[0] ?? id;
      const injectedModule = injectedServeModules.get(environment);
      if (injectedModule && injectedModule !== cleanId) return null;
      if (
        id.startsWith('\0') ||
        cleanId.includes('/node_modules/') ||
        cleanId.includes('/.vite/') ||
        !/\.[cm]?[jt]sx?$/.test(cleanId)
      ) {
        return null;
      }
      const result = injectRegisterImport(code);
      if (result) injectedServeModules.set(environment, cleanId);
      return result;
    },
  };
}

function bundlerMarkerPlugin(): UnknownPlugin {
  const banner = [
    'globalThis.__SENTRY_ORCHESTRION__ = (globalThis.__SENTRY_ORCHESTRION__ || {});',
    'globalThis.__SENTRY_ORCHESTRION__.bundler = true;',
    '',
  ].join('\n');

  let command = 'build';
  const injectedServeModules = new Map<string, string>();

  return {
    name: 'sentry-orchestrion-marker',
    enforce: 'pre' as const,
    applyToEnvironment(environment: { config?: { consumer?: string } }): boolean {
      return environment.config?.consumer !== 'client';
    },
    configResolved(config: { command: string }): void {
      command = config.command;
    },
    config(): { ssr: { noExternal: string[] } } {
      // Force-bundle every instrumented package so the code transform actually
      // sees its source. Vite externalizes dependencies in SSR builds by
      // default, leaving them as bare `require()`/`import` calls resolved from
      // `node_modules` at runtime — those copies are untouched and the
      // diagnostics_channel calls never get injected. Vite merges array
      // `noExternal` entries with the user's config, so we don't overwrite
      // their additions.
      return { ssr: { noExternal: INSTRUMENTED_MODULE_NAMES } };
    },
    configEnvironment(this: { meta?: { rolldownVersion?: string } } | undefined, name: string): unknown {
      if (name === 'client') return undefined;
      // In dev, environments that pre-bundle their dependencies (e.g.
      // `@cloudflare/vite-plugin` worker environments set
      // `optimizeDeps.noDiscovery: false`) load instrumented packages through
      // the dep optimizer, which bypasses the normal Vite transform pipeline —
      // channels would silently never be injected in `vite dev`. Register the
      // code transformer with the optimizer too; it returns null for everything
      // but the instrumented files, so it composes with Vite's loader.
      // Environments without dep optimization ignore this.
      //
      // Vite 8 pre-bundles deps with Rolldown (which takes Rollup-style plugins
      // via `optimizeDeps.rolldownOptions` and deprecates `esbuildOptions`);
      // earlier Vite uses esbuild. Detect via the Rolldown-only
      // `meta.rolldownVersion` and feed the matching transformer flavor.
      if (this?.meta?.rolldownVersion) {
        return {
          optimizeDeps: {
            rolldownOptions: {
              plugins: [codeTransformerRollup({ instrumentations: SENTRY_INSTRUMENTATIONS })],
            },
          },
        };
      }
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [codeTransformerEsbuild({ instrumentations: SENTRY_INSTRUMENTATIONS })],
          },
        },
      };
    },
    transform(
      this: { environment?: { name?: string; config?: { consumer?: string } } } | undefined,
      code: string,
      id: string,
    ): { code: string; map: unknown } | null {
      if (command !== 'serve' || this?.environment?.config?.consumer === 'client') return null;
      const cleanId = id.split('?')[0] ?? id;
      const environment = this?.environment?.name ?? '';
      const injectedModule = injectedServeModules.get(environment);
      if (injectedModule && injectedModule !== cleanId) return null;
      if (
        id.startsWith('\0') ||
        cleanId.includes('/node_modules/') ||
        cleanId.includes('/.vite/') ||
        !/\.[cm]?[jt]sx?$/.test(cleanId)
      ) {
        return null;
      }
      injectedServeModules.set(environment, cleanId);
      const ms = new MagicString(code);
      ms.prepend(banner);
      return { code: ms.toString(), map: ms.generateMap({ hires: true }) };
    },
    renderChunk(
      this: { environment?: { config?: { consumer?: string } } } | undefined,
      code: string,
      chunk: { isEntry: boolean },
    ): { code: string; map: unknown } | null {
      if (!chunk.isEntry || this?.environment?.config?.consumer === 'client') return null;
      // Prepend via magic-string so the entry chunk's sourcemap stays aligned —
      // returning `map: null` here would shift every mapping by the banner's
      // line count and misattribute server stack traces.
      const ms = new MagicString(code);
      ms.prepend(banner);
      return { code: ms.toString(), map: ms.generateMap({ hires: true }) };
    },
  };
}
