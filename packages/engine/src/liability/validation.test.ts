import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../manifest';
import { runModel } from '../run';
import { ENGINE_VERSION } from '../version';
import { randomInput } from '../testing/fuzz';
import type { RunSummary } from '../project';
import { DISCLAIMER } from './disclaimer';
import { KNOWN_LIMITATIONS } from './limitations.generated';
import { signoffStatement, signoffStatementText } from './signoff';
import { moriasiNse, moriasiPbias, validationStatement } from './validation';

describe('Moriasi et al. (2007) ratings', () => {
	it.each([
		[0.76, 'very good'],
		[0.75, 'good'],
		[0.66, 'good'],
		[0.65, 'satisfactory'],
		[0.51, 'satisfactory'],
		[0.5, 'unsatisfactory'],
		[-3, 'unsatisfactory']
	] as const)('NSE %s → %s', (v, r) => expect(moriasiNse(v)).toBe(r));

	it.each([
		[0, 'very good'],
		[-9.99, 'very good'],
		[10, 'good'],
		[-14.9, 'good'],
		[15, 'satisfactory'],
		[24.9, 'satisfactory'],
		[-25, 'unsatisfactory']
	] as const)('PBIAS %s %% → %s', (v, r) => expect(moriasiPbias(v)).toBe(r));

	it('has no rating without a value', () => {
		expect(moriasiNse(null)).toBeNull();
		expect(moriasiPbias(Number.NaN)).toBeNull();
	});
});

describe('validationStatement', () => {
	it('restates a real run faithfully (random catchments)', () => {
		for (const seed of [1, 2, 3, 7]) {
			const input = randomInput(seed);
			const summary = runModel(input).summary;
			const v = validationStatement({ summary, engineVersion: ENGINE_VERSION, legacy: false });
			expect(v.engineVersion).toBe(ENGINE_VERSION);
			expect(v.limitations).toBe(KNOWN_LIMITATIONS);
			const c = summary.calibration;
			if (c && c.days > 0) {
				expect(v.calibration!.days).toBe(c.days);
				expect(v.calibration!.metrics.find((m) => m.id === 'nse')).toMatchObject({ value: c.nse, rating: moriasiNse(c.nse) });
				expect(v.calibration!.metrics.find((m) => m.id === 'pbias')).toMatchObject({ value: c.pbias, rating: moriasiPbias(c.pbias) });
				expect(v.calibration!.caveat).toMatch(/monthly flows/);
			} else expect(v.calibration).toBeNull();
			const rc = summary.catchment.runoffCoefficient;
			if (rc != null) expect(v.runoffCoefficient).toEqual({ value: rc, plausible: rc <= 1 });
			if (summary.verification) expect(v.selfChecks!.passed).toBe(summary.verification.passed);
			// JSON-safe, so it can be stored with a pack and hashed.
			expect(() => canonicalJson(v)).not.toThrow();
		}
	});

	const bare = (over: Partial<RunSummary> = {}): RunSummary =>
		({
			farms: [],
			catchment: { meanNaturalFlowM3Day: 1, meanSimulatedOutflowM3Day: 1, ewrDaysNotMet: 0, ewrFractionDaysNotMet: 0 },
			calibration: null,
			warnings: [],
			...over
		}) as RunSummary;

	it('flags an impossible runoff coefficient (audit W1) and the low-vs-CHIRPS water years', () => {
		const v = validationStatement({
			summary: bare({
				catchment: { meanNaturalFlowM3Day: 1, meanSimulatedOutflowM3Day: 1, ewrDaysNotMet: 0, ewrFractionDaysNotMet: 0, runoffCoefficient: 4.9 },
				dataQuality: {
					observedAgreement: null,
					seriesChecks: [
						{ seriesKind: 'rain_catchment_mm', check: 'lowvschirps', days: 365, examples: [{ date: '2015-10-01', endDate: '2016-09-30', value: 0.4 }], text: 'One water year reads 40 % of CHIRPS.' }
					],
					areaMismatches: []
				}
			}),
			engineVersion: '0.31.2',
			legacy: true
		});
		expect(v.runoffCoefficient).toEqual({ value: 4.9, plausible: false });
		expect(v.flaggedYears).toEqual([{ seriesKind: 'rain_catchment_mm', start: '2015-10-01', end: '2016-09-30', ratio: 0.4 }]);
		expect(v.dataQuality).toEqual(['One water year reads 40 % of CHIRPS.']);
		expect(v.legacy).toBe(true);
		expect(v.calibration).toBeNull();
		expect(v.selfChecks).toBeNull();
	});

	it('claims a build’s test results only for the version that build made', () => {
		const build = { version: '0.31.2', gitSha: 'abc123', invariantsPassed: true, soakCases: 20000 };
		expect(validationStatement({ summary: bare(), engineVersion: '0.31.2', legacy: false }, build).build).toEqual(build);
		expect(validationStatement({ summary: bare(), engineVersion: '0.30.0', legacy: false }, build).build).toBeNull();
	});
});

describe('signoffStatement', () => {
	const run = { id: '00000000-0000-4000-8000-000000000001', engineVersion: '0.31.2', scenario: false };

	it('asks for the five confirmations, and words the works one for a baseline or a scenario', () => {
		const base = signoffStatement(run);
		expect(base.confirmations.map((c) => c.id)).toEqual(['calibration', 'ewr', 'works', 'assurance', 'limitations']);
		expect(base.confirmations[2]!.text).toMatch(/existing works/);
		expect(signoffStatement({ ...run, scenario: true }).confirmations[2]!.text).toMatch(/proposed works/);
		expect(base.limitations).toBe(KNOWN_LIMITATIONS);
		expect(base.disclaimerVersion).toBe(DISCLAIMER.version);
		expect(base.notes.join(' ')).toMatch(/self-declared/);
	});

	it('gives the same text for the same run, and a different one when anything it binds changes', () => {
		const text = signoffStatementText(signoffStatement(run));
		expect(signoffStatementText(signoffStatement({ ...run }))).toBe(text);
		expect(signoffStatementText(signoffStatement({ ...run, id: '00000000-0000-4000-8000-000000000002' }))).not.toBe(text);
		expect(signoffStatementText(signoffStatement({ ...run, engineVersion: '0.31.3' }))).not.toBe(text);
		expect(signoffStatementText(signoffStatement(run, KNOWN_LIMITATIONS.slice(1)))).not.toBe(text);
	});
});
