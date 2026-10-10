// Planted areas from a list (issue #477): a CSV file or a spreadsheet paste
// with a row per planting, `Farm, Crop, Area (ha)` and optionally
// `Irrigation system`, for a catchment's hundreds of records. Farms are
// matched to hydrological units by name and crops to crop types by name,
// ignoring case and spacing. A crop the project doesn't have is added as a new
// crop type (its factors 0 until filled in); a farm the project doesn't have
// is listed, and added as a new hydrological unit only when asked
// (`createFarms`): it drains into the outlet with no catchment area, dam or
// connections, for the user to place on the Network page. docs/ui.md §
// Import plantings says why. The plan is shown in a preview
// (ImportPlantingsDialog) and applied through the model editor, unsaved,
// like any other edit. Pure: tested in plantingsImport.test.ts.
import { NEW_FARM_IRRIGATION_SYSTEM, type ProjectModel } from '@water-management/engine';
import type { FileFormat } from '$lib/components/common/formatHelp';
import { systemLabel, systemsOf } from '$lib/model/systems';
import { headingKeys, normalName, toCsv } from '$lib/spreadsheet/paste/grid';
import { blockCommas, DECIMAL_COMMA_NOTE, GROUPING_COMMA_NOTE, numberReader, readPastedBlock, splitCsvRow } from '$lib/spreadsheet/paste/read';

const M2_PER_HA = 10_000;
/** The most data lines a list may have (a large scheme's plantings fit many times over). */
export const PLANTINGS_MAX_LINES = 5000;
/** The largest file the box reads. */
export const PLANTINGS_MAX_BYTES = 2 * 1024 * 1024;
/** The longest name a node or crop may have (the API's limit). */
const NAME_MAX = 100;

type Column = 'farm' | 'crop' | 'area' | 'system';
/** The headings each column goes by (matched like a grid's: case, spacing and a unit in brackets aside). */
export const PLANTING_HEADINGS: Record<Column, readonly string[]> = {
	farm: ['Farm', 'Farm name', 'Hydrological unit', 'Node'],
	crop: ['Crop', 'Crop type', 'Crop name'],
	area: ['Area', 'Planted area', 'Irrigated area', 'Hectares', 'Ha'],
	system: ['Irrigation system', 'System', 'Irrigation']
};
const COLUMN_NAME: Record<Column, string> = { farm: 'Farm', crop: 'Crop', area: 'Area (ha)', system: 'Irrigation system' };
const HEADING_OF = new Map<string, Column>(
	(Object.entries(PLANTING_HEADINGS) as [Column, readonly string[]][]).flatMap(([col, hs]) => hs.map((h) => [normalName(h), col] as const))
);
/** Units an area heading may name in its brackets: hectares only. */
const HA_UNITS = new Set(['ha', 'hectares', 'hectare']);

type Model = Pick<ProjectModel, 'nodes' | 'crops' | 'cropAreas' | 'irrigationSystems'>;

/** One farm-crop pair the list sets. */
export interface PlantingChange {
	/** The unit's id, or `new-farm:<n>` for a unit the plan adds (PlantingsPlan.newFarms[n]). */
	nodeKey: string;
	farmName: string;
	/** The crop's id, or `new-crop:<n>` for a crop the plan adds (PlantingsPlan.newCrops[n]). */
	cropKey: string;
	cropName: string;
	/** Hectares now; null when not planted. */
	fromHa: number | null;
	toHa: number;
	/**
	 * The unit's own irrigation system for the crop as the list names it: an
	 * id, null for the crop's default (the list names the crop's own system),
	 * or undefined when the list names none (left as it is).
	 */
	ownSystem?: string | null;
	/** The system's words for the preview ("Drip, 90 %"), when the list names one. */
	systemText?: string;
	/** The list's lines for this pair (more than one when a pair is listed twice and its areas are added). */
	lines: number[];
}

/** A crop or unit the plan adds. */
export interface NewItem {
	key: string;
	name: string;
	lines: number[];
}

export interface PlantingsPlan {
	/** Data lines read (blank and # lines aside). */
	lines: number;
	changes: PlantingChange[];
	/** Pairs the list gives as they already are. */
	unchanged: number;
	/** Crops the list names that the project doesn't have: added as crop types with factors of 0. */
	newCrops: (NewItem & { /** The system every line of it names, made the new crop's default; null when none or they differ. */ systemId: string | null })[];
	/** Units the list names that the project doesn't have: added only with `createFarms`, else their lines are left out. */
	newFarms: NewItem[];
	/** Whether the plan adds `newFarms` (asked for, and the network has an outlet to drain them into). */
	createFarms: boolean;
	/** Why units can't be added (no outlet), when the list names some. */
	cannotCreate: string | null;
	/** Lines left out, each with why; the rest still apply. */
	errors: { line: number; message: string }[];
	/** How the list was read: columns left out, pairs listed twice, decimal commas. */
	notes: string[];
}

export interface PlanOptions {
	/** Add the units the list names that the project doesn't have (default: list them, leave their lines out). */
	createFarms?: boolean;
}

type Separator = ReturnType<typeof readPastedBlock>['separator'];
const splitLine = (l: string, sep: Separator): string[] =>
	(sep === 'tab' ? l.split('\t') : sep === 'semicolon' ? l.split(';') : sep === 'comma' ? splitCsvRow(l) : [l]).map((c) => c.trim());

/** Push to a Map of lists. */
function addTo<K, V>(m: Map<K, V[]>, k: K, v: V) {
	const l = m.get(k);
	if (l) l.push(v);
	else m.set(k, [v]);
}

const KIND_WORD: Record<string, string> = { gauge: 'a gauge', user: 'an other water user' };

/** What importing `text` (a CSV file's text, or cells pasted from a spreadsheet) into `model` would do. */
export function planPlantingsImport(text: string, model: Model, opts: PlanOptions = {}): PlantingsPlan | { error: string } {
	const raw = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
	const numbered = raw.map((l, i) => ({ n: i + 1, l })).filter((x) => x.l.trim() && !x.l.trimStart().startsWith('#'));
	if (!numbered.length) return { error: 'Paste the rows or load a file first.' };
	if (numbered.length - 1 > PLANTINGS_MAX_LINES) return { error: `The list has ${numbered.length - 1} rows; at most ${PLANTINGS_MAX_LINES} are read at a time. Split it into parts.` };
	const sep = readPastedBlock(numbered.map((x) => x.l).join('\n')).separator;

	// --- the heading row ---
	const head = splitLine(numbered[0]!.l, sep);
	const at: Partial<Record<Column, number>> = {};
	const left: string[] = [];
	for (const [j, h] of head.entries()) {
		if (!h) continue;
		const keys = headingKeys(h);
		const col = keys.map((k) => HEADING_OF.get(k)).find((c) => c !== undefined);
		if (!col) {
			left.push(h);
			continue;
		}
		if (at[col] !== undefined) return { error: `The heading row has two ${COLUMN_NAME[col]} columns (${head[at[col]!]} and ${h}).` };
		if (col === 'area') {
			const unit = /\(([^()]*)\)\s*$/.exec(h)?.[1]?.trim().toLowerCase();
			if (unit && !HA_UNITS.has(unit) && !HEADING_OF.has(normalName(h)))
				return { error: `Areas are read in hectares, but the heading “${h}” says ${unit}. Convert the column to hectares (1 ha = 10 000 m²) and head it Area (ha).` };
		}
		at[col] = j;
	}
	const missing = (['farm', 'crop', 'area'] as const).filter((c) => at[c] === undefined);
	if (missing.length)
		return {
			error: `The first row must be the heading row, with ${missing.map((c) => COLUMN_NAME[c]).join(', ')} column${missing.length === 1 ? '' : 's'} (it has ${head.filter(Boolean).join(', ') || 'none'}). Download the template for the layout.`
		};
	const data = numbered.slice(1);
	if (!data.length) return { error: 'There are no rows under the heading row.' };
	const cell = (cells: string[], c: Column) => (at[c] === undefined ? '' : (cells[at[c]!] ?? ''));

	// --- the numbers: a comma between digits is decided once for the area column, as a grid paste does ---
	const rows = data.map((x) => ({ n: x.n, cells: splitLine(x.l, sep) }));
	const commas = blockCommas(rows.map((r) => cell(r.cells, 'area')));
	if (typeof commas !== 'string' && 'mixed' in commas)
		return { error: `The areas have both a decimal comma (${commas.mixed[0]}) and thousands separators (${commas.mixed[1]}): use one or the other.` };
	if (typeof commas !== 'string') return { error: `Is the area “${commas.ambiguous}” ${commas.ambiguous.replace(/,/g, ' ')} ha or ${commas.ambiguous.replace(',', '.')} ha? Remove the separator or write the decimal with a point.` };
	const reader = numberReader(commas);

	// --- what the project has, by name ---
	const nodesByName = new Map<string, Model['nodes']>();
	for (const n of model.nodes) addTo(nodesByName, normalName(n.name), n);
	const cropsByName = new Map<string, Model['crops']>();
	for (const c of model.crops) addTo(cropsByName, normalName(c.name), c);
	const systems = systemsOf(model);
	const systemByName = new Map<string, (typeof systems)[number][]>();
	// By its name, as a picker offers it ("Drip, 90 %"), its name before a slash ("Centre pivot" for Centre pivot / linear move) or a SABI preset's key ("micro").
	for (const s of systems)
		for (const k of new Set([s.name, systemLabel(s), s.name.split(' / ')[0]!, s.preset ?? ''].map(normalName).filter(Boolean))) addTo(systemByName, k, s);
	const areaOf = new Map(model.cropAreas.map((a) => [`${a.nodeId}|${a.cropId}`, a]));
	const outlet = model.nodes.some((n) => n.downstreamNodeId === null);
	const canCreate = outlet;
	const createFarms = !!opts.createFarms && canCreate;
	// A new crop starts on drip, as + Add crop does (ModelEditor.addCrop).
	const newCropDefault = (systems.find((s) => s.preset === NEW_FARM_IRRIGATION_SYSTEM) ?? systems[0])?.id ?? null;

	const errors: { line: number; message: string }[] = [];
	const newCrops = new Map<string, PlantingsPlan['newCrops'][number] & { systems: Set<string | null> }>();
	const newFarms = new Map<string, NewItem>();
	type Pair = { nodeKey: string; farmName: string; cropKey: string; cropName: string; ha: number; system: (typeof systems)[number] | null; lines: number[] };
	const pairs = new Map<string, Pair>();
	const twice: string[] = [];

	for (const { n, cells } of rows) {
		const farm = cell(cells, 'farm');
		const crop = cell(cells, 'crop');
		const areaCell = cell(cells, 'area');
		const sysCell = cell(cells, 'system');
		const fail = (message: string) => errors.push({ line: n, message });
		if (!farm) {
			fail('no farm name.');
			continue;
		}
		if (!crop) {
			fail(`${farm}: no crop.`);
			continue;
		}
		if (!areaCell) {
			fail(`${farm}, ${crop}: no area (0 clears a planting).`);
			continue;
		}
		const ha = reader.read(areaCell.replace(/\s*ha$/i, ''));
		if (!Number.isFinite(ha)) {
			fail(`${farm}, ${crop}: “${areaCell}” isn’t a number of hectares.`);
			continue;
		}
		if (ha < 0) {
			fail(`${farm}, ${crop}: ${areaCell} ha is below 0.`);
			continue;
		}
		let system: (typeof systems)[number] | null = null;
		if (sysCell) {
			const hits = systemByName.get(normalName(sysCell)) ?? [];
			if (hits.length !== 1) {
				fail(
					hits.length
						? `${farm}, ${crop}: two irrigation systems are called “${sysCell}”; rename one on Crops & demand → Irrigation systems.`
						: `${farm}, ${crop}: “${sysCell}” isn’t one of the project’s irrigation systems (${systems.map((s) => s.name).join(', ')}). Add it under Irrigation systems first, or leave the cell blank.`
				);
				continue;
			}
			system = hits[0]!;
		}

		// The unit.
		const fk = normalName(farm);
		const nodes = nodesByName.get(fk) ?? [];
		let nodeKey: string;
		let farmName: string;
		if (nodes.length > 1) {
			fail(`${farm}: two network nodes have that name; rename one on the Network page.`);
			continue;
		} else if (nodes.length === 1) {
			const node = nodes[0]!;
			if (node.kind !== 'farm') {
				fail(`${farm} is ${KIND_WORD[node.kind] ?? 'not a hydrological unit'}: crops are planted on hydrological units.`);
				continue;
			}
			nodeKey = node.id;
			farmName = node.name;
		} else {
			if (farm.length > NAME_MAX) {
				fail(`${farm.slice(0, 40)}…: a unit’s name is at most ${NAME_MAX} characters.`);
				continue;
			}
			let item = newFarms.get(fk);
			if (!item) {
				item = { key: `new-farm:${newFarms.size}`, name: farm, lines: [] };
				newFarms.set(fk, item);
			}
			item.lines.push(n);
			if (!createFarms) continue;
			nodeKey = item.key;
			farmName = item.name;
		}

		// The crop.
		const ck = normalName(crop);
		const crops = cropsByName.get(ck) ?? [];
		let cropKey: string;
		let cropName: string;
		if (crops.length > 1) {
			fail(`${crop}: two crops have that name; rename one first.`);
			continue;
		} else if (crops.length === 1) {
			cropKey = crops[0]!.id;
			cropName = crops[0]!.name;
		} else {
			if (crop.length > NAME_MAX) {
				fail(`${crop.slice(0, 40)}…: a crop’s name is at most ${NAME_MAX} characters.`);
				continue;
			}
			let item = newCrops.get(ck);
			if (!item) {
				item = { key: `new-crop:${newCrops.size}`, name: crop, lines: [], systemId: null, systems: new Set() };
				newCrops.set(ck, item);
			}
			item.lines.push(n);
			item.systems.add(system?.id ?? null);
			cropKey = item.key;
			cropName = item.name;
		}

		// The pair: listed twice, its areas are added (a farm's fields of one crop on two lines).
		const pk = `${nodeKey}|${cropKey}`;
		const seen = pairs.get(pk);
		if (seen) {
			if (system && seen.system && system.id !== seen.system.id) {
				fail(`${farmName}, ${cropName}: line ${seen.lines[0]} gives it ${seen.system.name}, this line ${system.name}. A crop has one system on a unit.`);
				continue;
			}
			seen.ha += ha;
			seen.system ??= system;
			seen.lines.push(n);
			if (seen.lines.length === 2) twice.push(`${farmName}, ${cropName}`);
		} else pairs.set(pk, { nodeKey, farmName, cropKey, cropName, ha, system, lines: [n] });
	}

	// --- each pair against the model ---
	const cropDefault = new Map(model.crops.map((c) => [c.id, c.irrigationSystemId ?? null]));
	const newCropList = [...newCrops.values()].map(({ systems: s, ...item }) => ({ ...item, systemId: s.size === 1 ? [...s][0]! : null }));
	for (const c of newCropList) cropDefault.set(c.key, c.systemId ?? newCropDefault);
	const changes: PlantingChange[] = [];
	let unchanged = 0;
	for (const p of pairs.values()) {
		const now = areaOf.get(`${p.nodeKey}|${p.cropKey}`);
		const fromHa = now && now.areaM2 > 0 ? now.areaM2 / M2_PER_HA : null;
		const toHa = Math.round(p.ha * 1e6) / 1e6;
		// The list's system as the unit's own: none when it is the crop's default (the planting follows the crop).
		const own = p.system ? (p.system.id === cropDefault.get(p.cropKey) ? null : p.system.id) : undefined;
		const sameArea = fromHa === null ? toHa === 0 : Math.abs(fromHa - toHa) <= 1e-9 * Math.max(1, toHa);
		const sameSystem = own === undefined || toHa === 0 || (now?.irrigationSystemId ?? null) === own;
		if (sameArea && sameSystem) {
			unchanged++;
			continue;
		}
		changes.push({
			nodeKey: p.nodeKey,
			farmName: p.farmName,
			cropKey: p.cropKey,
			cropName: p.cropName,
			fromHa,
			toHa,
			...(own === undefined ? {} : { ownSystem: own, systemText: systemLabel(p.system!) }),
			lines: p.lines
		});
	}

	const notes: string[] = [];
	if (left.length) notes.push(`Left out ${left.length === 1 ? 'a column' : 'columns'} the list doesn’t use: ${left.join(', ')}.`);
	if (twice.length) notes.push(`Listed more than once, their areas added: ${twice.slice(0, 5).join('; ')}${twice.length > 5 ? ` and ${twice.length - 5} more` : ''}.`);
	if (reader.sawComma) notes.push(commas === 'grouping' ? GROUPING_COMMA_NOTE : DECIMAL_COMMA_NOTE);
	return {
		lines: rows.length,
		changes,
		unchanged,
		newCrops: newCropList,
		newFarms: [...newFarms.values()],
		createFarms: createFarms && newFarms.size > 0,
		cannotCreate: newFarms.size && !canCreate ? 'The network has no outlet to drain new units into: add the outlet gauge on the Network page first.' : null,
		errors,
		notes
	};
}

/** What applying a plan does to the model, through the editor (ModelEditor's methods; ImportPlantingsDialog). */
export interface PlantingsEditor {
	/** Add a crop type of this name with factors of 0 on `systemId` (null: the new-crop default); its id. */
	addCrop(name: string, systemId: string | null): string;
	/** Add a hydrological unit of this name, draining into the outlet; its id, or null without an outlet. */
	addUnit(name: string): string | null;
	/** Set many farm × crop areas at once (ModelEditor.setPlantings: 0 removes; `systemId` undefined keeps the unit's own system). */
	setPlantings(list: { nodeId: string; cropId: string; areaM2: number; systemId?: string | null }[]): void;
}

/** What an apply did: crop types and units added, with their names, and the planted areas set. */
export interface PlantingsApplied {
	crops: string[];
	units: string[];
	areas: number;
}

/** Apply a plan: its new crops and (with `createFarms`) units first, then every area and system it changes, in one edit. */
export function applyPlantingsImport(plan: PlantingsPlan, ed: PlantingsEditor): PlantingsApplied {
	const ids = new Map<string, string>();
	// Only the crops a change uses: a new crop listed only on a unit left out isn't added.
	const used = new Set(plan.changes.map((c) => c.cropKey));
	const crops: string[] = [];
	for (const c of plan.newCrops)
		if (used.has(c.key)) {
			ids.set(c.key, ed.addCrop(c.name, c.systemId));
			crops.push(c.name);
		}
	const units: string[] = [];
	if (plan.createFarms)
		for (const f of plan.newFarms) {
			const id = ed.addUnit(f.name);
			if (id === null) continue;
			ids.set(f.key, id);
			units.push(f.name);
		}
	const list: Parameters<PlantingsEditor['setPlantings']>[0] = [];
	for (const c of plan.changes) {
		const node = c.nodeKey.startsWith('new-farm:') ? ids.get(c.nodeKey) : c.nodeKey;
		const crop = c.cropKey.startsWith('new-crop:') ? ids.get(c.cropKey) : c.cropKey;
		if (!node || !crop) continue;
		list.push({
			nodeId: node,
			cropId: crop,
			areaM2: Math.round(c.toHa * M2_PER_HA * 1e6) / 1e6,
			...(c.ownSystem !== undefined && c.toHa > 0 ? { systemId: c.ownSystem } : {})
		});
	}
	ed.setPlantings(list);
	return { crops, units, areas: list.length };
}

/** The project's plantings as the list: a row per planting, to edit and load back (or to start from). */
export function plantingsCsv(model: Model): string {
	const node = new Map(model.nodes.map((n) => [n.id, n]));
	const crop = new Map(model.crops.map((c) => [c.id, c]));
	const systems = systemsOf(model);
	const sys = (id: string | null | undefined) => (id ? (systems.find((s) => s.id === id)?.name ?? '') : '');
	const nodeOrder = new Map(model.nodes.map((n, i) => [n.id, i]));
	const cropOrder = new Map(model.crops.map((c, i) => [c.id, i]));
	const rows = model.cropAreas
		.filter((a) => a.areaM2 > 0 && node.has(a.nodeId) && crop.has(a.cropId))
		.sort((a, b) => nodeOrder.get(a.nodeId)! - nodeOrder.get(b.nodeId)! || cropOrder.get(a.cropId)! - cropOrder.get(b.cropId)!)
		.map((a) => [node.get(a.nodeId)!.name, crop.get(a.cropId)!.name, a.areaM2 / M2_PER_HA, sys(a.irrigationSystemId ?? crop.get(a.cropId)!.irrigationSystemId)]);
	return toCsv([[COLUMN_NAME.farm, COLUMN_NAME.crop, COLUMN_NAME.area, COLUMN_NAME.system], ...rows]);
}

/** The example and template (invented names and values). */
export const PLANTINGS_EXAMPLE = toCsv([
	[COLUMN_NAME.farm, COLUMN_NAME.crop, COLUMN_NAME.area, COLUMN_NAME.system],
	['Upper farm', 'Citrus', 30, 'Micro-sprinkler'],
	['Upper farm', 'Maize', 12.5, ''],
	['Lower farm', 'Citrus', 18, 'Drip'],
	['Lower farm', 'Lucerne', 40, 'Centre pivot'],
	['Middle farm', 'Wine grapes', 22.75, '']
]);

/** The Import plantings box's Expected format (issue #477). */
export const PLANTINGS_FORMAT: FileFormat = {
	id: 'plantings',
	title: 'Planted areas, a row per planting',
	where: 'Crops & demand → Import plantings',
	accepts: `A CSV file (.csv, comma- or semicolon-separated), tab-separated (.tsv) or text (.txt), in UTF-8, at most 2 MB and ${PLANTINGS_MAX_LINES.toLocaleString('en-US').replace(',', ' ')} rows; or the rows copied from a spreadsheet and pasted. An Excel workbook isn’t read: save the sheet as CSV (UTF-8) first.`,
	lead: 'A heading row, then one row per farm and crop: the farm, the crop and its planted area.',
	rules: [
		`Headings, in any order: \`${COLUMN_NAME.farm}\` (or Hydrological unit), \`${COLUMN_NAME.crop}\` (or Crop type) and \`${COLUMN_NAME.area}\` (or Area, Hectares), and optionally \`${COLUMN_NAME.system}\`. Other columns are left out, and the preview names them.`,
		'**Farm**: a hydrological unit’s name as the Network page has it; capitals and spaces don’t matter. A name the project doesn’t have is listed; tick *Add the units the project doesn’t have* to add each as a new hydrological unit, which drains into the outlet with no catchment area until you place it on the Network page. Otherwise its rows are left out.',
		'**Crop**: a crop type’s name; capitals and spaces don’t matter. A name the project doesn’t have adds that crop type, on drip, with crop factors of 0: fill its factors (Edit, or Load crop factors) before a run, or it needs no water.',
		'**Area (ha)**: hectares, 0 or more. 0 clears a planting. A farm and crop listed twice have their areas added. A farm and crop the list doesn’t name keep their area.',
		'**Irrigation system** (optional): one of the project’s systems by name (Drip, Micro-sprinkler, Centre pivot …), for that crop on that farm; blank keeps it as it is. A name the project doesn’t have is a problem on that row: add the system under Irrigation systems first.',
		'Decimals with a point (12.5), or a comma (12,5) in a semicolon- or tab-separated list. Lines starting with # are skipped.',
		'Nothing changes until Apply. The preview counts what matched, what is added and changed, and lists every row it can’t read by its line number; those rows are left out and the rest apply. Then save the model, as after any edit.'
	],
	example: PLANTINGS_EXAMPLE.trimEnd().replace(/\r\n/g, '\n'),
	files: [{ name: 'plantings-template.csv', text: PLANTINGS_EXAMPLE, label: 'Download the template' }]
};
