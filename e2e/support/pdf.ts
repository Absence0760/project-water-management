// A printed PDF's text, one string per page, read with poppler's pdftotext
// (CI installs poppler-utils; locally a spec that needs it says why it skips).
// The bytes reach pdftotext on its stdin, never through a file: a PDF fetched
// from the packs bucket is network data, and writing it to disk would let it
// land anywhere a path pointed (CodeQL js/http-to-file-access).
import { execFileSync } from 'node:child_process';

export const hasPdftotext = (() => {
	try {
		execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

/** The largest PDF a spec reads (a report or pack is a few MB at most). */
const MAX_PDF_BYTES = 64 * 1024 * 1024;

/** Each page's text with its whitespace collapsed (pdftotext splits pages on form feeds and wraps the footer). */
export function pdfPageTexts(pdf: Uint8Array): string[] {
	if (pdf.byteLength > MAX_PDF_BYTES) throw new Error(`pdfPageTexts: ${pdf.byteLength} bytes is over the ${MAX_PDF_BYTES}-byte limit`);
	if (Buffer.from(pdf.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('pdfPageTexts: the bytes are not a PDF');
	return execFileSync('pdftotext', ['-layout', '-', '-'], { input: pdf, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
		.split('\f')
		.filter((t) => t.trim())
		.map((t) => t.replace(/\s+/g, ' '));
}
