// The workbook's zip writer now lives in the engine (packages/engine/src/zip,
// issue #71), shared with the evidence pack's reproduction bundle. Re-exported
// here so the export keeps its import path.
export { crc32, deflateRaw, zip, type ZipEntry } from '@water-management/engine/zip';
