import { describe, expect, it } from 'vitest';
import { sentryOrchestrionPlugin } from '../../src/orchestrion/bundler/vite';
import { INSTRUMENTED_MODULE_NAMES } from '../../src/orchestrion/config';

function getMarkerPlugin() {
  const plugins = sentryOrchestrionPlugin();
  const marker = plugins.find(p => p.name === 'sentry-orchestrion-marker');
  expect(marker).toBeDefined();
  return marker;
}

// The optimizer names the transformer plugin `code-transformer`, both flavors.
function optimizerPluginNames(meta?: { rolldownVersion?: string }): string[] {
  const marker = getMarkerPlugin();
  const result = marker.configEnvironment.call({ meta }, 'ssr');
  const opts = result?.optimizeDeps ?? {};
  const plugins = opts.rolldownOptions?.plugins ?? opts.esbuildOptions?.plugins ?? [];
  return plugins.map((p: { name: string }) => p.name);
}

describe('sentryOrchestrionPlugin', () => {
  it('returns the marker plugin and the code transformer', () => {
    const plugins = sentryOrchestrionPlugin();
    expect(plugins.map(p => p.name)).toContain('sentry-orchestrion-marker');
    expect(plugins.map(p => p.name)).toContain('code-transformer');
  });

  it('force-bundles instrumented packages via ssr.noExternal', () => {
    const marker = getMarkerPlugin();
    expect(marker.config()).toEqual({ ssr: { noExternal: INSTRUMENTED_MODULE_NAMES } });
  });

  it('prepends the bundler marker banner to entry chunks', () => {
    const marker = getMarkerPlugin();
    const result = marker.renderChunk('console.log("app");', { isEntry: true });
    expect(result.code).toContain('globalThis.__SENTRY_ORCHESTRION__.bundler = true;');
    expect(result.map).toBeDefined();
    expect(marker.renderChunk('console.log("chunk");', { isEntry: false })).toBeNull();
  });

  it('does not prepend the bundler marker to client chunks', () => {
    const marker = getMarkerPlugin();
    const clientContext = { environment: { config: { consumer: 'client' } } };

    expect(marker.renderChunk.call(clientContext, 'console.log("app");', { isEntry: true })).toBeNull();
  });

  it('applies the marker and code transformer only to server environments', () => {
    const plugins = sentryOrchestrionPlugin({ registerIntegrations: true });
    const environmentPlugins = plugins.filter(
      plugin => plugin.name === 'sentry-orchestrion-marker' || plugin.name === 'code-transformer',
    );

    expect(environmentPlugins.every(plugin => plugin.applyToEnvironment({ config: { consumer: 'server' } }))).toBe(
      true,
    );
    expect(environmentPlugins.every(plugin => !plugin.applyToEnvironment({ config: { consumer: 'client' } }))).toBe(
      true,
    );
  });

  it('injects the marker as a hoisted import during dev and reinjects it after entry HMR', () => {
    const marker = getMarkerPlugin();
    marker.configResolved({ command: 'serve' });
    const context = { environment: { name: 'worker', config: { consumer: 'server' } } };

    const initial = marker.transform.call(context, `import './instrument';\n`, '/app/src/index.ts');
    const updated = marker.transform.call(
      context,
      `import './instrument';\nexport const updated = true;\n`,
      '/app/src/index.ts?t=123',
    );

    // A prepended import is hoisted before the instrument import, so it runs
    // before `Sentry.init()` — plain banner statements would not.
    expect(initial?.code).toContain(`import 'virtual:@sentry/orchestrion-marker';`);
    expect(initial?.code.indexOf(`virtual:@sentry/orchestrion-marker`)).toBeLessThan(
      initial?.code.indexOf(`import './instrument'`),
    );
    expect(updated?.code).toContain(`import 'virtual:@sentry/orchestrion-marker';`);
  });

  it('resolves and loads the virtual marker module as a side-effect banner', () => {
    const marker = getMarkerPlugin();

    expect(marker.resolveId('virtual:@sentry/orchestrion-marker')).toBe('\0virtual:@sentry/orchestrion-marker');
    expect(marker.resolveId('some-other-module')).toBeNull();

    const loaded = marker.load('\0virtual:@sentry/orchestrion-marker');
    expect(loaded?.code).toContain('globalThis.__SENTRY_ORCHESTRION__.bundler = true;');
    expect(loaded?.moduleSideEffects).toBe(true);
    expect(marker.load('some-other-module')).toBeNull();
  });

  describe('configEnvironment (dev dep-optimizer instrumentation)', () => {
    it('adds the esbuild transformer for server environments on classic Vite', () => {
      // No `meta.rolldownVersion` → esbuild-based optimizer.
      expect(optimizerPluginNames()).toContain('code-transformer');
      const result = getMarkerPlugin().configEnvironment.call({ meta: {} }, 'ssr');
      expect(result.optimizeDeps.esbuildOptions).toBeDefined();
      expect(result.optimizeDeps.rolldownOptions).toBeUndefined();
    });

    it('adds the rollup transformer via rolldownOptions on Vite 8 / Rolldown', () => {
      const marker = getMarkerPlugin();
      const result = marker.configEnvironment.call({ meta: { rolldownVersion: '1.1.5' } }, 'ssr');
      expect(result.optimizeDeps.rolldownOptions).toBeDefined();
      expect(result.optimizeDeps.esbuildOptions).toBeUndefined();
      expect(result.optimizeDeps.rolldownOptions.plugins.map((p: { name: string }) => p.name)).toContain(
        'code-transformer',
      );
    });

    it('does not instrument the client environment', () => {
      expect(getMarkerPlugin().configEnvironment.call({ meta: {} }, 'client')).toBeUndefined();
    });
  });
});
