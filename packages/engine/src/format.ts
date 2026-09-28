// The app's one thousands separator (D10, issue #76): a narrow no-break space
// (U+202F), as SI and South African practice write 300 000, with '.' as the
// decimal point. No-break, so a figure never wraps across two lines. Every
// grouped figure the app shows goes through this: the workspace's fmtNum, the
// farm view's numbers and the engine's own messages. Exports don't: a CSV is
// never grouped, and the workbook's format codes draw the reader's own locale.

/** Narrow no-break space: between digit groups. */
export const THOUSANDS_SEP = '\u202f';

/** An en-US formatted number ("1,234,567.8") with the app's separator ("1 234 567.8"). */
export const regroup = (enUs: string): string => enUs.replace(/,/g, THOUSANDS_SEP);

/** An integer's digits grouped in threes: "1234567" → "1 234 567". */
export const groupDigits = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEP);
