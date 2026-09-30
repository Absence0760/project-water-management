// The evidence pack's manifest (roadmap WP-3.14, docs/evidence-pack.md): the
// same pack gives the same text whatever order its keys were written in; a
// changed setting, run or identity changes it; the lifecycle (status, dates,
// signers) is not in it; and the short code.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPackManifest, packManifestText, packShortCode, parsePackCode, PACK_MANIFEST_VERSION, type PackManifestInput } from './pack';
import type { EvidenceReport } from './types';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** A report-shaped document: the manifest treats the report as data, so a small one exercises every rule. */
function report(settings: Record<string, unknown> = { apanMm: [150, 180], ewrPragmaticM3PerDay: [4000, 4000], runoffModel: 'gr4j' }): EvidenceReport {
	return {
		version: 'evidence-1',
		mode: 'baseline',
		builtBy: '1.30.0',
		identity: { title: 'Catchment', project: { id: 'p1', name: 'Catchment' }, baseline: { runId: 'r1', engineVersion: '1.30.0' }, application: null },
		issuable: true,
		refused: false,
		rows: [{ id: 'mar', run: 0.1 + 0.2, band: null }],
		appendix: { baselineInputs: { settings, model: { nodes: [{ id: 'n1', name: 'Weir' }] } } }
	} as unknown as EvidenceReport;
}

const input = (over: Partial<PackManifestInput> = {}): PackManifestInput => ({
	pack: { id: '00000000-0000-4000-8000-0000000000a1', version: 1, supersedes: null },
	project: { id: 'p1', name: 'Catchment' },
	report: report(),
	engine: { version: '1.30.0', build: null },
	...over
});

const hashOf = (i: PackManifestInput) => sha256(packManifestText(buildPackManifest(i)));

/** The same value with every object's keys in reverse order, deep. */
function shuffled(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(shuffled);
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffled(x)]));
	return v;
}

describe('buildPackManifest', () => {
	it('records its version, the pack, the project, the engine and the report', () => {
		const m = buildPackManifest(input());
		expect(m.version).toBe(PACK_MANIFEST_VERSION);
		expect(m.pack).toEqual({ id: '00000000-0000-4000-8000-0000000000a1', version: 1, supersedes: null });
		expect(m.engine).toEqual({ version: '1.30.0', build: null });
		expect(m.report).toEqual(report());
	});

	it('gives the same text twice, and with every key shuffled', () => {
		const a = packManifestText(buildPackManifest(input()));
		expect(packManifestText(buildPackManifest(input()))).toBe(a);
		expect(packManifestText(buildPackManifest(shuffled(input()) as PackManifestInput))).toBe(a);
		// And after a jsonb-style round trip (keys reordered, JSON numbers).
		expect(packManifestText(shuffled(JSON.parse(JSON.stringify(buildPackManifest(input())))) as never)).toBe(a);
	});

	it('changes the hash when a setting, the pack, the project or the engine changes', () => {
		const h = hashOf(input());
		// Positive control: the same input hashes the same.
		expect(hashOf(input())).toBe(h);
		expect(hashOf(input({ report: report({ apanMm: [150, 181], ewrPragmaticM3PerDay: [4000, 4000], runoffModel: 'gr4j' }) }))).not.toBe(h);
		expect(hashOf(input({ pack: { id: '00000000-0000-4000-8000-0000000000a2', version: 1, supersedes: null } }))).not.toBe(h);
		expect(hashOf(input({ project: { id: 'p1', name: 'Renamed' } }))).not.toBe(h);
		expect(hashOf(input({ engine: { version: '1.30.1', build: null } }))).not.toBe(h);
		expect(hashOf(input({ engine: { version: '1.30.0', build: 'abc123' } }))).not.toBe(h);
		expect(hashOf(input({ pack: { id: '00000000-0000-4000-8000-0000000000a1', version: 2, supersedes: { id: 'x', manifestSha256: 'f'.repeat(64) } } }))).not.toBe(h);
	});

	it('leaves the lifecycle out: a status, issue date or signer given with the input is not hashed', () => {
		const h = hashOf(input());
		const withLifecycle = { ...input(), status: 'issued', issuedAt: '2026-09-29T00:00:00Z', signers: ['Dr A'] } as PackManifestInput;
		expect(hashOf(withLifecycle)).toBe(h);
		expect(Object.keys(buildPackManifest(withLifecycle)).sort()).toEqual(['engine', 'pack', 'project', 'report', 'version']);
	});

	it('stores the report as the API serves it: NaN becomes null, an undefined member is dropped', () => {
		const r = { ...report(), extra: undefined, rows: [{ id: 'mar', run: Number.NaN, band: null }] } as unknown as EvidenceReport;
		const m = buildPackManifest(input({ report: r }));
		expect((m.report.rows[0] as unknown as { run: number | null }).run).toBeNull();
		expect('extra' in m.report).toBe(false);
		// Hashable, where the raw report (a NaN) is not.
		expect(() => packManifestText(m)).not.toThrow();
	});

	it('refuses a version that does not match what it supersedes', () => {
		expect(() => buildPackManifest(input({ pack: { id: 'a', version: 0, supersedes: null } }))).toThrow(RangeError);
		expect(() => buildPackManifest(input({ pack: { id: 'a', version: 2, supersedes: null } }))).toThrow(RangeError);
		expect(() => buildPackManifest(input({ pack: { id: 'a', version: 1, supersedes: { id: 'b', manifestSha256: 'f'.repeat(64) } } }))).toThrow(RangeError);
		// Positive control: a second version naming its predecessor.
		expect(buildPackManifest(input({ pack: { id: 'a', version: 2, supersedes: { id: 'b', manifestSha256: 'f'.repeat(64) } } })).pack.version).toBe(2);
	});
});

describe('packShortCode and parsePackCode', () => {
	const hash = 'a1b2c3d4e5f6'.padEnd(64, '0');

	it('shows the first 12 hex digits in groups of four', () => {
		expect(packShortCode(hash)).toBe('a1b2-c3d4-e5f6');
		expect(() => packShortCode('A1B2')).toThrow(TypeError);
	});

	it('reads a short code or a full hash in any case, with or without dashes, and nothing else', () => {
		expect(parsePackCode('A1B2-C3D4-E5F6')).toEqual({ kind: 'short', value: 'a1b2c3d4e5f6' });
		expect(parsePackCode('a1b2c3d4e5f6')).toEqual({ kind: 'short', value: 'a1b2c3d4e5f6' });
		expect(parsePackCode(hash.toUpperCase())).toEqual({ kind: 'full', value: hash });
		for (const bad of ['', 'a1b2-c3d4', 'g1b2c3d4e5f6', hash.slice(1), `${hash}0`, "a1b2c3d4e5f6' OR 1=1"]) expect(parsePackCode(bad), bad).toBeNull();
	});
});
