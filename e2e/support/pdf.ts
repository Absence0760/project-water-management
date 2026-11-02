// A printed PDF's text, one string per page, read with poppler's pdftotext
// (CI installs poppler-utils; locally a spec that needs it says why it skips).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const hasPdftotext = (() => {
	try {
		execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

/** Each page's text with its whitespace collapsed (pdftotext splits pages on form feeds and wraps the footer). */
export function pdfPageTexts(pdf: Uint8Array, path: string): string[] {
	writeFileSync(path, pdf);
	return execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
		.split('\f')
		.filter((t) => t.trim())
		.map((t) => t.replace(/\s+/g, ' '));
}
