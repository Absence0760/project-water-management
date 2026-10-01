// The Load crop factors dialog's logic (issue #54 item 1; docs/ui.md §
// Load crop factors): match source crops (the reference library, ./library.ts, or a
// b023 workbook's [Crop demand]) to the project's crops by name, the diff per
// crop, and the demand difference before anything is applied. Pure: the
// dialog applies the accepted changes to the ModelEditor, and the normal save
// (with its reason) saves them.
import { farmIrrigationEfficiency, type CropDef, type ProjectModel } from '@water-management/engine';
import { farmDemands } from './demand';

/** Lower case, no accents or punctuation, a plural "s" dropped ("Pecans" ~ "pecan"; not "-ss", "-us": "Grass", "Citrus"). */
export function nameTokens(name: string): string[] {
	return name
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map((t) => (t.length > 3 && /[^su]s$/.test(t) ? t.slice(0, -1) : t));
}

/**
 * The source crop each project crop matches by name, or null ("keep
 * current"): the same name (ignoring case, accents, punctuation and a plural
 * s), else the one source whose words contain all the crop's words or the
 * other way round ("Lucerne" → "Alfalfa (lucerne), frost areas"). Two or
 * more candidates ("Potatoes" → four plantings) match none: the modeller
 * picks.
 */
export function matchByName(crops: readonly { id: string; name: string }[], sources: readonly { id: string; name: string }[]): Map<string, string | null> {
	const src = sources.map((s) => ({ id: s.id, tokens: nameTokens(s.name) }));
	const out = new Map<string, string | null>();
	for (const c of crops) {
		const t = nameTokens(c.name);
		const key = t.join(' ');
		const exact = key ? src.filter((s) => s.tokens.join(' ') === key) : [];
		const within = (a: string[], b: string[]) => a.length > 0 && a.every((x) => b.includes(x));
		const loose = key && !exact.length ? src.filter((s) => within(t, s.tokens) || within(s.tokens, t)) : [];
		const hit = exact.length === 1 ? exact : loose.length === 1 ? loose : [];
		out.set(c.id, hit[0]?.id ?? null);
	}
	return out;
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * What a source's factors multiply. 'a-pan': Class A pan factors (the
 * reference library's ARC/SABI tables, a b023 workbook's [Crop demand]),
 * what the engine's crop demand (A-pan × factor) expects, so Kp 1.
 * 'fao-et0': FAO-56 Kc values, set against reference ET₀ (a node-based
 * workbook's set), which on A-pan need the pan coefficient Kp (ET₀ ÷ pan).
 */
export type FactorShape = 'a-pan' | 'fao-et0';

/** FAO-56 ch. 3, Table 5: Class A pan Kp by humidity, wind and fetch, 0.35–0.85. */
export const FAO56_TABLE5_URL = 'https://www.fao.org/4/x0490e/x0490e08.htm';

/** The dialog's source kinds, in radio order, each with the shape of its factors. A new kind is a row here. */
export const SOURCE_KINDS = [
	{ id: 'library', label: 'Reference library (ARC/SABI A-pan, winter rainfall)', shape: 'a-pan' },
	{ id: 'b023', label: 'A b023 workbook', shape: 'a-pan' }
] as const satisfies readonly { id: string; label: string; shape: FactorShape }[];
export type SourceKind = (typeof SOURCE_KINDS)[number]['id'];

export const shapeOf = (kind: SourceKind): FactorShape => SOURCE_KINDS.find((k) => k.id === kind)!.shape;

/**
 * The default Kp for a shape: 1 for A-pan factors; 0.75 for FAO-56 Kc, a
 * mid value of FAO-56 Table 5's 0.35–0.85 for a Class A pan (the site's
 * humidity, wind and fetch set the real one).
 */
export function defaultKp(shape: FactorShape): number {
	return shape === 'fao-et0' ? 0.75 : 1;
}

/** Kp is this value (within float dust); a blank Kp is no value. */
export const isKp = (kp: number | null, value: number): boolean => kp !== null && same(kp, value);

/**
 * The Kp after the source's shape changes from one whose default was
 * `previousDefault`: the new shape's default, unless the modeller set their
 * own, a value above 0 other than that previous default, which is kept.
 * A blank or invalid Kp is not their own: it takes the default.
 */
export function kpForShape(current: number | null, previousDefault: number, shape: FactorShape): number {
	const own = current !== null && current > 0 && !isKp(current, previousDefault);
	return own ? current : defaultKp(shape);
}

/** Source factors × the pan coefficient Kp, to 4 decimals (no float dust in the table). */
export function withKp(factors: readonly number[], kp: number): number[] {
	return factors.map((f) => Math.round(f * kp * 10_000) / 10_000);
}

/** What the dialog would set on one project crop: new factors and/or an efficiency (undefined = keep the crop's). */
export interface CropChoice {
	factors: number[] | null;
	efficiency?: number;
}

export interface CropChange {
	cropId: string;
	name: string;
	current: number[];
	next: number[];
	/** Per water-year month: the factor changes. */
	changed: boolean[];
	currentEfficiency: number | null;
	nextEfficiency: number | null;
	/** Anything differs: a factor or the efficiency. */
	differs: boolean;
}

/** The diff for each crop that has a choice, in the crop table's order. */
export function cropChanges(crops: readonly CropDef[], choices: ReadonlyMap<string, CropChoice>): CropChange[] {
	return crops.flatMap((c) => {
		const ch = choices.get(c.id);
		if (!ch || (!ch.factors && ch.efficiency === undefined)) return [];
		const current = Array.from({ length: 12 }, (_v, m) => c.cropFactor[m] ?? 0);
		const next = ch.factors ? [...ch.factors] : current;
		const currentEfficiency = c.irrigationEfficiency ?? null;
		const nextEfficiency = ch.efficiency ?? currentEfficiency;
		const changed = current.map((v, m) => !same(v, next[m]!));
		const effDiffers = nextEfficiency !== currentEfficiency && !(nextEfficiency !== null && currentEfficiency !== null && same(nextEfficiency, currentEfficiency));
		return [{ cropId: c.id, name: c.name, current, next, changed, currentEfficiency, nextEfficiency, differs: changed.some(Boolean) || effDiffers }];
	});
}

/** The crops with the accepted changes applied (new objects for the changed crops; the rest as they were). */
export function applyChanges(crops: readonly CropDef[], accepted: readonly CropChange[]): CropDef[] {
	const by = new Map(accepted.map((a) => [a.cropId, a]));
	return crops.map((c) => {
		const a = by.get(c.id);
		if (!a) return c;
		const out: CropDef = { ...c, cropFactor: [...a.next] };
		if (a.nextEfficiency !== null) out.irrigationEfficiency = a.nextEfficiency;
		return out;
	});
}

export interface DemandRow {
	nodeId: string;
	name: string;
	/** Mean gross crop requirement, m³/day (before rain): now and with the changes. */
	gross: [number, number];
	/** Mean gross ÷ the farm's irrigation efficiency (its crops' blend, as a run uses it), m³/day: now and with the changes. */
	abstraction: [number, number];
}

export interface DemandDifference {
	rows: DemandRow[];
	total: { gross: [number, number]; abstraction: [number, number] };
	/** Catchment gross requirement per water-year month, m³/day: now and with the changes. */
	monthly: [number[], number[]];
}

/**
 * The gross irrigation demand now and with `nextCrops`, per farm and for the
 * catchment, with the engine's own maths (grossFarmDemandM3PerDay through
 * ./demand.ts farmDemands, and farmIrrigationEfficiency), so it is what a
 * run would use before effective rain.
 */
export function demandDifference(
	model: ProjectModel,
	nextCrops: CropDef[],
	apanMm: readonly number[],
	februaryDays: number,
	farmIds: string[]
): DemandDifference {
	const next: ProjectModel = { ...model, crops: nextCrops };
	const both = [model, next].map((m) => farmDemands(m, apanMm, februaryDays, farmIds));
	const eff = (m: ProjectModel, nodeId: string) => {
		const node = m.nodes.find((n) => n.id === nodeId);
		// A non-farm with crop areas abstracts its requirement (e = 1), as the run's irrigation() has it; a value outside (0, 1] runs as 1.
		if (node?.kind !== 'farm') return 1;
		const e = node.irrigationEfficiency;
		const own = e > 0 && e <= 1 ? e : 1;
		const areas = new Map<string, number>();
		for (const a of m.cropAreas) if (a.nodeId === nodeId) areas.set(a.cropId, (areas.get(a.cropId) ?? 0) + a.areaM2);
		return farmIrrigationEfficiency(own, m.crops, areas, apanMm);
	};
	const rows = farmIds.map((id, i): DemandRow => {
		const g: [number, number] = [both[0]![i]!.meanM3Day, both[1]![i]!.meanM3Day];
		return {
			nodeId: id,
			name: model.nodes.find((n) => n.id === id)?.name || '(unnamed)',
			gross: g,
			abstraction: [g[0] / eff(model, id), g[1] / eff(next, id)]
		};
	});
	const sum = (k: 'gross' | 'abstraction', j: 0 | 1) => rows.reduce((s, r) => s + r[k][j], 0);
	const monthly = both.map((d) => Array.from({ length: 12 }, (_v, m) => d.reduce((s, f) => s + (f.monthlyM3Day[m] ?? 0), 0))) as [number[], number[]];
	return { rows, total: { gross: [sum('gross', 0), sum('gross', 1)], abstraction: [sum('abstraction', 0), sum('abstraction', 1)] }, monthly };
}

/** "−28 %", "+4 %", "±0 %", or "–" when there was nothing before. */
export function pctChange([now, next]: readonly [number, number]): string {
	if (!(now > 0)) return next > 0 ? 'new' : '–';
	const p = Math.round(((next - now) / now) * 100);
	return p === 0 ? '±0 %' : `${p > 0 ? '+' : '−'}${Math.abs(p)} %`;
}
