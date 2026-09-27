// Guard: a dynamic import's preload list leaves out the chunks its importer
// already imports statically (frontend/vite.config.ts, preloadDedupe; issue
// #9). They are loaded before the importer's code runs, so preloading them
// again does nothing but ship their names (~2.3 KB gzip across the bundle,
// scripts/guards/check_web_bundle_budget.mjs's change log).
import { describe, expect, it } from 'vitest';
import config, { preloadDedupe } from '../../vite.config';

type Handler = (options: unknown, bundle: Record<string, unknown>) => void;

function withBundle(chunks: Record<string, string[]>) {
	const p = preloadDedupe();
	const bundle: Record<string, unknown> = {};
	for (const [file, imports] of Object.entries(chunks)) bundle[file] = { type: 'chunk', imports };
	bundle['_app/immutable/assets/a.css'] = { type: 'asset' };
	(p.plugin.generateBundle as { order: string; handler: Handler }).handler({}, bundle);
	return p;
}

describe('preload lists without what the importer already has', () => {
	const c = (n: string) => `_app/immutable/chunks/${n}.js`;
	// host imports svelte and api (and api imports util); the lazy tab imports svelte, util and its own panel.
	const graph = {
		[c('host')]: [c('svelte'), c('api')],
		[c('api')]: [c('util')],
		[c('svelte')]: [],
		[c('util')]: [],
		[c('tab')]: [c('svelte'), c('util'), c('panel')],
		[c('panel')]: [],
	};

	it('drops the chunks in the importer’s static import tree, direct or indirect', () => {
		const p = withBundle(graph);
		const deps = [c('tab'), c('svelte'), c('util'), c('panel')];
		expect(p.resolveDependencies(c('tab'), deps, { hostId: c('host'), hostType: 'js' })).toEqual([c('tab'), c('panel')]);
	});

	it('keeps everything for an importer with no static imports, and for HTML hosts', () => {
		const p = withBundle(graph);
		const deps = [c('tab'), c('svelte'), c('util'), c('panel')];
		expect(p.resolveDependencies(c('tab'), deps, { hostId: c('panel'), hostType: 'js' })).toEqual(deps);
		expect(p.resolveDependencies(c('tab'), deps, { hostId: 'index.html', hostType: 'html' })).toEqual(deps);
	});

	it('keeps the list as Vite wrote it before the bundle is known', () => {
		const p = preloadDedupe();
		const deps = [c('tab'), c('svelte')];
		expect(p.resolveDependencies(c('tab'), deps, { hostId: c('host'), hostType: 'js' })).toEqual(deps);
	});

	it('is the page build’s modulePreload rule, with its plugin registered', () => {
		const cfg = config as { build: { modulePreload: { resolveDependencies: unknown } }; plugins: { name?: string }[] };
		expect(typeof cfg.build.modulePreload.resolveDependencies).toBe('function');
		const names = cfg.plugins.flat().map((p) => p?.name);
		expect(names).toContain('water:preload-dedupe');
	});
});
