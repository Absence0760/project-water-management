// Import plantings (issue #477): the list's reader, the matcher (farms and
// crops by name, case and spacing aside), what it creates, and the apply.
// Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import { newNetworkNode, type CropDef, type NetworkNode, type ProjectModel } from '@water-management/engine';
import { formatPlain } from '$lib/components/common/formatHelp';
import {
	applyPlantingsImport,
	PLANTING_HEADINGS,
	PLANTINGS_EXAMPLE,
	PLANTINGS_FORMAT,
	PLANTINGS_MAX_LINES,
	planPlantingsImport,
	plantingsCsv,
	type PlantingsEditor,
	type PlantingsPlan
} from './plantingsImport';

type Model = Pick<ProjectModel, 'nodes' | 'crops' | 'cropAreas' | 'irrigationSystems'>;

const node = (id: string, name: string, kind: NetworkNode['kind'], down: string | null): NetworkNode => ({ ...newNetworkNode(id, 1, down), name, kind });
const crop = (id: string, name: string, irrigationSystemId: string | null = 'drip'): CropDef => ({ id, name, cropFactor: new Array(12).fill(0.5), irrigationSystemId });

function model(over: Partial<Model> = {}): Model {
	return {
		nodes: [node('g', 'Outflow gauge', 'gauge', null), node('u', 'Upper farm', 'farm', 'g'), node('l', 'Lower farm', 'farm', 'g'), node('t', 'Town', 'user', 'g')],
		crops: [crop('c', 'Citrus', 'micro'), crop('m', 'Maize')],
		cropAreas: [
			{ nodeId: 'u', cropId: 'c', areaM2: 300_000 },
			{ nodeId: 'l', cropId: 'm', areaM2: 100_000 }
		],
		...over
	};
}

const plan = (r: ReturnType<typeof planPlantingsImport>): PlantingsPlan => {
	if ('error' in r) throw new Error(r.error);
	return r;
};
const err = (r: ReturnType<typeof planPlantingsImport>) => ('error' in r ? r.error : null);

/** An editor that records what it is asked, as ModelEditor would do it. */
function recorder() {
	const calls = { crops: [] as [string, string | null][], units: [] as string[], set: [] as Parameters<PlantingsEditor['setPlantings']>[0][] };
	const ed: PlantingsEditor = {
		addCrop: (name, sys) => (calls.crops.push([name, sys]), `crop-${calls.crops.length}`),
		addUnit: (name) => (calls.units.push(name), `unit-${calls.units.length}`),
		setPlantings: (list) => void calls.set.push(list)
	};
	return { ed, calls };
}

describe('the Expected format and its template', () => {
	it('the example and the downloadable template read through the parser (the template is the example as a file)', () => {
		expect(PLANTINGS_FORMAT.files![0]!.text).toBe(PLANTINGS_EXAMPLE);
		expect(PLANTINGS_FORMAT.example).toBe(PLANTINGS_EXAMPLE.trimEnd().replace(/\r\n/g, '\n'));
		for (const text of [PLANTINGS_EXAMPLE, PLANTINGS_FORMAT.example!, '﻿' + PLANTINGS_EXAMPLE]) {
			const p = plan(planPlantingsImport(text, model(), { createFarms: true }));
			expect(p.errors).toEqual([]);
			expect(p.lines).toBe(5);
			// Upper and Lower farm match, Middle farm is new; Citrus and Maize match, Lucerne and Wine grapes are new.
			expect(p.newFarms.map((f) => f.name)).toEqual(['Middle farm']);
			expect(p.newCrops.map((c) => c.name)).toEqual(['Lucerne', 'Wine grapes']);
			expect(p.changes.map((c) => [c.farmName, c.cropName, c.fromHa, c.toHa])).toEqual([
				['Upper farm', 'Maize', null, 12.5],
				['Lower farm', 'Citrus', null, 18],
				['Lower farm', 'Lucerne', null, 40],
				['Middle farm', 'Wine grapes', null, 22.75]
			]);
			// Upper farm's 30 ha of citrus on micro-sprinkler, the crop's default, is already so.
			expect(p.unchanged).toBe(1);
		}
	});

	it('names every heading the parser takes, in its rules', () => {
		const words = PLANTINGS_FORMAT.rules.map(formatPlain).join(' ');
		for (const h of ['Farm', 'Crop', 'Area (ha)', 'Irrigation system', 'Hydrological unit', 'Crop type', 'Hectares']) expect(words).toContain(h);
		// Each alternative heading in the rules reads as its column.
		for (const [col, hs] of Object.entries(PLANTING_HEADINGS))
			for (const h of hs) {
				const text = `${col === 'farm' ? h : 'Farm'},${col === 'crop' ? h : 'Crop'},${col === 'area' ? h : 'Area'}\nUpper farm,Citrus,30\n`;
				expect(err(planPlantingsImport(text, model())), `${col}: ${h}`).toBeNull();
			}
	});
});

describe('planPlantingsImport', () => {
	it('matches farms and crops by name, capitals and spacing aside, and keeps the project’s names', () => {
		const p = plan(planPlantingsImport('farm , CROP , area (HA)\n  UPPER   farm ,maize, 7\nlower FARM,  Citrus ,2', model()));
		expect(p.changes.map((c) => [c.nodeKey, c.farmName, c.cropKey, c.cropName, c.toHa])).toEqual([
			['u', 'Upper farm', 'm', 'Maize', 7],
			['l', 'Lower farm', 'c', 'Citrus', 2]
		]);
		expect(p.newCrops).toEqual([]);
		expect(p.newFarms).toEqual([]);
	});

	it('reads the columns in any order, notes the ones it leaves out, and reads a semicolon list with decimal commas', () => {
		const p = plan(planPlantingsImport('Area (ha);Notes;Crop;Farm\n2,5;north block;Maize;Upper farm\n', model()));
		expect(p.changes.map((c) => c.toHa)).toEqual([2.5]);
		expect(p.notes).toContain('Left out a column the list doesn’t use: Notes.');
		expect(p.notes.some((n) => /decimal points/.test(n))).toBe(true);
		// Tab-separated, as a spreadsheet copies it.
		expect(plan(planPlantingsImport('Farm\tCrop\tHectares\nUpper farm\tMaize\t3', model())).changes[0]!.toHa).toBe(3);
	});

	it('refuses a list without its heading row, or with areas in another unit', () => {
		expect(err(planPlantingsImport('Upper farm,Citrus,30', model()))).toMatch(/^The first row must be the heading row, with Farm, Crop, Area \(ha\) columns/);
		expect(err(planPlantingsImport('Farm,Crop\nUpper farm,Citrus', model()))).toMatch(/with Area \(ha\) column \(it has Farm, Crop\)/);
		expect(err(planPlantingsImport('Farm,Crop,Area (m²)\nUpper farm,Citrus,30', model()))).toMatch(/^Areas are read in hectares, but the heading “Area \(m²\)” says m²/);
		expect(err(planPlantingsImport('Farm,Crop,Area,Hectares\nUpper farm,Citrus,30,30', model()))).toMatch(/two Area \(ha\) columns/);
		expect(err(planPlantingsImport('Farm,Crop,Area\n', model()))).toBe('There are no rows under the heading row.');
		expect(err(planPlantingsImport(' \n# a note\n', model()))).toBe('Paste the rows or load a file first.');
	});

	it('lists every row it can’t read by its line in the file (blank and # lines counted), and applies the rest', () => {
		const text = [
			'Farm,Crop,Area (ha),Irrigation system', // 1
			'# exported from the scheme’s register', // 2
			',Citrus,3', // 3
			'Upper farm,,3', // 4
			'', // 5
			'Upper farm,Citrus,', // 6
			'Upper farm,Citrus,lots', // 7
			'Upper farm,Citrus,-2', // 8
			'Upper farm,Citrus,4,Laser', // 9
			'Outflow gauge,Citrus,4', // 10
			'Town,Citrus,4', // 11
			'Lower farm,Citrus,4 ha' // 12
		].join('\n');
		const p = plan(planPlantingsImport(text, model()));
		expect(p.errors.map((e) => e.line)).toEqual([3, 4, 6, 7, 8, 9, 10, 11]);
		expect(p.errors.find((e) => e.line === 7)!.message).toBe('Upper farm, Citrus: “lots” isn’t a number of hectares.');
		expect(p.errors.find((e) => e.line === 9)!.message).toMatch(/^Upper farm, Citrus: “Laser” isn’t one of the project’s irrigation systems \(Drip, Micro-sprinkler/);
		expect(p.errors.find((e) => e.line === 10)!.message).toBe('Outflow gauge is a gauge: crops are planted on hydrological units.');
		expect(p.errors.find((e) => e.line === 11)!.message).toBe('Town is an other water user: crops are planted on hydrological units.');
		expect(p.changes.map((c) => [c.farmName, c.toHa, c.lines])).toEqual([['Lower farm', 4, [12]]]);
		expect(p.lines).toBe(9);
	});

	it('adds the areas of a farm and crop listed twice, and refuses two systems for one planting', () => {
		const p = plan(planPlantingsImport('Farm,Crop,Area,System\nLower farm,Lucerne,10,Centre pivot\nLower farm,lucerne,5.5,\nLower farm,Lucerne,1,Drip', model()));
		expect(p.changes.map((c) => [c.cropName, c.toHa, c.lines])).toEqual([['Lucerne', 15.5, [2, 3]]]);
		expect(p.notes).toContain('Listed more than once, their areas added: Lower farm, Lucerne.');
		expect(p.errors).toEqual([{ line: 4, message: 'Lower farm, Lucerne: line 2 gives it Centre pivot / linear move, this line Drip. A crop has one system on a unit.' }]);
	});

	it('names a system by its name, its picker label or its short name; the crop’s own default is no own system', () => {
		const p = plan(planPlantingsImport('Farm,Crop,Area,System\nUpper farm,Citrus,30,drip, 90 %\nLower farm,Maize,10,DRIP\nLower farm,Citrus,3,centre pivot', model()));
		// The CSV comma in "drip, 90 %" splits the cell; quoted it is one.
		expect(p.errors.length).toBe(0);
		const q = plan(planPlantingsImport('Farm,Crop,Area,System\nUpper farm,Citrus,30,"Drip, 90 %"\nLower farm,Maize,10,DRIP\nLower farm,Citrus,3,centre pivot', model()));
		expect(q.changes.map((c) => [c.farmName, c.cropName, c.ownSystem, c.systemText])).toEqual([
			['Upper farm', 'Citrus', 'drip', 'Drip, 90 %'],
			['Lower farm', 'Citrus', 'pivot', 'Centre pivot / linear move, 85 %']
		]);
		// Lower farm's maize: 10 ha on drip, the crop's default, as it is now.
		expect(q.unchanged).toBe(1);
	});

	it('0 clears a planting; a planting the list doesn’t name keeps its area', () => {
		const p = plan(planPlantingsImport('Farm,Crop,Area\nUpper farm,Citrus,0\nUpper farm,Maize,0', model()));
		expect(p.changes.map((c) => [c.farmName, c.cropName, c.fromHa, c.toHa])).toEqual([['Upper farm', 'Citrus', 30, 0]]);
		expect(p.unchanged).toBe(1);
		const { ed, calls } = recorder();
		applyPlantingsImport(p, ed);
		expect(calls.set).toEqual([[{ nodeId: 'u', cropId: 'c', areaM2: 0 }]]);
	});

	it('lists farms the project doesn’t have and leaves their rows out unless asked to add them', () => {
		const text = 'Farm,Crop,Area\nNew farm,Citrus,5\nnew  FARM,Sorghum,2\nUpper farm,Sorghum,1';
		const left = plan(planPlantingsImport(text, model()));
		expect(left.newFarms).toEqual([{ key: 'new-farm:0', name: 'New farm', lines: [2, 3] }]);
		expect(left.createFarms).toBe(false);
		expect(left.changes.map((c) => c.farmName)).toEqual(['Upper farm']);
		// Sorghum is still new (Upper farm plants it); the left-out farm's rows add nothing.
		expect(left.newCrops.map((c) => [c.name, c.lines])).toEqual([['Sorghum', [4]]]);

		const made = plan(planPlantingsImport(text, model(), { createFarms: true }));
		expect(made.createFarms).toBe(true);
		expect(made.changes.map((c) => [c.nodeKey, c.cropKey, c.toHa])).toEqual([
			['new-farm:0', 'c', 5],
			['new-farm:0', 'new-crop:0', 2],
			['u', 'new-crop:0', 1]
		]);
	});

	it('can’t add farms to a network without an outlet, and says so', () => {
		const m = model({ nodes: [node('u', 'Upper farm', 'farm', 'x')] });
		const p = plan(planPlantingsImport('Farm,Crop,Area\nNew farm,Citrus,5', m, { createFarms: true }));
		expect(p.createFarms).toBe(false);
		expect(p.cannotCreate).toMatch(/no outlet/);
		expect(p.changes).toEqual([]);
	});

	it('a new crop takes the system every row of it names as its default, else drip', () => {
		const p = plan(planPlantingsImport('Farm,Crop,Area,System\nUpper farm,Pecans,5,Micro-sprinkler\nLower farm,Pecans,2,micro-sprinkler\nUpper farm,Onions,1,Drip\nLower farm,Onions,1,Flood / furrow\nUpper farm,Peas,1,', model()));
		expect(p.newCrops.map((c) => [c.name, c.systemId])).toEqual([
			['Pecans', 'micro'],
			['Onions', null],
			['Peas', null]
		]);
		// Pecans' plantings follow their crop; Onions on drip is the new-crop default, so only Flood / furrow is the unit's own.
		expect(p.changes.map((c) => [c.farmName, c.cropName, c.ownSystem])).toEqual([
			['Upper farm', 'Pecans', null],
			['Lower farm', 'Pecans', null],
			['Upper farm', 'Onions', null],
			['Lower farm', 'Onions', 'surface'],
			['Upper farm', 'Peas', undefined]
		]);
	});

	it('refuses an ambiguous name rather than guess', () => {
		const m = model({ crops: [crop('c', 'Citrus'), crop('c2', ' citrus ')] });
		const p = plan(planPlantingsImport('Farm,Crop,Area\nUpper farm,Citrus,1', m));
		expect(p.errors).toEqual([{ line: 2, message: 'Citrus: two crops have that name; rename one first.' }]);
	});

	it('refuses more rows than it reads at a time', () => {
		const rows = Array.from({ length: PLANTINGS_MAX_LINES + 1 }, (_, i) => `Farm ${i},Citrus,1`);
		expect(err(planPlantingsImport(['Farm,Crop,Area', ...rows].join('\n'), model()))).toMatch(/at most 5000 are read at a time/);
	});

	it('reads a scheme’s thousands of rows in one pass', () => {
		const farms = Array.from({ length: 400 }, (_, i) => node(`f${i}`, `Farm ${i}`, 'farm', 'g'));
		const m = model({ nodes: [node('g', 'Outflow gauge', 'gauge', null), ...farms], cropAreas: [] });
		const rows = farms.flatMap((f, i) => [`${f.name},Citrus,${i + 1}`, `${f.name},Crop ${i % 50},2`, `${f.name},Maize,0.5`]);
		const p = plan(planPlantingsImport(['Farm,Crop,Area', ...rows].join('\n'), m));
		expect(p.errors).toEqual([]);
		expect(p.changes.length).toBe(1200);
		expect(p.newCrops.length).toBe(50);
		const { ed, calls } = recorder();
		const done = applyPlantingsImport(p, ed);
		expect(done).toEqual({ crops: p.newCrops.map((c) => c.name), units: [], areas: 1200 });
		// One bulk edit, not one a row.
		expect(calls.set.length).toBe(1);
		expect(calls.set[0]!.length).toBe(1200);
	});
});

describe('applyPlantingsImport', () => {
	it('adds the new crops and units first, then sets every area in m² and the units’ own systems in one edit', () => {
		const p = plan(
			planPlantingsImport('Farm,Crop,Area,System\nNew farm,Sorghum,2.5,Centre pivot\nUpper farm,Sorghum,1,\nUpper farm,Citrus,3,Drip\nNowhere,Okra,1', model(), { createFarms: true })
		);
		const { ed, calls } = recorder();
		const done = applyPlantingsImport(p, ed);
		expect(calls.crops).toEqual([
			['Sorghum', null],
			['Okra', null]
		]);
		expect(calls.units).toEqual(['New farm', 'Nowhere']);
		expect(calls.set).toEqual([
			[
				{ nodeId: 'unit-1', cropId: 'crop-1', areaM2: 25_000, systemId: 'pivot' },
				{ nodeId: 'u', cropId: 'crop-1', areaM2: 10_000 },
				{ nodeId: 'u', cropId: 'c', areaM2: 30_000, systemId: 'drip' },
				{ nodeId: 'unit-2', cropId: 'crop-2', areaM2: 10_000 }
			]
		]);
		expect(done).toEqual({ crops: ['Sorghum', 'Okra'], units: ['New farm', 'Nowhere'], areas: 4 });
	});

	it('adds no crop that only a left-out farm plants, and skips a unit the editor couldn’t add', () => {
		const left = plan(planPlantingsImport('Farm,Crop,Area\nNew farm,Okra,1\nUpper farm,Maize,2', model()));
		const a = recorder();
		expect(applyPlantingsImport(left, a.ed)).toEqual({ crops: [], units: [], areas: 1 });
		expect(a.calls.crops).toEqual([]);

		const made = plan(planPlantingsImport('Farm,Crop,Area\nNew farm,Okra,1\nUpper farm,Maize,2', model(), { createFarms: true }));
		const b = recorder();
		b.ed.addUnit = () => null;
		expect(applyPlantingsImport(made, b.ed)).toEqual({ crops: ['Okra'], units: [], areas: 1 });
		expect(b.calls.set[0]!.map((s) => s.nodeId)).toEqual(['u']);
	});
});

describe('plantingsCsv', () => {
	it('writes the project’s plantings as the list, which reads back unchanged', () => {
		const m = model({ cropAreas: [...model().cropAreas, { nodeId: 'u', cropId: 'm', areaM2: 25_000, irrigationSystemId: 'pivot' }] });
		const csv = plantingsCsv(m);
		expect(csv.split('\r\n').slice(0, 4)).toEqual(['Farm,Crop,Area (ha),Irrigation system', 'Upper farm,Citrus,30,Micro-sprinkler', 'Upper farm,Maize,2.5,Centre pivot / linear move', 'Lower farm,Maize,10,Drip']);
		const p = plan(planPlantingsImport(csv, m));
		expect(p.changes).toEqual([]);
		expect(p.errors).toEqual([]);
		expect(p.unchanged).toBe(3);
	});
});
