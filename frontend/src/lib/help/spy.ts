// Which section of a reading page is being read, for an "On this page" list
// that marks it (a guide's rail, a glossary topic's rail).

/**
 * The index of the section being read: the last one whose heading's top
 * (`tops`, px from the top of the window, in page order) has passed `line`.
 * At the end of a page that scrolled, the last section, since a short last
 * section never reaches the line. -1 while the reader is still above the
 * first heading (the intro).
 *
 * At the end, a section the reader just jumped to (`linked`, the index the
 * URL's #hash names, -1 for none) stays marked while its heading is still on
 * screen (top within 0..`viewH`): a link to one of the last few sections of a
 * short page lands at the end, and marking the last one would contradict it.
 */
export function currentSection(
	tops: readonly number[],
	line: number,
	atEnd: boolean,
	linked = -1,
	viewH = Infinity,
): number {
	if (!tops.length) return -1;
	if (atEnd) {
		const t = tops[linked];
		return t !== undefined && t >= 0 && t < viewH ? linked : tops.length - 1;
	}
	let current = -1;
	for (let i = 0; i < tops.length; i++) {
		if (tops[i]! <= line) current = i;
		else break;
	}
	return current;
}
