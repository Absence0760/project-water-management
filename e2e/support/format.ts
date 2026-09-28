// Figures as the app shows them (D10, issue #76): digits grouped with a
// narrow no-break space (U+202F), '.' decimal. For expected strings built from
// a computed number; a literal expectation writes the separator as \u202f.
// Except in a regex matched against an accessible name or getByText /
// hasText: Playwright normalises whitespace there, U+202F included, so those
// patterns use a plain space.
// (The engine's format.ts, which the e2e workspace doesn't depend on.)

/** A whole number as the app shows it: 1096 → "1 096". */
export const grouped = (n: number): string => Math.round(n).toLocaleString('en-US').replace(/,/g, '\u202f');

/** A shown figure back to a number: "1 234.5" → 1234.5. */
export const ungroup = (s: string): number => Number(s.replace(/\u202f/g, ''));
