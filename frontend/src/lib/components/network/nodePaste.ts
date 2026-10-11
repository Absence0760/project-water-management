// The node table's paste from a spreadsheet (issue #285): what a pasted block
// would change, the change itself, and the table as a CSV to fill in. The
// block is read by $lib/spreadsheet/paste (shared with the Reserve rule
// tables); this file says what each column means: a % is entered 0–100 and
// stored 0–1, River to dam in m³/s and stored in m³/day, and a field a node
// doesn't use is left out.
import type { NetworkNode } from '@water-management/engine';
import { mapPaste, sameValue, toCsv, type GridColumn, type GridFormat, type PasteAnchor, type PastePlan } from '$lib/spreadsheet/paste/grid';
import { cardLabel, fieldScale, fieldUnused, isPct, setNodeField, TABLE_FIELDS, type NodeField, type NodeNumberKey } from './fields';
import { divertMonthsCell } from './supply';

/** Headings the node table's name column goes by. */
const NAME_HEADINGS = ['Name', 'Node', 'Hydrological unit'];

/** The CSV heading of a field: "Dam capacity (m³)". */
const heading = (f: NodeField) => `${cardLabel(f)} (${f.unit})`;

/** The value columns, in the table's order: each matches its card label ("Dam capacity") or its column label ("Capacity"). */
/** The columns a paste can write: a derived field (the efficiency, from the crops' systems) is shown, never pasted. */
const PASTE_FIELDS = TABLE_FIELDS.filter((f) => !f.derived);
export const NODE_PASTE_COLUMNS: GridColumn[] = PASTE_FIELDS.map((f) => ({ key: f.key, labels: [cardLabel(f), f.label] }));

/**
 * The paste's notes with a derived field's column (the efficiency, worked out
 * from the crops' irrigation systems, engine ≥ 1.72.0) said for what it is: the
 * table shows it, so "a column the table doesn't have" would be wrong.
 */
function derivedNotes(notes: readonly string[]): string[] {
	const derived = TABLE_FIELDS.filter((f) => f.derived);
	const isDerived = (heading: string) => {
		const h = heading.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
		return derived.find((f) => h === cardLabel(f).toLowerCase() || h === f.label.toLowerCase());
	};
	const out: string[] = [];
	const said = new Set<string>();
	for (const n of notes) {
		const m = /^Left out (?:a column|columns) the table doesn't have: (.*)\.$/.exec(n);
		if (!m) {
			out.push(n);
			continue;
		}
		const cols = m[1]!.split(', ');
		const rest = cols.filter((c) => !isDerived(c));
		for (const c of cols) {
			const f = isDerived(c);
			if (f && !said.has(f.key)) {
				said.add(f.key);
				out.push(`Left out ${c}: it comes from each unit's crops' irrigation systems, set on Crops & demand.`);
			}
		}
		if (rest.length) out.push(`Left out ${rest.length === 1 ? 'a column' : 'columns'} the table doesn't have: ${rest.join(', ')}.`);
	}
	return out;
}

/** Why a field of this node takes no pasted value, or null when it does. */
function notUsed(n: NetworkNode, f: NodeField): string | null {
	if (n.kind === 'user') return 'an other water user';
	if (f.farmOnly && n.kind !== 'farm') return 'a gauge';
	if (f.key === 'divertCapacityM3Day' && divertMonthsCell(n, n.name)) return 'set by month';
	if (fieldUnused(f, n)) return 'a dam on the river';
	return null;
}

/** Float noise trimmed (9 decimals), as the table's inputs show and store a scaled value. */
const round9 = (v: number) => Math.round(v * 1e9) / 1e9;

/** A node's field as the table shows it (0–100 for a %, m³/s for River to dam), null when empty. */
function shown(n: NetworkNode, f: NodeField): number | null {
	const v = (n as unknown as Record<NodeNumberKey, number | null | undefined>)[f.key];
	if (v === null || v === undefined) return null;
	return round9(v * fieldScale(f));
}

/**
 * What pasting `text` into the node table would change. Rows match by name
 * (or by position from `anchor`), columns by heading (or by position); see
 * mapPaste. Values below 0, or a % above 100, stop the paste; values for a
 * field the node doesn't use (a gauge's dam, River to dam set by month) are
 * left out with a note.
 */
export function planNodePaste(text: string, nodes: readonly NetworkNode[], anchor?: PasteAnchor | null): PastePlan | { error: string } {
	const mapped = mapPaste(text, nodes, NODE_PASTE_COLUMNS, { anchor, nameHeadings: NAME_HEADINGS });
	if ('error' in mapped) return mapped;
	const plan: PastePlan = { changes: [], unchanged: 0, notes: derivedNotes(mapped.notes) };
	const skipped: string[] = [];
	for (const v of mapped.values) {
		const n = nodes.find((x) => x.id === v.rowId)!;
		const f = TABLE_FIELDS.find((x) => x.key === v.key)!;
		const name = n.name || '(unnamed)';
		const why = notUsed(n, f);
		if (why) {
			skipped.push(`${name} ${cardLabel(f).toLowerCase()} (${why})`);
			continue;
		}
		if (v.value < 0) return { error: `${name}, ${cardLabel(f)}: ${v.value} is below 0.` };
		if (isPct(f) && v.value > 100) return { error: `${name}, ${cardLabel(f)}: ${v.value} % is above 100 %.` };
		const from = shown(n, f);
		if (sameValue(from, v.value)) plan.unchanged++;
		else plan.changes.push({ rowId: n.id, rowName: name, key: f.key, column: cardLabel(f), unit: f.unit, from, to: v.value });
	}
	if (skipped.length) plan.notes.push(`Left out values for fields these hydrological units don't use: ${skipped.join('; ')}.`);
	return plan;
}

/** Write a plan's changes into the nodes (the editor's model: Save keeps them, Discard drops them). */
export function applyNodePaste(nodes: NetworkNode[], plan: PastePlan): void {
	for (const c of plan.changes) {
		const n = nodes.find((x) => x.id === c.rowId);
		const f = TABLE_FIELDS.find((x) => x.key === c.key);
		if (n && f) setNodeField(n, f.key, round9(c.to / fieldScale(f)));
	}
}

/**
 * The node table as a CSV, to fill in and paste back: the name, then each
 * column of the table with its unit, a % as 0–100, River to dam in m³/s. A field the node doesn't
 * use is blank (a blank leaves a value as it is).
 */
export function nodeTableCsv(nodes: readonly NetworkNode[]): string {
	return toCsv([
		[NAME_HEADINGS[0]!, ...PASTE_FIELDS.map(heading)],
		...nodes.map((n) => [n.name, ...PASTE_FIELDS.map((f) => (notUsed(n, f) ? null : shown(n, f)))])
	]);
}

/** The hydrological unit table's Expected format (issue #477): its headings, with an example of a few columns. */
export const NODE_TABLE_FORMAT: GridFormat = (() => {
	const h = (key: string) => heading(PASTE_FIELDS.find((f) => f.key === key)!);
	return {
		id: 'hydrological-unit-table',
		title: 'Hydrological unit table',
		where: 'Network → Tables → Hydrological unit table → Paste from a spreadsheet',
		rules: [
			`A heading row: ${NAME_HEADINGS[0]}, then any of the table's columns as the CSV below names them, in any order; a column you leave out keeps its values.`,
			'A row per hydrological unit, its name first: a name the table doesn’t have is left out (add a unit with + Add hydrological unit first).',
			'A % is 0–100. A blank or a dash leaves a cell as it is.'
		],
		example: toCsv([
			[NAME_HEADINGS[0]!, h('areaKm2'), h('damCapacityM3'), h('pctRunoffToDam')],
			['Upper farm', 12.5, 150000, 80],
			['Lower farm', 8, 60000, 50]
		]),
		exampleName: 'hydrological-unit-table-example.csv'
	};
})();
