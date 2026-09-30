import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../version';
import { asEngineBuild, parseEngineBuild } from './engineBuild';

const record = { version: ENGINE_VERSION, gitSha: '0123456789abcdef0123456789abcdef01234567', invariantsPassed: true, soakCases: 2000 };

describe('parseEngineBuild', () => {
	it('reads the record the release script writes, for this engine version', () => {
		expect(parseEngineBuild(JSON.stringify(record))).toEqual(record);
		expect(parseEngineBuild(JSON.stringify({ ...record, invariantsPassed: false }))?.invariantsPassed).toBe(false);
	});

	it('is null without a record: unset, empty, or not JSON', () => {
		for (const s of [undefined, null, '', '{', 'null', 'undefined', '"x"', '[]']) expect(parseEngineBuild(s), String(s)).toBeNull();
	});

	it('never vouches for another engine version (a stale engine-build.json)', () => {
		expect(parseEngineBuild(JSON.stringify({ ...record, version: '0.0.1' }))).toBeNull();
		expect(parseEngineBuild(JSON.stringify({ ...record, version: '0.0.1' }), '0.0.1')?.version).toBe('0.0.1');
	});

	it('refuses a record of the wrong shape', () => {
		for (const bad of [
			{ ...record, version: '' },
			{ ...record, gitSha: 'abc' },
			{ ...record, gitSha: 'ABCDEF1' },
			{ ...record, gitSha: 'not-a-sha' },
			{ ...record, invariantsPassed: 'true' },
			{ ...record, soakCases: -1 },
			{ ...record, soakCases: 1.5 },
			{ ...record, soakCases: '2000' },
			{ version: ENGINE_VERSION, gitSha: record.gitSha, invariantsPassed: true }
		])
			expect(parseEngineBuild(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
	});

	it('keeps only the four fields', () => {
		expect(asEngineBuild({ ...record, extra: '<script>' })).toEqual(record);
	});
});

describe('the release script agrees with the parser', () => {
	it('scripts/release/engine-build.mjs --check accepts exactly what parseEngineBuild reads', async () => {
		// package-lambdas.sh validates ENGINE_BUILD_JSON with the script before baking it into the bundles.
		const script = (await import('../../../../scripts/release/engine-build.mjs' as string)) as { checkJson: (json: string, version: string) => string | null };
		const cases = [
			JSON.stringify(record),
			JSON.stringify({ ...record, invariantsPassed: false, soakCases: 0 }),
			JSON.stringify({ ...record, version: '0.0.1' }),
			JSON.stringify({ ...record, gitSha: 'abc' }),
			JSON.stringify({ ...record, gitSha: 'ABCDEF1' }),
			JSON.stringify({ ...record, soakCases: 1.5 }),
			JSON.stringify({ ...record, invariantsPassed: 1 }),
			'{',
			'[]',
			'null'
		];
		for (const c of cases) expect(script.checkJson(c, ENGINE_VERSION) === null, c).toBe(parseEngineBuild(c) !== null);
	});
});
