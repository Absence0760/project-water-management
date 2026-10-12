// The queries that pick "the first series of a kind by name" order by the name's bytes (COLLATE "C",
// docs/data-model.md § Which series a run reads), never the database's collation: production RDS (glibc)
// sorts names linguistically, the local and CI Postgres (Alpine, musl) by byte, so a DB test can't see the
// difference and only this check keeps a dropped COLLATE "C" from slipping through (issue #523).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('series picks order by the name’s bytes', () => {
	it.each([
		// A run's input: the first of each kind per site.
		['runs/execute.ts', /ORDER BY site_node_id NULLS FIRST, kind, name COLLATE "C"/],
		// A unit's own CHIRPS series for the unit feed proposal.
		['feeds/fromUnits.ts', /ORDER BY site_node_id, name COLLATE "C"/]
	] as const)('%s', (rel, order) => {
		expect(read(rel)).toMatch(order);
	});
});
