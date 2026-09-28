// What the b023 parser reads from a workbook, apart from how it was read.
// readWorkbook() (the streaming reader: ./workbookParts.ts, ./sheet.ts,
// ./sharedStrings.ts) produces one; the tests also wrap SheetJS workbooks in
// the same interface (./testWorkbook.ts), so the in-memory test workbooks and
// the SheetJS reference reader that guards parity satisfy it too.

/**
 * One cell as SheetJS's reader handed it to the parser (options: cached
 * values, number formats, no stubs): t is 'n' (number, v a number, z its
 * number format or undefined), 's' (string), 'b' (boolean), 'e' (error, v
 * SheetJS's error code) or, from in-memory test workbooks only, 'd'.
 */
export interface RawCell {
	t: string;
	v?: unknown;
	z?: string;
}

export interface SheetSource {
	/** The last row of the used range, 1-based (SheetJS's !ref; 0 for none). */
	readonly lastRow: number;
	/** The cell at a 1-based column and row; undefined when there's none. */
	cell(col: number, row: number): RawCell | undefined;
	/** Every stored cell's 1-based [column, row] (the parity tests compare readers over them). */
	addresses(): Iterable<[number, number]>;
}

export interface DefinedName {
	name: string;
	/** The reference text ("'Farm spec'!$D$29:$D$33"), entities decoded. */
	ref: string;
	/** True for a sheet-scoped name (localSheetId). */
	local: boolean;
}

export interface WorkbookSource {
	/** Every sheet, in workbook order. */
	readonly sheetNames: readonly string[];
	/** Defined names in workbook order (a later duplicate wins). */
	readonly names: readonly DefinedName[];
	/** The 1904 date system (workbookPr date1904). */
	readonly date1904: boolean;
	/** A sheet's cells, by exact name; undefined when it wasn't read (or doesn't exist). */
	sheet(name: string): SheetSource | undefined;
}
