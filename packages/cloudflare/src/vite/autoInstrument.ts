import { REGISTER_MODULE_ID } from '@sentry/server-utils/orchestrion/vite';
import { resolve } from 'node:path';
import { buildOptionsImport, ENV_FALLBACK_OPTIONS_FN, resolveInstrumentFile } from './instrumentFile';
import { applyAutoInstrumentTransforms, type ProgramBody } from './transform';
import { resolveWranglerConfig, type WranglerConfig } from './wranglerConfig';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UnknownPlugin = any;

// Vite normalizes module IDs to posix separators even on Windows, while
// `path.resolve` yields backslashes there — normalize before comparing.
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

// Extensions the entry-module match may tolerate swapping (e.g. wrangler's
// `main` says `.ts` but the served module is `.js`). Anything else — `.css`,
// `.html`, … — sharing the entry's basename must never be treated as the entry.
const JS_EXTENSION_REGEX = /\.[cm]?[jt]sx?$/;

// Auto-instrumented workers never import `@sentry/cloudflare` in user code, and
// `@cloudflare/vite-plugin` wraps the worker entry in a virtual module, so the
// orchestrion plugin's registration-import injection — which keys off the
// rollup entry (`isEntry`) — may not reach the actual worker entry, leaving the
// channel-subscriber integrations unregistered. Prepend the same shared
// registration module here, matched by wrangler's `main`, so `Sentry.init`
// (invoked by the injected `withSentry` wrapper) still picks them up. The
// module is a virtual side-effect import the orchestrion plugin resolves via
// its `resolveId`/`load` hooks in both `vite build` and `vite dev` — the latter
// being where the build-time `renderChunk` marker never runs.
const ORCHESTRION_REGISTRATION_BANNER = `import ${JSON.stringify(REGISTER_MODULE_ID)};\n`;

export function sentryCloudflareAutoInstrumentPlugin(): UnknownPlugin {
  let wranglerConfig: WranglerConfig | undefined;
  let entryFilePath: string | undefined;

  let optionsFn = ENV_FALLBACK_OPTIONS_FN;
  let optionsImport: string | undefined;

  return {
    name: 'sentry-cloudflare-auto-instrument',

    configResolved(config: { root: string; logger?: { warn(msg: string): void } }): void {
      const result = resolveWranglerConfig(config.root);
      if (!result) {
        config.logger?.warn('[sentry] No parseable wrangler config found — auto-instrumentation disabled.');
        return;
      }

      wranglerConfig = result.config;
      if (wranglerConfig.main) {
        entryFilePath = normalizePath(resolve(result.configDir, wranglerConfig.main));
      }

      if (entryFilePath) {
        const instrumentFilePath = resolveInstrumentFile(entryFilePath);
        if (instrumentFilePath) {
          const built = buildOptionsImport(entryFilePath, instrumentFilePath);
          optionsFn = built.optionsFn;
          optionsImport = built.importStmt;
        }
      }
    },

    transform(
      this: { parse(code: string): ProgramBody; warn?(msg: string): void; environment?: { name?: string } },
      code: string,
      id: string,
    ): { code: string; map: unknown } | undefined {
      if (!wranglerConfig || !entryFilePath) return undefined;

      // The worker entry never belongs to the client (browser) environment.
      // Skipping it keeps a same-basename sibling (e.g. a `src/index.tsx`
      // client entry next to a `src/index.ts` worker) out of the browser bundle.
      if (this.environment?.name === 'client') return undefined;

      // Vite may append query/hash params to the module ID.
      const normalizedId = normalizePath(id.replace(/[?#].*$/, ''));
      if (normalizedId !== entryFilePath) {
        // Tolerate a differing JS-flavored extension (e.g. `.js` vs `.ts`).
        if (!JS_EXTENSION_REGEX.test(normalizedId) || !JS_EXTENSION_REGEX.test(entryFilePath)) return undefined;
        if (normalizedId.replace(JS_EXTENSION_REGEX, '') !== entryFilePath.replace(JS_EXTENSION_REGEX, '')) {
          return undefined;
        }
      }

      let ast: ProgramBody;
      try {
        ast = this.parse(code);
      } catch {
        // Raw TypeScript or syntax error — esbuild hasn't run yet (unlikely)
        // or the file is genuinely broken.  Either way, skip silently.
        return undefined;
      }

      const doClassNames = new Set(wranglerConfig.durableObjects.map(d => d.className));
      // Skip our registration import if the orchestrion plugin's own entry
      // injection already added it (build mode, when this module is the rollup
      // entry). Both injectors gate on the same `REGISTER_MODULE_ID` sentinel,
      // so at most one import lands.
      const prependBanner = code.includes(REGISTER_MODULE_ID) ? undefined : ORCHESTRION_REGISTRATION_BANNER;
      const result = applyAutoInstrumentTransforms(code, ast, {
        doClassNames,
        optionsFn,
        optionsImport,
        prependBanner,
      });

      const wrappedDoClasses = result?.wrappedDoClasses ?? new Set<string>();
      const missing = [...doClassNames].filter(name => !wrappedDoClasses.has(name));
      if (missing.length > 0) {
        this.warn?.(
          `[sentry] Could not auto-instrument Durable Object class(es) ${missing.join(', ')}: no matching ` +
            'exported class declaration found in the worker entry (re-exports from other modules cannot be ' +
            'wrapped automatically). Wrap them manually with `instrumentDurableObjectWithSentry`.',
        );
      }

      return result ?? undefined;
    },
  };
}
