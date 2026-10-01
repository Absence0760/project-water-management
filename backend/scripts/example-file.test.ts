// The example catchment a new user starts from (issue #286), as the project
// list ships it (frontend/…/exampleCatchment.generated.json, `pnpm
// gen:example`). It must import (the same document schema as
// POST /projects/import), run cleanly with its stored fit current, and stay
// the Kleinberg example `pnpm seed:examples` builds: the model, the settings
// and the input rainfall are compared exactly, so a change to the examples or
// to the model's fields fails here until the file is regenerated. What the
// generator derives by running the engine (the invented weir record, the EWR,
// the GR4J fit) is not compared, so an engine change that moves a result
// doesn't make the shipped example stale; it is a frozen project like any
// other, and the checks below hold it to the current engine.
import { readFileSync } from 'node:fs';
import { fitRecordStatus, resolveFitRecord, runModelChecked, upgradeLegacyModel, type ModelOutput } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { modelProblems } from '../src/model/validate.js';
import { ProjectFile } from '../src/projects/document.js';
import { EXAMPLE_FILE, exampleDocument, formatDocument, GENERATED_BY } from './example-file.js';
import { buildExamples, inputOf, type ExampleProject } from './examples/catchments.js';

const shipped = JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8')) as ExampleProject & { generatedBy: string };
/** Settings the generator computes by running the engine (the EWR from the natural flow, the fit). */
const DERIVED_SETTINGS = ['ewrPragmaticM3PerDay', 'gr4j', 'fitRecord'] as const;
/** Series the generator derives from a model run (the invented weir record). */
const DERIVED_SERIES = new Set(['flow_observed_m3s']);

const withoutDerived = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).filter(([k]) => !(DERIVED_SETTINGS as readonly string[]).includes(k)));

let source: ExampleProject;
let out: ModelOutput;
beforeAll(() => {
	// Without the fit (seconds): what it fits is engine output, not compared.
	source = buildExamples({ fit: false })[0]!;
	out = runModelChecked(inputOf(shipped));
}, 60_000);

describe('the example catchment on the empty project list', () => {
	it('says what it is: the invented Kleinberg example', () => {
		expect(shipped.generatedBy).toBe(GENERATED_BY);
		expect(shipped.name).toBe('Example · Kleinberg (winter rainfall)');
		expect(shipped.description).toMatch(/^Invented demo catchment\./);
	});

	it('parses as a project document, as POST /projects/import reads it', () => {
		const parsed = ProjectFile.safeParse(shipped);
		expect(parsed.error?.issues ?? []).toEqual([]);
		expect(modelProblems(shipped.model)).toEqual([]);
		// Every field the engine reads, so nothing is left for the legacy upgrade to fill.
		expect(upgradeLegacyModel(shipped.model)).toEqual(shipped.model);
	});

	it('is the seeded Kleinberg example: same model, settings and rainfall (rerun pnpm gen:example if not)', () => {
		expect(shipped.name).toBe(source.name);
		expect(shipped.description).toBe(source.description);
		expect(shipped.model).toEqual(source.model);
		expect(withoutDerived(shipped.settings)).toEqual(withoutDerived(source.settings));
		expect(shipped.series.map((s) => s.kind)).toEqual(source.series.map((s) => s.kind));
		for (const [i, s] of shipped.series.entries()) {
			const want = source.series[i]!;
			if (DERIVED_SERIES.has(s.kind)) expect({ ...s, values: s.values.length }, s.kind).toEqual({ ...want, values: want.values.length });
			else expect(s, s.kind).toEqual(want);
		}
	});

	it('runs with every self-check passing and a weir record to calibrate against', () => {
		expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
		expect(out.summary.calibration?.excludedDays).toBeGreaterThan(300);
	});

	it('carries a GR4J fit that still describes its settings, so a new user doesn’t start on a stale fit', () => {
		const fit = resolveFitRecord(shipped.settings as Parameters<typeof resolveFitRecord>[0])!;
		expect(fit.model).toBe('gr4j');
		expect(shipped.settings.gr4j).toMatchObject(fit.params);
		const { editedParams, ...changed } = fitRecordStatus(shipped.settings, fit);
		expect(editedParams).toEqual([]);
		expect(Object.entries(changed).filter(([, v]) => v !== false)).toEqual([]);
	});

	it('is written by the generator’s format: numbers on one line, the rest indented', () => {
		expect(readFileSync(EXAMPLE_FILE, 'utf8')).toBe(formatDocument(exampleDocument(shipped)));
		expect(formatDocument({ a: [1, -2.5, null, 3e-7], b: [{ c: 'x' }] })).toBe('{\n\t"a": [1,-2.5,null,3e-7],\n\t"b": [\n\t\t{\n\t\t\t"c": "x"\n\t\t}\n\t]\n}\n');
		// A long run of digits ahead of something that isn't a number: the old pattern's optional comma
		// backtracked exponentially here (CodeQL js/redos; 24 digits took 150 ms, each one more doubles it,
		// so this would outlast the test's timeout); the required separator keeps it linear.
		const tail = { s: `[${'0'.repeat(40)}x` };
		expect(formatDocument(tail)).toBe(`${JSON.stringify(tail, null, '\t')}\n`);
	});
});
