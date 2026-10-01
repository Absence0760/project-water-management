import { afterEach, describe, expect, it } from 'vitest';
import { InvalidImportOptionsError, InvalidWorkbookError, NotB023WorkbookError, UnsupportedVersionError } from './errors';
import { extractProject, projectName } from './extract';
import { projectIds } from './ids';
import { syntheticB023 } from './testWorkbook';
import { readWorkbook } from './workbook';

const FILE = 'Synthetic_WBT_b023.xlsm';
const uid = projectIds('Synthetic');

describe('extractProject on a small synthetic workbook', () => {
	it('builds the project the Python importer would', () => {
		const { project, notes, unmapped } = extractProject(syntheticB023().build(), { fileName: FILE });
		expect(project.name).toBe('Synthetic');
		expect(project.description).toBe(`Imported from ${FILE}`);
		const [a, b, outlet] = project.model.nodes;
		expect(a).toEqual({
			id: uid('node:Farm A'),
			name: 'Farm A',
			kind: 'farm',
			downstreamNodeId: uid('node:Farm B'),
			sortOrder: 0,
			areaKm2: 5,
			areaHiKm2: 4,
			areaLoKm2: 1,
			flowShareManual: 0.5,
			pctUpstreamToDam: 1,
			pctRunoffToDam: 0.2,
			damCapacityM3: 100000,
			damInitialPct: 0.5,
			divertCapacityM3Day: 1000,
			damMinPct: 0,
			irrigationEfficiency: 0.8,
			lossReturnFraction: 1,
			damAreaFullM2: null,
			damAreaExponent: 0.7,
			damSeepagePerDay: 0
		});
		expect(b).toMatchObject({ downstreamNodeId: uid('node:Outlet'), irrigationEfficiency: 1, lossReturnFraction: 0 });
		// A gauge takes the Python's defaults and no flow share.
		expect(outlet).toMatchObject({ kind: 'gauge', downstreamNodeId: null, areaKm2: 0, flowShareManual: null, pctUpstreamToDam: 1, sortOrder: 2 });
		expect(project.model.crops.map((c) => c.id)).toEqual([uid('crop:Maize'), uid('crop:Wheat')]);
		expect(project.model.cropAreas).toEqual([
			{ nodeId: uid('node:Farm A'), cropId: uid('crop:Maize'), areaM2: 10000 },
			{ nodeId: uid('node:Farm B'), cropId: uid('crop:Wheat'), areaM2: 5000 }
		]);
		expect(project.model.transfers).toEqual([
			{
				id: uid('transfer:Farm A>Farm B:O'),
				fromNodeId: uid('node:Farm A'),
				toNodeId: uid('node:Farm B'),
				months: [1, 2, 3],
				maxRateM3s: 0.1,
				dailyCapM3: null,
				minStoragePct: 0.2,
				enabled: true,
				priority: 0
			}
		]);
		expect(project.settings).toEqual({
			februaryDays: 28.25,
			effectiveRainFraction: 0.7,
			apanMm: [150, 190, 230, 240, 200, 170, 120, 90, 70, 75, 95, 120],
			flowShareMethod: 'area',
			hiLoSplit: { hi: 0.8, lo: 0.2 },
			calibration: { rainThresholdMm: 2, catchmentAreaKm2: 12 },
			ewrPragmaticM3PerDay: [900, 1200, 1500, 1500, 1400, 1300, 1100, 900, 800, 700, 700, 800],
			simulationStart: null,
			simulationEnd: null,
			calibrationStart: '2010-01-01',
			calibrationEnd: '2010-01-05',
			calibrationFlowKind: 'flow_observed_m3s'
		});
		expect(project.series.map((s) => [s.kind, s.name, s.unit, s.startDate, s.values.length])).toEqual([
			['flow_observed_m3s', 'Gauge (m³/s)', 'm3/s', '2010-01-01', 5],
			['rain_catchment_mm', 'Rain (mm)', 'mm', '2010-01-01', 5],
			['rain_chirps_mm', 'CHIRPS (mm)', 'mm', '2010-01-01', 5]
		]);
		// Maize's Jan and Feb factors, 1.1, are above 1.0 (issue #289).
		expect(notes.map((n) => n.code)).toEqual(['dam-min-is-transfer-minimum', 'dam-area-unknown', 'crop-factors-suspect']);
		// Column P (no destination, no rate) is an unused column, not a skipped rule.
		expect(unmapped).toEqual([]);
	});

	it('reports progress per part of the workbook', () => {
		const seen: string[] = [];
		extractProject(syntheticB023().build(), { fileName: FILE, onProgress: (sheet, i, n) => seen.push(`${i}/${n} ${sheet}`) });
		expect(seen).toEqual(['1/7 Network', '2/7 Farm spec', '3/7 Crop demand', '4/7 Farm demand', '5/7 Transfers', '6/7 Flow Calibration Cfg', '7/7 Flow data']);
	});

	it('gives the same result from the saved file (dense sheets, only the b023 sheets parsed)', async () => {
		const b = syntheticB023();
		const direct = extractProject(b.build(), { fileName: FILE });
		const fromFile = extractProject(await readWorkbook(b.toFile()), { fileName: FILE });
		expect(fromFile).toEqual(direct);
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('turns Excel serial dates into the same ISO dates east and west of UTC', async () => {
			const file = syntheticB023({ start: '2011-12-30', rain: [0, 1, 2, 3, 4] }).toFile();
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kathmandu', 'UTC']) {
				process.env.TZ = zone;
				const { project } = extractProject(await readWorkbook(file), { fileName: FILE });
				expect(project.series[0]!.startDate, zone).toBe('2011-12-30');
				expect([project.settings.calibrationStart, project.settings.calibrationEnd], zone).toEqual(['2011-12-30', '2012-01-03']);
			}
		});
	});
});

describe('extractProject errors and options', () => {
	it('names the file stem up to _WBT', () => {
		expect(projectName('Upper River_WBT_b023_copy.xlsm')).toBe('Upper River');
		expect(projectName('plain.xlsx')).toBe('plain');
		expect(projectName('_WBT_b023.xlsm')).toBe('_WBT_b023');
		expect(projectName('dir/Name_WBT.xlsm')).toBe('Name');
		expect(projectName('no-extension')).toBe('no-extension');
	});

	it('rejects a workbook without the b023 named ranges', () => {
		const b = syntheticB023().unname('zNetwork_ElementNameLst').unname('zEWR_Pragmatic');
		const err = catchError(() => extractProject(b.build(), { fileName: FILE }));
		expect(err).toBeInstanceOf(NotB023WorkbookError);
		expect((err as NotB023WorkbookError).missing).toEqual(['zNetwork_ElementNameLst', 'zEWR_Pragmatic']);
		expect((err as NotB023WorkbookError).code).toBe('not-b023');
	});

	it('rejects a build other than b02x, and reads a workbook without zAppVer', () => {
		const err = catchError(() => extractProject(syntheticB023().set('AppSettings', 'C11', 'b031').build(), { fileName: FILE }));
		expect(err).toBeInstanceOf(UnsupportedVersionError);
		expect((err as UnsupportedVersionError).version).toBe('b031');
		expect(() => extractProject(syntheticB023().set('AppSettings', 'C11', 'b023').build(), { fileName: FILE })).not.toThrow();
		expect(() => extractProject(syntheticB023().unname('zAppVer').build(), { fileName: FILE })).not.toThrow();
	});

	it('rejects half a gauge scaling or a bad factor, as the Python CLI does', () => {
		const wb = syntheticB023().build();
		for (const bad of [{ scalingFrom: '2006-07-01' }, { scaleFactor: 0.8 }, { scalingFrom: '07/01/2006', scaleFactor: 0.8 }, { scalingFrom: '2006-07-01', scaleFactor: 0 }]) {
			expect(() => extractProject(wb, { fileName: FILE, gaugeAsReference: bad as never }), JSON.stringify(bad)).toThrow(InvalidImportOptionsError);
		}
	});

	it('stops on the structural errors the Python raises', () => {
		const unknownUpstream = syntheticB023().set('Network', 'N28', 'Nowhere');
		expect(() => extractProject(unknownUpstream.build(), { fileName: FILE })).toThrow("[Network] Outlet lists unknown upstream element 'Nowhere'");
		const twoDown = syntheticB023().set('Network', 'N28', 'Farm A');
		expect(() => extractProject(twoDown.build(), { fileName: FILE })).toThrow('[Network] Farm A drains into both Farm B and Outlet');
		const gap = syntheticB023().set('Flow data', 'E23', { date: '2010-01-09' });
		const err = catchError(() => extractProject(gap.build(), { fileName: FILE }));
		expect(err).toBeInstanceOf(InvalidWorkbookError);
		expect((err as Error).message).toBe('[Flow data] dates are not consecutive at 2010-01-02 -> 2010-01-09');
		const noDates = syntheticB023().set('Flow data', 'E21', 'n/a');
		expect(() => extractProject(noDates.build(), { fileName: FILE })).toThrow('[Flow data] has no dated rows');
	});

	it('notes elements with nothing downstream besides the outflow gauge', () => {
		const b = syntheticB023().set('Network', 'M28', null).set('Network', 'M27', null);
		const { notes } = extractProject(b.build(), { fileName: FILE });
		expect(notes.find((n) => n.code === 'several-outlets')?.message).toBe("elements ['Farm A', 'Farm B', 'Outlet'] have no downstream element; only Outlet is the outflow gauge");
	});

	it('warns and unsets calibrationFlowKind for Pitman, or for a series with no values', () => {
		const pitman = extractProject(syntheticB023({ pitman: [1, 1, 1, 1, 1] }).set('Flow data', 'P13', 1).build(), { fileName: FILE });
		expect(pitman.project.settings.calibrationFlowKind).toBeNull();
		expect(pitman.notes.map((n) => [n.code, n.severity])).toContainEqual(['pitman-calibration-unset', 'warning']);
		expect(pitman.notes.find((n) => n.code === 'pitman-not-imported')?.message).toContain('Pitman flow column has 5 days of values');
		const logger = extractProject(syntheticB023().set('Flow data', 'P13', 3).build(), { fileName: FILE });
		expect(logger.project.settings.calibrationFlowKind).toBeNull();
		expect(logger.notes.find((n) => n.code === 'calibration-flow-missing')?.message).toBe(
			'[Flow data] rUseFlow picks flow_logger_m3s, which has no values; calibrationFlowKind left unset'
		);
	});

	it('notes farms and crops in [Farm demand] and transfers that name nothing in the network', () => {
		const b = syntheticB023()
			.set('Farm demand', 'D27', 'Farm Z')
			.set('Farm demand', 'D28', '--')
			.row('Farm demand', 'G27', [1, 1])
			.set('Farm demand', 'H24', 'Barley')
			.set('Transfers', 'O12', 'Farm Q');
		const { notes, project } = extractProject(b.build(), { fileName: FILE });
		expect(notes.map((n) => n.message)).toEqual(
			expect.arrayContaining([
				'[Farm demand] crop Barley is not in [Crop demand]; ignored',
				'[Farm demand] farm Farm Z is not in [Network]; ignored',
				'transfer Farm A -> Farm Q names an unknown element; skipped'
			])
		);
		expect(project.model.transfers).toEqual([]);
	});

	it('notes a farm missing from [Farm spec] and lists a [Farm spec] farm missing from [Network]', () => {
		const b = syntheticB023().set('Farm spec', 'D31', 'Farm C');
		const { notes, unmapped, project } = extractProject(b.build(), { fileName: FILE });
		expect(notes.map((n) => n.message)).toContain('farm Farm B is missing from [Farm spec]; its parameters are 0, except upstream inflow to dam (100 %)');
		expect(project.model.nodes[1]).toMatchObject({ areaKm2: 0, flowShareManual: null, pctUpstreamToDam: 1, irrigationEfficiency: 1 });
		expect(unmapped.map((u) => u.message)).toContain('[Farm spec] farm Farm C is not in [Network]; ignored');
	});
});

describe('the run-of-river option (--run-of-river, issue #54 2c/2d)', () => {
	// Farm A's dam becomes a 0.5 m³ pool on the river (flagged), and its enabled transfer to Farm B draws on it;
	// Farm B has no dam and now takes all of the upstream inflow (flagged).
	const flaggedBoth = () => syntheticB023().set('Farm spec', 'P30', 0.5).set('Farm spec', 'N31', 1);

	it('is off by default: the flagged units are only warned about', () => {
		const { project, notes } = extractProject(flaggedBoth().build(), { fileName: FILE });
		expect(notes.filter((n) => n.code === 'probable-run-of-river').map((n) => n.element)).toEqual(['Farm A', 'Farm B']);
		expect(project.model.nodes.some((n) => 'supplyRule' in n)).toBe(false);
		expect(notes.some((n) => n.code === 'run-of-river-imported' || n.code === 'run-of-river-kept-dam')).toBe(false);
	});

	it('converts the flagged units, except one an enabled transfer draws on, and changes nothing else', () => {
		const plain = extractProject(flaggedBoth().build(), { fileName: FILE });
		const { project, notes } = extractProject(flaggedBoth().build(), { fileName: FILE, runOfRiver: true });
		const [a, b, outlet] = project.model.nodes;
		expect(a).toEqual(plain.project.model.nodes[0]);
		expect(a).toMatchObject({ damCapacityM3: 0.5 });
		expect(b).toEqual({ ...plain.project.model.nodes[1], damCapacityM3: 0, damInitialPct: 0, supplyRule: 'runOfRiver', pumpCapacityM3Day: null });
		expect(outlet).toEqual(plain.project.model.nodes[2]);
		expect({ ...project, model: { ...project.model, nodes: [] } }).toEqual({ ...plain.project, model: { ...plain.project.model, nodes: [] } });
		// The notes: the default import's, then one warning per flagged unit, in network order, before anything after the transfers.
		const extra = notes.filter((n) => n.code === 'run-of-river-imported' || n.code === 'run-of-river-kept-dam');
		expect(extra.map((n) => [n.code, n.element, n.severity, n.sheet])).toEqual([
			['run-of-river-kept-dam', 'Farm A', 'warning', 'Farm spec'],
			['run-of-river-imported', 'Farm B', 'warning', 'Farm spec']
		]);
		expect(extra[1]!.message).toContain('farm Farm B: imported as run of river (--run-of-river): it has no dam');
		expect(notes.filter((n) => !extra.includes(n))).toEqual(plain.notes);
	});

	it('converts a source whose transfer is switched off, or that only feeds a river off-take', () => {
		// Switched off (a =0 draw formula): no transfer draws on the dam, so the pool goes.
		const off = extractProject(flaggedBoth().set('Transfers', 'O8', '=0').build(), { fileName: FILE, runOfRiver: true }).project;
		expect(off.model.transfers[0]).toMatchObject({ enabled: false });
		expect(off.model.nodes[0]).toMatchObject({ damCapacityM3: 0, supplyRule: 'runOfRiver' });
		// Into Farm B with no crops and no dam: a river off-take, which draws on the river, not the source's dam.
		const offtake = flaggedBoth().set('Farm demand', 'H26', 0);
		const { project, notes } = extractProject(offtake.build(), { fileName: FILE, runOfRiver: true });
		expect(project.model.transfers[0]).toMatchObject({ source: 'river', enabled: true });
		expect(project.model.nodes[0]).toMatchObject({ damCapacityM3: 0, damInitialPct: 0, supplyRule: 'runOfRiver', pumpCapacityM3Day: null });
		expect(notes.filter((n) => n.code === 'run-of-river-imported').map((n) => n.element)).toEqual(['Farm A', 'Farm B']);
		expect(notes.some((n) => n.code === 'run-of-river-kept-dam')).toBe(false);
	});
});

function catchError(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	throw new Error('expected an error');
}
