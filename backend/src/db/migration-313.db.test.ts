// Migration 313 (issue #670): a `fit` erratum keys on every fit a run's
// parameters came from, not just the headline location's.
// run_fit_engine_versions is the engine's runFitEngineVersions in SQL, so each
// case here is asserted equal to the engine's answer on the same JSON; the
// sweep, the verify lookup and the specialist's pack read it. The sweep's
// behaviour on runs (and who it mails) is in errata/notices.db.test.ts.
import { runFitEngineVersions } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { asOwner } from '../__tests__/helpers.js';

const versions = async (inputs: unknown, summary: unknown): Promise<string[]> =>
	(await asOwner('SELECT run_fit_engine_versions($1::jsonb, $2::jsonb) AS v', [JSON.stringify(inputs), JSON.stringify(summary)]))[0]!.v as string[];
const headline = async (inputs: unknown, summary: unknown): Promise<string | null> =>
	(await asOwner('SELECT run_fit_engine_version($1::jsonb, $2::jsonb) AS v', [JSON.stringify(inputs), JSON.stringify(summary)]))[0]!.v as string | null;

const G = '00000000-0000-4000-8000-000000000001';
const H = '00000000-0000-4000-8000-000000000002';
const settings = {
	fitRecord: { engineVersion: '1.100.0' },
	calibrationZones: [
		{ nodeId: G, fitRecord: { engineVersion: '1.109.0' } },
		{ nodeId: H, fitRecord: { engineVersion: '1.95.0' } },
		// A repeated gauge's second row: the engine ignores it, and so does the lookup.
		{ nodeId: G, fitRecord: { engineVersion: '9.9.9' } },
		'not a row',
		{ nodeId: 7, fitRecord: { engineVersion: '8.8.8' } }
	]
};
const zone = (nodeId: unknown, extra: Record<string, unknown> = {}) => ({ nodeId, name: 'Z', units: [], ...extra });
const summaryOf = (...zones: unknown[]) => ({ unitRain: { zones } });

// [what, inputs, summary, expected]
const CASES: [string, unknown, unknown, string[]][] = [
	['headline at the outlet, two gauge locations', { settings }, summaryOf(zone(G, { kind: 'gauge' }), zone(H, { kind: 'gauge' }), zone(null, { kind: 'outlet', headline: true })), ['1.100.0', '1.109.0', '1.95.0']],
	['headline at a gauge, another gauge, no outlet location', { settings }, summaryOf(zone(H, { kind: 'gauge' }), zone(G, { kind: 'gauge', headline: true })), ['1.109.0', '1.95.0']],
	['a gauge location that took the catchment’s parameters', { settings }, summaryOf(zone(H, { kind: 'gauge', fitted: false }), zone(G, { kind: 'gauge', headline: true })), ['1.100.0', '1.109.0', '1.95.0']],
	['the units on settings.gr4j', { settings }, summaryOf(zone(G, { kind: 'gauge', headline: true }), zone(null, { kind: 'default' })), ['1.100.0', '1.109.0']],
	['before engine 1.110.0: no headline mark', { settings }, summaryOf(zone(H)), ['1.100.0', '1.95.0']],
	['no gauge location', { settings }, {}, ['1.100.0']],
	['a numeric node id matches no row', { settings }, summaryOf(zone(7, { headline: true })), ['1.100.0']],
	['a junk zone is skipped', { settings }, summaryOf(42, zone(G, { kind: 'gauge', headline: true })), ['1.109.0']],
	['a row without a fit', { settings: { calibrationZones: [{ nodeId: G, fitRecord: null }] } }, summaryOf(zone(G, { kind: 'gauge', headline: true })), []],
	['a version that isn’t a string', { settings: { fitRecord: { engineVersion: 7 } } }, {}, []],
	['zones that aren’t a list', { settings: {} }, { unitRain: { zones: 'not a list' } }, []],
	['nothing', {}, {}, []]
];

describe('run_fit_engine_versions: the engines of every fit a run’s parameters came from (313, issue #670)', () => {
	it.each(CASES)('%s: agrees with the engine’s runFitEngineVersions', async (_what, inputs, summary, expected) => {
		const i = inputs as { settings?: unknown };
		expect(runFitEngineVersions(i.settings, summary)).toEqual(expected);
		expect(await versions(inputs, summary)).toEqual(expected);
	});

	it('always holds the headline’s fit (run_fit_engine_version)', async () => {
		for (const [what, inputs, summary] of CASES) {
			const h = await headline(inputs, summary);
			// Only string versions are kept; the headline function reads a number as text, which no erratum can match.
			if (h !== null && h !== '7') expect(await versions(inputs, summary), what).toContain(h);
		}
	});

	it('is what the errata sweep, the verify lookup and the specialist’s pack read a run’s fits by', async () => {
		const rows = (await asOwner(
			`SELECT proname AS name, prosrc AS src FROM pg_proc WHERE proname IN ('app_erratum_sweep', 'app_verify_pack', 'app_specialist_pack') ORDER BY proname`
		)) as { name: string; src: string }[];
		expect(rows.map((r) => r.name)).toEqual(['app_erratum_sweep', 'app_specialist_pack', 'app_verify_pack']);
		for (const r of rows) {
			expect(r.src, r.name).toContain('run_fit_engine_versions(r.inputs, r.summary)');
			expect(r.src, r.name).not.toContain('run_fit_engine_version(');
		}
	});
});
