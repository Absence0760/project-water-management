// Which section of a reading page is being read, for an "On this page" list
// that marks it (a guide's rail). The glossary keeps its own two-level spy.

/**
 * The index of the section being read: the last one whose heading's top
 * (`tops`, px from the top of the window, in page order) has passed `line`.
 * At the end of a page that scrolled, the last section, since a short last
 * section never reaches the line. -1 while the reader is still above the
 * first heading (the intro).
 */
export function currentSection(tops: readonly number[], line: number, atEnd: boolean): number {
	if (!tops.length) return -1;
	if (atEnd) return tops.length - 1;
	let current = -1;
	for (let i = 0; i < tops.length; i++) {
		if (tops[i]! <= line) current = i;
		else break;
	}
	return current;
}
