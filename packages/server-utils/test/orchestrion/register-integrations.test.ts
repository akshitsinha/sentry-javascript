import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRegisteredChannelIntegrations } from '../../src/orchestrion/detect';
import { channelIntegrations, registerChannelIntegrations } from '../../src/orchestrion/index';

describe('channel-integration registry', () => {
  beforeEach(() => {
    delete globalThis.__SENTRY_ORCHESTRION__;
  });

  afterEach(() => {
    delete globalThis.__SENTRY_ORCHESTRION__;
  });

  describe('getRegisteredChannelIntegrations', () => {
    it('returns an empty array when no marker exists', () => {
      expect(getRegisteredChannelIntegrations()).toEqual([]);
    });

    it('returns an empty array when the marker has no integrations', () => {
      globalThis.__SENTRY_ORCHESTRION__ = { bundler: true };
      expect(getRegisteredChannelIntegrations()).toEqual([]);
    });

    it('instantiates each registered factory', () => {
      globalThis.__SENTRY_ORCHESTRION__ = {
        integrations: [() => ({ name: 'FirstIntegration' }), () => ({ name: 'SecondIntegration' })],
      };

      expect(getRegisteredChannelIntegrations().map(i => i.name)).toEqual(['FirstIntegration', 'SecondIntegration']);
    });

    it('returns fresh instances on every call', () => {
      globalThis.__SENTRY_ORCHESTRION__ = {
        integrations: [() => ({ name: 'FirstIntegration' })],
      };

      const [first] = getRegisteredChannelIntegrations();
      const [second] = getRegisteredChannelIntegrations();

      expect(first).not.toBe(second);
      expect(first?.name).toBe(second?.name);
    });

  });

  describe('registerChannelIntegrations', () => {
    it('registers a factory for every canonical channel integration', () => {
      registerChannelIntegrations();

      const registered = getRegisteredChannelIntegrations();
      expect(registered).toHaveLength(Object.keys(channelIntegrations).length);
      expect(registered.every(i => typeof i.name === 'string' && i.name.length > 0)).toBe(true);
    });

    it('creates the marker when none exists', () => {
      registerChannelIntegrations();

      expect(globalThis.__SENTRY_ORCHESTRION__?.bundler).toBe(true);
      expect(globalThis.__SENTRY_ORCHESTRION__?.integrations).toBeDefined();
    });

    it('preserves existing marker fields', () => {
      globalThis.__SENTRY_ORCHESTRION__ = { bundler: true, runtime: true };

      registerChannelIntegrations();

      expect(globalThis.__SENTRY_ORCHESTRION__?.bundler).toBe(true);
      expect(globalThis.__SENTRY_ORCHESTRION__?.runtime).toBe(true);
      expect(getRegisteredChannelIntegrations().length).toBeGreaterThan(0);
    });

    it('registers factories, not eagerly-built instances', () => {
      registerChannelIntegrations();

      expect(globalThis.__SENTRY_ORCHESTRION__?.integrations?.every(factory => typeof factory === 'function')).toBe(
        true,
      );
    });
  });
});
