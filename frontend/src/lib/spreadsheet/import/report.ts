// What the importer tells the user besides the project itself: notes (the
// Python importer's `note:` / `WARNING:` lines, same text, with a code and a
// location) and the unmapped report (plan.md 1b: what it couldn't carry
// across as the workbook meant). Workbooks are hand-made and have mistakes;
// the importer surfaces them and never corrects a value on its own.
import { type Cell, cellAddress, isNumeric, num, pyRepr, pyStr } from './cells';

/**
 * Codes of the notes extract_project.py prints. `message` is the Python
 * note's text exactly (the parity test compares it), so both importers can
 * be checked against each other line by line.
 */
export type ImportNoteCode =
	/** [Farm spec] fragmentation method isn't Area, Hi/Lo or Specific; area is used. */
	| 'unknown-flow-share-method'
	/** [Farm spec] Upstream inflow above dam % stored as 1 − the value (b023's formula applied it below the dam, docs/model.md §3 Q1). */
	| 'upstream-pct-converted'
	/** [Farm spec] Upstream inflow above dam % imported as entered: the workbook's formula is the fixed one. */
	| 'upstream-pct-as-entered'
	/** A transfer month list relied on the workbook's substring match (audit M1). */
	| 'transfer-months-substring'
	/** More than one element has nothing downstream; only the outflow gauge is the outlet. */
	| 'several-outlets'
	/** A [Network] farm has no [Farm spec] row. */
	| 'farm-missing-from-spec'
	/** The [Farm spec] min dam % is the transfer minimum, not a minimum operating level (audit Q5). */
	| 'dam-min-is-transfer-minimum'
	/** WARNING: a farm's dam looks like b023's dummy dam for a unit that pumps from the river (issue #54, 2d). */
	| 'probable-run-of-river'
	/** WARNING: a near-empty dam that takes less than all the upstream inflow, probably a placeholder (issue #90 Q18). */
	| 'placeholder-pool'
	/** WARNING: a transfer whose draw formula is the constant 0 is imported switched off (issue #54). */
	| 'transfer-switched-off'
	| 'transfer-river-offtake'
	/** WARNING: with the run-of-river option, a flagged unit imported as run of river, with no dam and an uncapped pump (issue #54, 2c/2d). */
	| 'run-of-river-imported'
	/** WARNING: with the run-of-river option, a flagged unit kept as a farm dam because an enabled transfer draws on it. */
	| 'run-of-river-kept-dam'
	/** The run covers [Home]'s calculation window, not all of [Flow data] (issue #54). */
	| 'model-window'
	/** Dams have no surface area in the workbook; runs estimate it (audit N2). */
	| 'dam-area-unknown'
	/** WARNING: a [Crop demand] row has the same 12 factors as another crop's (a copied row; issue #289). */
	| 'crop-factors-copied'
	/** WARNING: a [Crop demand] row has a negative factor, a lone 0, a lone spike or dip, or a factor above 1.0 (issue #289). */
	| 'crop-factors-suspect'
	/** A [Farm demand] farm isn't in [Network]. */
	| 'farm-demand-unknown-farm'
	/** A [Farm demand] crop isn't in [Crop demand]. */
	| 'farm-demand-unknown-crop'
	/** WARNING: a farm's [Farm demand] gross demand doesn't follow from its crop areas (typed over, or a crop skipped; issue #54). */
	| 'farm-demand-gross-mismatch'
	/** A transfer names an element that isn't in [Network]; skipped. */
	| 'transfer-unknown-element'
	/** Runs of zero catchment rain that look like missing data (issue #2). */
	| 'zero-rain-runs'
	/** duplicateLogger: the logger column copies the gauge column, so it is left out (issue #54). */
	| 'duplicate-logger'
	/** gaugeAsReference: the gauge column was imported as a reference gauge. */
	| 'gauge-as-reference'
	/** gaugeAsReference, but the workbook has no gauge values. */
	| 'gauge-as-reference-no-gauge'
	/** WARNING: rUseFlow pointed at the gauge the user said is another river. */
	| 'gauge-as-reference-calibration-unset'
	/** The Pitman flow column had values; never imported (audit P1). */
	| 'pitman-not-imported'
	/** WARNING: rUseFlow calibrates against Pitman flow, which the app doesn't support. */
	| 'pitman-calibration-unset'
	/** rUseFlow picks a series with no values. */
	| 'calibration-flow-missing';

export interface ImportNote {
	code: ImportNoteCode;
	/** 'warning' for the Python's `WARNING: ` lines (it prints those to stderr). */
	severity: 'info' | 'warning';
	/** The Python importer's text, without the `note: ` prefix (a `WARNING: ` prefix is kept). */
	message: string;
	/** The workbook sheet the note is about, when there is one. */
	sheet?: string;
	/** A1 address on that sheet, when the note is about one cell. */
	cell?: string;
	/** The network element (farm or gauge) or transfer the note is about. */
	element?: string;
}

/**
 * Things in the workbook the importer could not map onto the app's model as
 * the workbook meant them. The Python importer drops these silently or
 * doesn't look (it never reads formulas); the TypeScript one lists them so
 * the user can check each against the workbook before relying on a run.
 */
export type UnmappedCode =
	/** A [Transfers] InOut formula that isn't "+ draws into this farm − draws out of it". */
	| 'transfer-inout-formula'
	/** A farm that sends or receives a transfer has no InOut column, so the workbook never moved that water. */
	| 'transfer-inout-missing'
	/** The same farm heads two InOut columns; the workbook uses the first. */
	| 'transfer-inout-duplicate'
	/** A draw-from-dam formula that doesn't read the source farm's storage (column Q) with its own column's settings. */
	| 'transfer-draw-formula'
	/** zTransfers_FormulasAsTxt is missing, so the transfer formulas couldn't be checked. */
	| 'transfer-formulas-unchecked'
	/** A draw-from-dam column with a max rate but no destination farm; the Python importer skips it silently. */
	| 'transfer-no-destination'
	/** A draw-from-dam column with a destination but no max rate (0 or blank); skipped. */
	| 'transfer-zero-rate'
	/** A transfer month list the workbook's substring match reads differently (audit M1; also a note). */
	| 'transfer-months-substring'
	/** Specific (manual) flow shares are selected but a farm's share is blank; imported as 0. */
	| 'flow-share-missing'
	/** A [Network] element type other than Farm or Gauge; imported as a farm. */
	| 'element-type-unknown'
	/** A [Farm spec] farm that isn't in [Network]; ignored. */
	| 'farm-spec-unknown-farm'
	/** A number cell holding text or an error; imported as 0 (or the setting's default). */
	| 'non-numeric-value'
	/** [Flow data] cells in an imported series holding text, an error or a date; imported as blank. */
	| 'non-numeric-series-values';

export interface UnmappedItem {
	code: UnmappedCode;
	message: string;
	sheet?: string;
	cell?: string;
	element?: string;
	/** The formula or cell text the item is about, verbatim (render as text, never as HTML). */
	text?: string;
}

/** Collects notes and unmapped items in the order the Python importer would print its notes. */
export class Report {
	readonly notes: ImportNote[] = [];
	readonly unmapped: UnmappedItem[] = [];

	note(code: ImportNoteCode, message: string, where: Omit<ImportNote, 'code' | 'message' | 'severity'> = {}): void {
		this.notes.push({ code, severity: message.startsWith('WARNING: ') ? 'warning' : 'info', message, ...where });
	}

	unmap(item: UnmappedItem): void {
		this.unmapped.push(item);
	}

	/**
	 * num() of a cell the importer reads as a number, listing the cell as
	 * unmapped when it holds text or an error that num() replaces with
	 * `fallback` (a blank is a plain 0, as in Excel, and isn't listed).
	 */
	num(v: Cell, at: { sheet: string; col: number; row: number; what: string; element?: string }, fallback = 0): number {
		if (v !== null && v !== '' && !isNumeric(v)) {
			const cell = cellAddress(at.col, at.row);
			this.unmap({
				code: 'non-numeric-value',
				message: `[${at.sheet}] ${at.what}${at.element ? ` for ${at.element}` : ''} (${cell}) holds ${pyRepr(v)}, not a number; imported as ${pyStr(fallback)}`,
				sheet: at.sheet,
				cell,
				...(at.element ? { element: at.element } : {}),
				text: pyStr(v)
			});
		}
		return num(v, fallback);
	}
}
