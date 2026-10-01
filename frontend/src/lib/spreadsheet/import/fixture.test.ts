// CI parity test (WP-1.31): the TypeScript importer on the committed
// synthetic b023 workbook must produce exactly the committed output of the
// Python importer (scripts/wbt-import/fixtures/, make_synthetic_workbook.py),
// the project JSON and the notes, with and without --gauge-as-reference, and
// with --run-of-river (the import dialog's run-of-river option).
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WorkbookSource } from './source';
import { extractProject, readWorkbook } from './index';
import { jsonDiff, projectNotes } from './parity';

const FIXTURES = new URL('../../../../../scripts/wbt-import/fixtures/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, FIXTURES));
const lines = (name: string) => read(name).toString('utf8').split('\n');

describe('synthetic b023 workbook: parity with extract_project.py', () => {
	let wb: WorkbookSource;
	beforeAll(async () => {
		wb = await readWorkbook(read('synthetic_b023.xlsx'));
	});

	it('writes the same project.json', () => {
		const { project } = extractProject(wb, { fileName: 'synthetic_b023.xlsx' });
		expect(jsonDiff(project, JSON.parse(read('synthetic_b023.project.json').toString('utf8')))).toBeNull();
	});

	it('prints the same notes, in the same order', () => {
		const { notes } = extractProject(wb, { fileName: 'synthetic_b023.xlsx' });
		expect(notes.map((n) => n.message)).toEqual(projectNotes(lines('synthetic_b023.notes.txt')));
		// Foxtrot's transfer to Golf has a =0 draw formula; Delta Farm has no dam but all the upstream inflow, and
		// India Farm's dam is a pool on the river (issue #54, 2d); Charlie Farm's gross demand is typed over the formula (issue #54);
		// India's transfer into Delta (no dam, no demand) is a river off-take (engine 1.14.0), switched off (=0).
		// Fodder E has a lone 0 and a spike above 1, and Pasture F is Pasture C's row pasted (issue #289).
		expect(notes.filter((n) => n.severity === 'warning').map((n) => `${n.code}:${n.element}`)).toEqual([
			'transfer-switched-off:Foxtrot Farm',
			'transfer-switched-off:India Farm',
			'probable-run-of-river:Delta Farm',
			'probable-run-of-river:India Farm',
			'crop-factors-suspect:Fodder E',
			'crop-factors-copied:Pasture F',
			'farm-demand-gross-mismatch:Charlie Farm',
			'transfer-river-offtake:India Farm'
		]);
	});

	it('matches --gauge-as-reference --gauge-scaling-from 2021-10-01 --gauge-scale-factor 0.8', () => {
		const { project, notes } = extractProject(wb, {
			fileName: 'synthetic_b023.xlsx',
			gaugeAsReference: { scalingFrom: '2021-10-01', scaleFactor: 0.8 }
		});
		expect(jsonDiff(project, JSON.parse(read('synthetic_b023.gauge-reference.project.json').toString('utf8')))).toBeNull();
		expect(notes.map((n) => n.message)).toEqual(projectNotes(lines('synthetic_b023.gauge-reference.notes.txt')));
		expect(notes.filter((n) => n.severity === 'warning').map((n) => n.code)).toEqual(['transfer-switched-off', 'transfer-switched-off', 'probable-run-of-river', 'probable-run-of-river', 'crop-factors-suspect', 'crop-factors-copied', 'farm-demand-gross-mismatch', 'transfer-river-offtake', 'gauge-as-reference-calibration-unset']);
	});

	it('matches --run-of-river: Delta and India imported as run of river, nothing else changed', () => {
		const { project, notes } = extractProject(wb, { fileName: 'synthetic_b023.xlsx', runOfRiver: true });
		expect(jsonDiff(project, JSON.parse(read('synthetic_b023.run-of-river.project.json').toString('utf8')))).toBeNull();
		expect(notes.map((n) => n.message)).toEqual(projectNotes(lines('synthetic_b023.run-of-river.notes.txt')));
		// India's transfer into Delta is a river off-take, so it doesn't keep India's dummy dam.
		expect(notes.filter((n) => n.code.startsWith('run-of-river-')).map((n) => `${n.code}:${n.element}`)).toEqual([
			'run-of-river-imported:Delta Farm',
			'run-of-river-imported:India Farm'
		]);
		const converted = project.model.nodes.filter((n) => n.supplyRule === 'runOfRiver');
		expect(converted.map((n) => [n.name, n.damCapacityM3, n.pumpCapacityM3Day])).toEqual([
			['Delta Farm', 0, null],
			['India Farm', 0, null]
		]);
	});

	it('lists what it could not map', () => {
		const { unmapped } = extractProject(wb, { fileName: 'synthetic_b023.xlsx' });
		const codes = unmapped.map((u) => `${u.code}:${u.element ?? ''}`);
		// The conveyance-loss InOut formula on Echo (=U7*0.9-X7), the blank Specific share, the M1 lists, the skipped columns.
		expect(codes).toContain('transfer-inout-formula:Echo Farm');
		expect(codes).toContain('flow-share-missing:Charlie Farm');
		expect(codes).toContain('transfer-months-substring:Foxtrot Farm');
		expect(unmapped.some((u) => u.code === 'transfer-zero-rate')).toBe(true);
		expect(unmapped.some((u) => u.code === 'transfer-no-destination')).toBe(true);
		// The text cells in the gauge and rain columns read as blank, as in the Python.
		expect(unmapped.filter((u) => u.code === 'non-numeric-series-values').length).toBe(2);
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('reads the same dates east and west of UTC', async () => {
			const expected = JSON.parse(read('synthetic_b023.project.json').toString('utf8'));
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/St_Johns']) {
				process.env.TZ = zone;
				const { project } = extractProject(await readWorkbook(read('synthetic_b023.xlsx')), { fileName: 'synthetic_b023.xlsx' });
				expect(jsonDiff(project, expected), zone).toBeNull();
			}
		});
	});
});
