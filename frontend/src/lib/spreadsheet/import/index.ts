// In-browser b023 workbook import (roadmap WP-1.31): a TypeScript port of
// scripts/wbt-import/extract_project.py and calibration.py, on a streaming
// reader of the workbook's XML (./workbook.ts readWorkbook). Pure parsing,
// no I/O and no DOM, so it runs in a Web Worker. Load it lazily.
//
//   const wb = await readWorkbook(await file.arrayBuffer());
//   const { project, notes, unmapped } = extractProject(wb, { fileName: file.name });
//
// Parity with the Python importer is tested on the committed synthetic
// workbook (scripts/wbt-import/fixtures/) and, when present locally, on the
// real workbooks in ../project-water-management-source/Original/.
export { readWorkbook, MAX_WORKBOOK_BYTES, MAX_WORKBOOK_SHEETS, REQUIRED_NAMES, type ReadOptions } from './workbook';
export type { WorkbookSource } from './source';
export { ZIP_LIMITS } from './zip';
export { extractProject, projectName, type ExtractOptions, type ImportResult, type ImportedSettings, type ProjectFile } from './extract';
export type { ImportedSeries } from './flowData';
export { readNodeCrops, readNodeCropWorkbook, type NodeCrop, type NodeCropSet, type NodeCropWarning, type NodeCropWarningCode, type NodeFarmAreas } from './nodeCrops';
export type { GaugeScaling } from './gauge';
export type { ImportNote, ImportNoteCode, UnmappedCode, UnmappedItem } from './report';
export {
	InvalidImportOptionsError,
	InvalidWorkbookError,
	NotB023WorkbookError,
	UnreadableWorkbookError,
	UnsupportedVersionError,
	WorkbookImportError,
	WorkbookTooLargeError,
	type WorkbookImportErrorCode
} from './errors';
