// Typed failures of the workbook import, so the UI can say what went wrong
// without parsing message text. `message` is plain text for the user; render
// it as text (it can quote sheet and farm names from the file).

export type WorkbookImportErrorCode = 'unreadable' | 'too-large' | 'not-b023' | 'unsupported-version' | 'invalid-workbook' | 'invalid-options';

export class WorkbookImportError extends Error {
	constructor(
		readonly code: WorkbookImportErrorCode,
		message: string
	) {
		super(message);
		this.name = 'WorkbookImportError';
	}
}

/**
 * Why a file couldn't be opened: not a zip at all (or an old .xls or a
 * password-protected file), an encrypted or ZIP64 archive, a zip compression
 * method other than stored or deflate, a damaged container, or a part the
 * reader needs that is malformed (not well-formed XML, a DTD, a dangling
 * shared-string reference).
 */
export type UnreadableReason = 'not-zip' | 'encrypted' | 'zip64' | 'method' | 'corrupt' | 'not-workbook';

/** The file isn't a spreadsheet the importer can open (not a zip, encrypted, truncated …). */
export class UnreadableWorkbookError extends WorkbookImportError {
	constructor(
		readonly detail: string,
		readonly reason: UnreadableReason = 'not-workbook'
	) {
		super('unreadable', `The file couldn't be read as an Excel workbook (${detail}).`);
	}
}

/**
 * Over a limit readWorkbook() enforces: the file size or sheet count before
 * parsing, or the unpacked size of the parts it reads (a zip bomb, or a sheet
 * far beyond any real workbook's).
 */
export class WorkbookTooLargeError extends WorkbookImportError {
	constructor(
		readonly what: 'bytes' | 'sheets' | 'unpacked',
		readonly actual: number,
		readonly limit: number
	) {
		super(
			'too-large',
			what === 'bytes'
				? `The file is ${Math.ceil(actual / 1e6)} MB; the limit is ${limit / 1e6} MB.`
				: what === 'sheets'
					? `The workbook has ${actual} sheets; the limit is ${limit}.`
					: `The parts of the workbook the importer reads unpack to more than ${Math.floor(limit / 1e6)} MB, its limit.`
		);
	}
}

/** The workbook lacks named ranges every b023 Water Balance Tool workbook has. */
export class NotB023WorkbookError extends WorkbookImportError {
	constructor(readonly missing: string[]) {
		super(
			'not-b023',
			`This isn't a b023 Water Balance Tool workbook: it has no named range${missing.length === 1 ? '' : 's'} ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`
		);
	}
}

/** A Water Balance Tool workbook of a code build the importer doesn't read (zAppVer isn't b02x). */
export class UnsupportedVersionError extends WorkbookImportError {
	constructor(readonly version: string) {
		super('unsupported-version', `This workbook is Water Balance Tool build ${version}; the importer reads the b02x builds (b022, b023 …).`);
	}
}

/**
 * The workbook has the b023 layout but something in it stops the import: the
 * cases where extract_project.py raises (a table header it can't find,
 * non-consecutive dates, an upstream element that doesn't exist …).
 */
export class InvalidWorkbookError extends WorkbookImportError {
	constructor(
		message: string,
		readonly sheet?: string,
		readonly cell?: string
	) {
		super('invalid-workbook', message);
	}
}

/** Import options that don't go together (the Python CLI rejects the same combinations). */
export class InvalidImportOptionsError extends WorkbookImportError {
	constructor(message: string) {
		super('invalid-options', message);
	}
}
