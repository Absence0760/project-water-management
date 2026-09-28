// The methods page's departures must stay tied to the audit they summarise:
// every id is a row of docs/engine-audit.md, and the page's "pending" marks
// come from the engine's generated known limitations, not from this list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_LIMITATIONS } from '@water-management/engine/limitations';
import { DEPARTURES, openIds } from './departures';

const audit = readFileSync(fileURLToPath(new URL('../../../../docs/engine-audit.md', import.meta.url)), 'utf8');
const rowIds = new Set(
	audit
		.split('\n')
		.map((l) => /^\| (?:\*\*)?([A-Z]\d+(?:–[A-Z]\d+)?)(?:\*\*)?[ |]/.exec(l)?.[1])
		.filter((id): id is string => !!id)
);

describe('DEPARTURES (the public methods page)', () => {
	it('finds the audit rows it parses', () => {
		for (const id of ['H1', 'R1', 'W1–W5', 'Q1', 'Q17', 'T1']) expect(rowIds, id).toContain(id);
	});

	it('names only ids that are rows of docs/engine-audit.md, each once', () => {
		const ids = DEPARTURES.flatMap((d) => d.ids);
		for (const id of ids) expect(rowIds, id).toContain(id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('marks as open exactly the ids in the known limitations', () => {
		const n1 = DEPARTURES.find((d) => d.ids.includes('N1'))!;
		const h1 = DEPARTURES.find((d) => d.ids.includes('H1'))!;
		expect(openIds(n1, [{ id: 'N1' }])).toEqual(['N1']);
		expect(openIds(n1, [])).toEqual([]);
		// H1 (the legacy runoff model) was removed in engine 1.0.0: never open today.
		expect(openIds(h1, KNOWN_LIMITATIONS)).toEqual([]);
	});
});
