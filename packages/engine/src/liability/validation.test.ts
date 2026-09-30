import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../manifest';
import { runModel } from '../run';
import { ENGINE_VERSION } from '../version';
import { randomInput } from '../testing/fuzz';
import type { RunSummary } from '../project';
import { DISCLAIMER } from './disclaimer';
import { KNOWN_LIMITATIONS } from './limitations.generated';
import { signoffStatement, signoffStatementText } from './signoff';
import { moriasiNse, moriasiPbias, parseEngineBuild, validationStatement } from './validation';

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

	it('lists every flagged water year the check holds (issue #70)', () => {
		const examples = Array.from({ length: 7 }, (_, k) => ({ date: `${2000 + k}-10-01`, endDate: `${2001 + k}-09-30`, value: 0.4 }));
		const v = validationStatement({
			summary: bare({ dataQuality: { observedAgreement: null, seriesChecks: [{ seriesKind: 'rain_catchment_mm', check: 'lowvschirps', days: 7 * 365, examples, text: '7 water years.' }], areaMismatches: [] } }),
			engineVersion: '1.31.1',
			legacy: false
		});
		expect(v.flaggedYears.map((y) => y.start)).toEqual(examples.map((e) => e.date));
		expect(v.flaggedYearsMayBeCut).toBe(false);
	});

	it('says a run from before engine 1.31.1 that hit the old cap of 5 may list only some flagged years', () => {
		const years = (n: number) => Array.from({ length: n }, (_, k) => ({ date: `${2000 + k}-10-01`, endDate: `${2001 + k}-09-30`, value: 0.4 }));
		const cut = (engineVersion: string, n: number) =>
			validationStatement({
				summary: bare({ dataQuality: { observedAgreement: null, seriesChecks: [{ seriesKind: 'rain_catchment_mm', check: 'lowvschirps', days: n * 365, examples: years(n), text: `${n} water years.` }], areaMismatches: [] } }),
				engineVersion,
				legacy: false
			}).flaggedYearsMayBeCut;
		expect(cut('1.30.0', 5)).toBe(true);
		expect(cut('0.31.2', 5)).toBe(true);
		expect(cut('1.31.0', 5)).toBe(true);
		// Under the cap, or on an engine that keeps them all: the list is whole.
		expect(cut('1.30.0', 4)).toBe(false);
		expect(cut('1.31.1', 5)).toBe(false);
		expect(cut('1.32.0', 5)).toBe(false);
		expect(cut('2.0.0', 5)).toBe(false);
	});

	it('reads the build record the site build injected, and nothing that isn’t one', () => {
		const build = { version: '1.31.1', gitSha: '0123456789abcdef0123456789abcdef01234567', invariantsPassed: true, soakCases: 4000 };
		expect(parseEngineBuild(JSON.stringify(build))).toEqual(build);
		// Extra keys are dropped, not passed through.
		expect(parseEngineBuild(JSON.stringify({ ...build, note: 'x' }))).toEqual(build);
		for (const raw of [undefined, null, '', 'not json', 'null', '[]', '"1.31.1"']) expect(parseEngineBuild(raw)).toBeNull();
		for (const bad of [{ version: 'v1' }, { gitSha: 'main' }, { invariantsPassed: 'yes' }, { soakCases: -1 }, { soakCases: 1.5 }]) {
			expect(parseEngineBuild(JSON.stringify({ ...build, ...bad }))).toBeNull();
		}
	});

	it('claims a build’s test results only for the version that build made', () => {
		const build = { version: '0.31.2', gitSha: 'abc123', invariantsPassed: true, soakCases: 20000 };
		expect(validationStatement({ summary: bare(), engineVersion: '0.31.2', legacy: false }, build).build).toEqual(build);
		expect(validationStatement({ summary: bare(), engineVersion: '0.30.0', legacy: false }, build).build).toBeNull();
	});
});

describe('signoffStatement', () => {
	const run = { id: '00000000-0000-4000-8000-000000000001', engineVersion: '0.31.2', scenario: false };

	it('asks for the ten confirmations, and words the works one for a baseline or a scenario', () => {
		const base = signoffStatement(run);
		expect(base.version).toBe('signoff-3');
		// signoff-3: the identity confirmation covers the category and field recorded (registration.ts).
		expect(base.confirmations[0]!.text).toMatch(/in the category and field, and under the registration number shown\.$/);
		expect(base.confirmations.map((c) => c.id)).toEqual([
			'identity',
			'competence',
			'conflict',
			'inputs',
			'calibration',
			'ewr',
			'works',
			'assurance',
			'plausibility',
			'limitations'
		]);
		const works = (s: typeof base) => s.confirmations.find((c) => c.id === 'works')!.text;
		expect(works(base)).toMatch(/existing works/);
		const scenario = signoffStatement({ ...run, scenario: true });
		expect(works(scenario)).toMatch(/proposed works/);
		// Only the works confirmation differs between a baseline and a scenario.
		expect(scenario.confirmations.filter((c, i) => c.text !== base.confirmations[i]!.text).map((c) => c.id)).toEqual(['works']);
		expect(base.limitations).toBe(KNOWN_LIMITATIONS);
		expect(base.disclaimerVersion).toBe(DISCLAIMER.version);
		const notes = base.notes.join(' ');
		expect(notes).toMatch(/signer’s own declaration\. This app does not check them/);
		expect(notes).toMatch(/DW793/);
		expect(notes).toMatch(/no finding on whether any water use or works are lawful/);
		expect(notes).toMatch(/does not verify its software/);
		expect(notes).toMatch(/covers this run only/);
	});

	it('gives the same text for the same run, and a different one when anything it binds changes', () => {
		const text = signoffStatementText(signoffStatement(run));
		expect(signoffStatementText(signoffStatement({ ...run }))).toBe(text);
		expect(signoffStatementText(signoffStatement({ ...run, id: '00000000-0000-4000-8000-000000000002' }))).not.toBe(text);
		expect(signoffStatementText(signoffStatement({ ...run, engineVersion: '0.31.3' }))).not.toBe(text);
		expect(signoffStatementText(signoffStatement(run, KNOWN_LIMITATIONS.slice(1)))).not.toBe(text);
	});
});
