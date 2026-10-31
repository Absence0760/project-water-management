// The server's re-run of a bundle in parts (bundleParts.ts, the backend's
// pack_reproduce_part jobs): planned, run one part at a time and folded, it
// gives checkPackBundle's full re-run check for check (ids, order, outcomes),
// for a pack with § 8, a headline pair, and a combined row whose assessment
// has a dam and a background; the dams' firm yields come back one search a
// part and gather into `reproduce:dams`. A tampered stored yield fails only
// that check (beside its positive control), a dam part that couldn't run
// fails it naming the dam, and a bundle that fails a check plans no part.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../manifest';
import { assessmentPackFixture, headlinePackFixture, packBundleFixture } from '../testing/packBundle';
import { buildPackBundle, checkPackBundle, type PackBundleInput } from './bundle';
import { foldPackBundleReruns, planPackBundleReruns, rerunPackBundlePart, type BundleRerunPart } from './bundleParts';

const hash = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');

async function inParts(input: PackBundleInput) {
	const bytes = (await buildPackBundle(input, hash)).bytes;
	const plan = await planPackBundleReruns(bytes, { hash });
	const done = [];
	for (const part of plan.parts) done.push({ part, result: await rerunPackBundlePart(bytes, part, { hash }) });
	return { bytes, plan, done, folded: await foldPackBundleReruns(bytes, { hash }, plan.result, done) };
}
const shape = (r: { checks: { id: string; ok: boolean }[] }) => r.checks.map((c) => [c.id, c.ok]);

describe('the server’s re-run in parts', () => {
	it('an assessment with a dam and a background: one part per run, the assessment, its background and each dam search; folded, the full re-run’s checks', async () => {
		const input = assessmentPackFixture(hash, { background: true });
		const { bytes, plan, done, folded } = await inParts(input);
		const kinds = plan.parts.map((p) => (p.kind === 'dam' ? `dam:${p.run}${p.memberPosition ?? ''}` : p.kind));
		// Farm one's dam on every run: the baseline, each of the two alone, all together.
		expect(kinds).toEqual(['run:baseline', 'run:application', 'combined', 'background', 'dam:baseline', 'dam:single0', 'dam:single1', 'dam:combined']);
		expect(done.filter((d) => d.part.kind === 'dam').every((d) => d.result.checks.length === 0 && d.result.damYield !== undefined)).toBe(true);
		const full = await checkPackBundle(bytes, { hash });
		expect(folded.ok).toBe(true);
		expect(shape(folded)).toEqual(shape(full));
		expect(folded.checks.find((c) => c.id === 'reproduce:dams')!.detail).toMatch(/firm yield \(4 searches, each its own job\) and assurance of supply of the dam/);
		// Every check but the dams' reads as the full re-run's, word for word.
		const others = (r: typeof full) => r.checks.filter((c) => c.id !== 'reproduce:dams');
		expect(others(folded)).toEqual(others(full));
	});

	it('§ 8 and the headline pair are parts of their own; folded, the same checks as the full re-run', async () => {
		for (const input of [packBundleFixture(hash, { future: true }), await headlinePackFixture(hash)]) {
			const { plan, folded, bytes } = await inParts(input);
			expect(plan.parts.map((p) => p.kind)).toEqual(expect.arrayContaining(['run:baseline', 'run:application']));
			expect(folded.checks).toEqual((await checkPackBundle(bytes, { hash })).checks);
		}
	});

	it('a stored firm yield tampered (the manifest doesn’t print it): only reproduce:dams fails, naming the dam', async () => {
		const input = assessmentPackFixture(hash);
		const row = input.assessment!.report.rows.find((r) => r.metric === 'dam_firm_yield')!;
		row.singles[1] = (row.singles[1] ?? 0) + 1000;
		const { folded } = await inParts(input);
		expect(folded.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['reproduce:dams']);
		expect(folded.checks.find((c) => c.id === 'reproduce:dams')!.detail).toContain('dam_firm_yield at Farm one differs');
	});

	it('a dam part that couldn’t be run fails reproduce:dams with its reason; a bundle failing a check plans none', async () => {
		const input = assessmentPackFixture(hash);
		const { bytes, plan, done } = await inParts(input);
		const bad: BundleRerunPart = { ...(plan.parts.find((p) => p.kind === 'dam') as Extract<BundleRerunPart, { kind: 'dam' }>), run: 'single', memberPosition: 7 };
		const failed = await rerunPackBundlePart(bytes, bad, { hash });
		expect(failed.checks).toEqual([{ id: 'reproduce:dams', ok: false, detail: expect.stringMatching(/^not re-run: .*no application at 7/) }]);
		const folded = await foldPackBundleReruns(bytes, { hash }, plan.result, [...done, { part: bad, result: failed }]);
		expect(folded.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['reproduce:dams']);
		// The manifest expected elsewhere: the plan's own check fails, and nothing is planned.
		const other = await planPackBundleReruns(bytes, { hash, expectManifestSha256: 'f'.repeat(64) });
		expect(other.result.ok).toBe(false);
		expect(other.parts).toEqual([]);
		expect(canonicalJson(other.result.checks.find((c) => c.id === 'manifest')!.ok)).toBe('false');
	});
});

describe('many dams', () => {
	it('six dams touched: one search part per dam and run (24), folded into one reproduce:dams that passes', async () => {
		const { plan, folded, bytes } = await inParts(assessmentPackFixture(hash, { dams: 6 }));
		expect(plan.parts.filter((p) => p.kind === 'dam')).toHaveLength(24);
		expect(folded.ok).toBe(true);
		expect(shape(folded)).toEqual(shape(await checkPackBundle(bytes, { hash })));
		expect(folded.checks.find((c) => c.id === 'reproduce:dams')!.detail).toMatch(/24 searches, each its own job\) and assurance of supply of each of the 6 dams/);
	});
});
