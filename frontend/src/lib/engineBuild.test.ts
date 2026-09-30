import { ENGINE_VERSION } from '@water-management/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineBuildDefine } from '../../vite.config';

const record = { version: ENGINE_VERSION, gitSha: '0123456789abcdef0123456789abcdef01234567', invariantsPassed: true, soakCases: 2000 };

async function load(define?: string) {
	vi.resetModules();
	if (define !== undefined) vi.stubGlobal('__ENGINE_BUILD_JSON__', define);
	return (await import('./engineBuild')).ENGINE_BUILD;
}

describe('ENGINE_BUILD', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('is null without the define (dev, vitest, the e2e build)', async () => {
		expect(await load()).toBeNull();
	});

	it('is the injected record', async () => {
		expect(await load(JSON.stringify(record))).toEqual(record);
	});

	it('is null for an empty define, bad JSON, or another engine version', async () => {
		for (const d of ['', '{', JSON.stringify({ ...record, version: '0.0.1' })]) expect(await load(d), d).toBeNull();
	});
});

describe('engineBuildDefine (vite.config.ts)', () => {
	it('injects an empty string when ENGINE_BUILD_JSON is unset or empty', () => {
		expect(engineBuildDefine(undefined)).toBe('""');
		expect(engineBuildDefine('')).toBe('""');
	});

	it('injects the record as a string literal of its JSON, only its four fields', () => {
		const lit = engineBuildDefine(JSON.stringify({ ...record, extra: 1 }));
		expect(JSON.parse(JSON.parse(lit))).toEqual(record);
	});

	it('fails the build on a record it could not show: bad JSON, wrong shape, another engine version', () => {
		for (const bad of ['{', '[]', JSON.stringify({ ...record, gitSha: 'x' }), JSON.stringify({ ...record, version: '0.0.1' })])
			expect(() => engineBuildDefine(bad), bad).toThrow(/ENGINE_BUILD_JSON/);
	});
});
