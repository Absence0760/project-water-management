import { ENGINE_VERSION } from '@water-management/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineBuild } from './engineBuild.js';

const record = { version: ENGINE_VERSION, gitSha: '0123456789abcdef0123456789abcdef01234567', invariantsPassed: true, soakCases: 2000 };

describe('engineBuild', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('is null when no record was injected (dev, tests, any bundle built without one)', () => {
		expect(engineBuild()).toBeNull();
	});

	it('reads the record the bundle was built with', () => {
		vi.stubGlobal('__ENGINE_BUILD_JSON__', JSON.stringify(record));
		expect(engineBuild()).toEqual(record);
	});

	it('is null for an empty define, bad JSON, or a record of another engine version', () => {
		for (const v of ['', '{not json', JSON.stringify({ ...record, version: '0.0.1' }), JSON.stringify({ ...record, gitSha: 'x' })]) {
			vi.stubGlobal('__ENGINE_BUILD_JSON__', v);
			expect(engineBuild(), v).toBeNull();
		}
	});
});
