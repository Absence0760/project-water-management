// The errata are generated from docs/engine-errata.md (WP-3.13): the
// committed list must be exactly what the doc says, and errataFor must pick
// the ones whose version range holds a run's engine.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../version';
import { compareEngineVersions, errataFor, parseErrata, runFitEngineVersions, type Erratum } from './errata';
import { ENGINE_ERRATA } from './errata.generated';
import { renderErrataModule } from './generate';

const DOC = fileURLToPath(new URL('../../../../docs/engine-errata.md', import.meta.url));
const GENERATED = fileURLToPath(new URL('./errata.generated.ts', import.meta.url));
const doc = readFileSync(DOC, 'utf8');

const e = (id: string, firstAffected: string, fixedIn: string | null, keyedOn: Erratum['keyedOn'] = 'run'): Erratum => ({
	id,
	keyedOn,
	firstAffected,
	fixedIn,
	severity: 'High',
	appliesWhen: 'always',
	summary: 'wrong',
	source: 'test'
});

describe('ENGINE_ERRATA (generated from docs/engine-errata.md)', () => {
	it('is current: regenerate with `pnpm gen:liability` after changing the errata table', () => {
		const parsed = parseErrata(doc);
		expect(ENGINE_ERRATA).toEqual(parsed);
		expect(readFileSync(GENERATED, 'utf8')).toBe(renderErrataModule(parsed));
	});

	it('holds plain text, and every source names where it is documented', () => {
		expect(ENGINE_ERRATA.length).toBeGreaterThan(0);
		for (const x of ENGINE_ERRATA) {
			expect(x.appliesWhen + x.summary + x.source, x.id).not.toMatch(/\*\*|`|\]\(/);
			expect(x.source, x.id).toMatch(/engine-audit\.md|model\.md/);
		}
	});

	it('refuses a malformed table rather than dropping a row', () => {
		const row = doc.split('\n').find((l) => l.startsWith('| ER-3 |'))!;
		expect(() => parseErrata(doc.replace(row, row.replace('| 0.20.0 |', '| soon |')))).toThrow(/ER-3: fixed in "soon"/);
		expect(() => parseErrata(doc.replace(row, row.replace('| 0.20.0 |', '| 0.10.0 |')))).toThrow(/ER-3: fixed in 0.10.0, not after 0.15.0/);
		expect(() => parseErrata(doc.replace(row, row.replace('| ER-3 |', '| ER-2 |')))).toThrow(/ER-2 is listed twice/);
		expect(() => parseErrata(doc.replace(row, row.replace('| Medium |', '| |')))).toThrow(/"severity" is empty/);
		expect(() => parseErrata(doc.replace(row, row.replace('| ER-3 | run |', '| ER-3 | model |')))).toThrow(/ER-3: keyed on "model"/);
		expect(() => parseErrata(doc.replace('## Errata', '## Bugs'))).toThrow(/Errata/);
		// Control: "open" is a fix version.
		expect(parseErrata(doc.replace(row, row.replace('| 0.20.0 |', '| open |'))).find((x) => x.id === 'ER-3')?.fixedIn).toBeNull();
	});
});

describe('errataFor', () => {
	const list = [e('ER-1', '0.15.0', '0.20.0'), e('ER-2', '1.2.0', null), e('ER-3', '0.0.0', '0.7.0')];

	it('takes the first affected version and stops at the fix', () => {
		expect(errataFor('0.14.9', list)).toEqual([]);
		expect(errataFor('0.6.9', list).map((x) => x.id)).toEqual(['ER-3']);
		expect(errataFor('0.7.0', list)).toEqual([]);
		expect(errataFor('0.15.0', list).map((x) => x.id)).toEqual(['ER-1']);
		expect(errataFor('0.19.3', list).map((x) => x.id)).toEqual(['ER-1']);
		expect(errataFor('0.20.0', list)).toEqual([]);
	});

	it('keeps an open erratum for every later version', () => {
		expect(errataFor('1.2.0', list).map((x) => x.id)).toEqual(['ER-2']);
		expect(errataFor('9.0.0', list).map((x) => x.id)).toEqual(['ER-2']);
		expect(errataFor('1.1.99', list)).toEqual([]);
	});

	it('compares numerically, not as text', () => {
		expect(compareEngineVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
		expect(compareEngineVersions('0.9.0', '0.10.0')).toBeLessThan(0);
		expect(compareEngineVersions('1.2.3', '1.2.3')).toBe(0);
		expect(() => compareEngineVersions('1.2', '1.2.0')).toThrow(/not an engine version/);
	});

	it('keys a fit erratum on the fit\'s engine, not the run\'s', () => {
		const fit = [e('ER-9', '0.5.0', '1.22.0', 'fit')];
		// A current run on parameters fitted by 1.21: affected. Control: the same run on a 1.22 fit, or entered parameters.
		expect(errataFor('1.30.0', fit, '1.21.0').map((x) => x.id)).toEqual(['ER-9']);
		expect(errataFor('1.30.0', fit, '1.22.0')).toEqual([]);
		expect(errataFor('1.30.0', fit, null)).toEqual([]);
		// An old run on a later fit: not affected, though its own engine is in the range.
		expect(errataFor('1.10.0', fit, '1.25.0')).toEqual([]);
	});

	it('keys a fit erratum on any of a run\'s fits when it has several (issue #670)', () => {
		const fit = [e('ER-9', '0.5.0', '1.22.0', 'fit')];
		// One affected location's fit among several is enough. Control: none of them affected, or no fits.
		expect(errataFor('1.30.0', fit, ['1.25.0', '1.21.0']).map((x) => x.id)).toEqual(['ER-9']);
		expect(errataFor('1.30.0', fit, ['1.25.0', '1.22.0'])).toEqual([]);
		expect(errataFor('1.30.0', fit, [])).toEqual([]);
		// A run erratum still keys on the run's engine alone.
		expect(errataFor('0.16.0', list, ['9.0.0']).map((x) => x.id)).toEqual(['ER-1']);
	});

	it('gives nothing for a version that is not x.y.z (a legacy or hand-made run)', () => {
		expect(errataFor('legacy', list)).toEqual([]);
	});

	it('the committed errata all describe older engines than this one, or are still open', () => {
		for (const x of ENGINE_ERRATA) {
			if (x.fixedIn) expect(compareEngineVersions(x.fixedIn, ENGINE_VERSION), x.id).toBeLessThanOrEqual(0);
		}
	});
});

describe('runFitEngineVersions (issue #670)', () => {
	const G = 'g-1';
	const H = 'g-2';
	const settings = {
		fitRecord: { engineVersion: '1.100.0' },
		calibrationZones: [
			{ nodeId: G, fitRecord: { engineVersion: '1.109.0' } },
			{ nodeId: H, fitRecord: { engineVersion: '1.95.0' } },
			{ nodeId: G, fitRecord: { engineVersion: '9.9.9' } }
		]
	};
	const zone = (nodeId: string | null, extra: Record<string, unknown> = {}) => ({ nodeId, name: 'Z', units: [], ...extra });

	it('reads every applied location: each gauge’s row (its first) and the top level for the outlet’s, the headline or not', () => {
		const summary = { unitRain: { zones: [zone(G, { kind: 'gauge' }), zone(H, { kind: 'gauge' }), zone(null, { kind: 'outlet', headline: true })] } };
		expect(runFitEngineVersions(settings, summary)).toEqual(['1.100.0', '1.109.0', '1.95.0']);
		// Headline at a gauge, no outlet location: the top level is left out (it gave no unit its parameters).
		expect(runFitEngineVersions(settings, { unitRain: { zones: [zone(H, { kind: 'gauge' }), zone(G, { kind: 'gauge', headline: true })] } })).toEqual(['1.109.0', '1.95.0']);
	});

	it('adds the top level for a gauge location with no parameters of its own, and for the units on settings.gr4j', () => {
		expect(runFitEngineVersions(settings, { unitRain: { zones: [zone(G, { kind: 'gauge', headline: true, fitted: false })] } })).toEqual(['1.100.0', '1.109.0']);
		expect(runFitEngineVersions(settings, { unitRain: { zones: [zone(G, { kind: 'gauge', headline: true }), zone(null, { kind: 'default' })] } })).toEqual(['1.100.0', '1.109.0']);
	});

	it('reads the top level for a run with no gauge location, or with no headline (before engine 1.110.0)', () => {
		expect(runFitEngineVersions(settings, {})).toEqual(['1.100.0']);
		expect(runFitEngineVersions(settings, { unitRain: { zones: [zone(H)] } })).toEqual(['1.100.0', '1.95.0']);
	});

	it('skips what isn’t the shape: no fit, a row without one, junk', () => {
		expect(runFitEngineVersions({ calibrationZones: [{ nodeId: G, fitRecord: null }] }, { unitRain: { zones: [zone(G, { headline: true })] } })).toEqual([]);
		expect(runFitEngineVersions({ fitRecord: { engineVersion: 7 } }, { unitRain: { zones: 'not a list' } })).toEqual([]);
		expect(runFitEngineVersions(null, null)).toEqual([]);
		expect(runFitEngineVersions(settings, { unitRain: { zones: [42, zone(G, { headline: true })] } })).toEqual(['1.109.0']);
	});
});
