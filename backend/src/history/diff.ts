// Pure helpers for the change history (030_history.sql): which nodes a model
// change touched, and what a series change did day by day. No I/O.
import { fromEpochDay, toEpochDay, type ProjectModel } from '@water-management/engine';

/** What a node is, as far as a change to it goes: its own row, crop areas, land cover, boreholes, demand objects and transfers at either end. */
function nodeFacts(m: ProjectModel | null | undefined): Map<string, string> {
	const facts = new Map<string, unknown[]>();
	const add = (id: string, x: unknown) => {
		const list = facts.get(id) ?? [];
		list.push(x);
		facts.set(id, list);
	};
	for (const n of m?.nodes ?? []) add(n.id, ['node', n]);
	for (const a of m?.cropAreas ?? []) if (a.areaM2 > 0) add(a.nodeId, ['area', a.cropId, a.areaM2]);
	for (const p of m?.landCover ?? []) add(p.nodeId, ['cover', p]);
	for (const b of m?.boreholes ?? []) add(b.nodeId, ['borehole', b]);
	for (const o of m?.demandObjects ?? []) add(o.nodeId, ['demandObject', o]);
	for (const t of m?.transfers ?? []) {
		add(t.fromNodeId, ['transfer', t]);
		add(t.toNodeId, ['transfer', t]);
	}
	// Order-insensitive: crop areas and patches come back from the database in any order.
	return new Map([...facts].map(([id, list]) => [id, list.map((x) => stableJson(x)).sort().join('\n')]));
}

/** JSON with object keys sorted, so two equal documents serialise the same whatever their key order. */
export function stableJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(v ?? null);
}

/**
 * The ids of the nodes whose facts differ between two models (added,
 * removed or changed), sorted. A crop's factor changing touches no node: it
 * is the crop's change, and the History tab's farm filter is about farms.
 */
export function touchedNodeIds(a: ProjectModel | null | undefined, b: ProjectModel | null | undefined): string[] {
	const fa = nodeFacts(a);
	const fb = nodeFacts(b);
	const ids = new Set([...fa.keys(), ...fb.keys()]);
	return [...ids].filter((id) => fa.get(id) !== fb.get(id)).sort();
}

export interface Daily {
	startDate: string;
	values: readonly (number | null)[];
}

export interface SeriesChangeSummary {
	/** First and last day of the new values ('YYYY-MM-DD'); null when the series is empty or gone. */
	from: string | null;
	to: string | null;
	/** Days whose value differs between before and after, over both ranges (a day outside a range is "no reading"). */
	daysChanged: number;
}

/** What a replace, merge, delete or restore did to a series' days. */
export function seriesChange(before: Daily | null, after: Daily | null): SeriesChangeSummary {
	const at = (s: Daily | null) => {
		const m = new Map<number, number | null>();
		if (!s) return m;
		const d0 = toEpochDay(s.startDate);
		s.values.forEach((v, i) => m.set(d0 + i, v));
		return m;
	};
	const a = at(before);
	const b = at(after);
	let daysChanged = 0;
	for (const d of new Set([...a.keys(), ...b.keys()])) {
		// A day outside a series' range reads as "no reading", like a null inside it.
		if ((a.get(d) ?? null) !== (b.get(d) ?? null)) daysChanged++;
	}
	const range = after && after.values.length ? [after.startDate, fromEpochDay(toEpochDay(after.startDate) + after.values.length - 1)] : [null, null];
	return { from: range[0]!, to: range[1]!, daysChanged };
}
