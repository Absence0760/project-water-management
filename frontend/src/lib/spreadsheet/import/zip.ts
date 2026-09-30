// The import's zip reader: the engine's defensive, streaming ZipArchive
// (packages/engine/src/zip/read.ts, moved there on its third caller, issue
// #71), opened with the import's own errors, so every refusal is a typed
// WorkbookImportError worded for someone picking a workbook: an
// UnreadableWorkbookError with its reason, or a WorkbookTooLargeError
// ('unpacked') for a zip bomb or an oversized part.
import {
	inflateRaw as inflateRawWith,
	ZIP_DETAIL_NOT_ZIP,
	ZIP_DETAIL_OLE,
	ZipArchive as EngineZipArchive,
	type ZipErrors,
	type ZipLimits
} from '@water-management/engine/zip';
import { UnreadableWorkbookError, WorkbookTooLargeError } from './errors';

export { storedZip, ZIP_LIMITS, type StoredEntry, type ZipEntryInfo, type ZipLimits } from '@water-management/engine/zip';

/** The engine reader's details, in the import's words where a workbook needs them. */
const WORDING: Record<string, string> = {
	[ZIP_DETAIL_OLE]: "it's password-protected or an old-format .xls file; save it from Excel as .xlsm or .xlsx, without a password",
	[ZIP_DETAIL_NOT_ZIP]: "it isn't an .xlsx or .xlsm file"
};

export const WORKBOOK_ZIP_ERRORS: ZipErrors = {
	unreadable: (reason, detail) => new UnreadableWorkbookError(WORDING[detail] ?? detail, reason),
	tooLarge: (actual, limit) => new WorkbookTooLargeError('unpacked', actual, limit)
};

export type ZipArchive = EngineZipArchive;
/** The engine's ZipArchive, throwing the import's errors. */
export const ZipArchive = {
	open: (file: Blob | Uint8Array<ArrayBuffer>, limits: ZipLimits = {}): Promise<ZipArchive> => EngineZipArchive.open(file, limits, WORKBOOK_ZIP_ERRORS)
};

/** Raw inflate into a buffer of exactly `size` bytes, with the import's errors. */
export const inflateRaw = (packed: Uint8Array<ArrayBuffer>, size: number, name = 'a part'): Promise<Uint8Array> => inflateRawWith(packed, size, name, WORKBOOK_ZIP_ERRORS);
