// Evidence packs on screen (pack.ts): the stamp, the verify line and link,
// the in-browser file check the public verify page runs, and the grouping and
// checklist the lists and the pack view read. Dates are local, so the stamp
// is pinned under skewed zones (CLAUDE.md rule 7).
import { packManifestText, type PackManifest } from '@water-management/engine';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pack, PackReproductionState } from '$lib/api';
import { checkableAccept, checkableFiles, checkFile, errataFoundSinceNote, issueChecklist, issuedOf, latestOnly, lookUpCode, manifestFileName, manifestFileText, packHref, packStamp, packsByScenario, packsOfRun, packVerifyLine, packVerifyRef, reproductionNote, sha256Hex, verifyUrl } from './pack';

const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});

const HASH = 'ab12cd34ef56' + '0'.repeat(52);
const hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

function pack(over: Partial<Pack> = {}): Pack {
	return {
		id: 'p1',
		title: 'Upper dam',
		mode: 'application',
		scenarioId: 's1',
		baselineRunId: 'base',
		scenarioRunId: 'app',
		version: 1,
		supersedesId: null,
		supersededById: null,
		status: 'draft',
		manifestSha256: HASH,
		shortCode: 'ab12-cd34-ef56',
		verifyPath: '/verify/ab12-cd34-ef56',
		reportVersion: 'evidence-1',
		engineVersion: '1.33.0',
		pdfSha256: null,
		pdfPages: null,
		bundleSha256: null,
		createdAt: '2026-09-28T10:00:00.000Z',
		createdBy: 'Editor',
		issuedAt: null,
		issuedBy: null,
		statusReason: null,
		signoffs: 0,
		...over
	};
}

describe('packStamp', () => {
	it('stamps each status, a draft without a date and a withdrawn issued pack with its issue date', () => {
		process.env.TZ = 'Africa/Johannesburg';
		const issuedAt = '2026-09-29T08:00:00.000Z';
		expect(packStamp(pack())).toBe('Draft pack · not issued');
		expect(packStamp(pack({ status: 'issued', version: 2, issuedAt }))).toBe('Issued · version 2 · 2026-09-29');
		expect(packStamp(pack({ status: 'superseded', issuedAt }))).toBe('Superseded · version 1 · issued 2026-09-29');
		expect(packStamp(pack({ status: 'withdrawn', issuedAt }))).toBe('Withdrawn · version 1 · issued 2026-09-29');
		// Withdrawn as a draft: never issued, so no date.
		expect(packStamp(pack({ status: 'withdrawn' }))).toBe('Withdrawn · version 1');
	});

	it('dates the issue in the viewer’s zone, on either side of the date line (skewed TZ)', () => {
		const issuedAt = '2026-09-29T23:30:00.000Z';
		process.env.TZ = 'Pacific/Kiritimati';
		expect(packStamp(pack({ status: 'issued', issuedAt }))).toBe('Issued · version 1 · 2026-09-30');
		process.env.TZ = 'Pacific/Pago_Pago';
		expect(packStamp(pack({ status: 'issued', issuedAt }))).toBe('Issued · version 1 · 2026-09-29');
	});
});

describe('the verify reference', () => {
	it('builds the link on this site, encoding the code', () => {
		expect(verifyUrl('https://wm.example', '', 'ab12-cd34-ef56')).toBe('https://wm.example/verify/ab12-cd34-ef56');
		expect(verifyUrl('https://wm.example', '/app', 'a/b')).toBe('https://wm.example/app/verify/a%2Fb');
	});

	it('gives no reference for a draft (no verify page answers), and one for every issued status', () => {
		expect(packVerifyRef(pack(), 'https://wm.example', '')).toBeNull();
		for (const status of ['issued', 'superseded', 'withdrawn'] as const)
			expect(packVerifyRef(pack({ status }), 'https://wm.example', '')).toEqual({ sha256: HASH, code: 'ab12-cd34-ef56', url: 'https://wm.example/verify/ab12-cd34-ef56' });
	});

	it('prints the full hash, the code and the link on one line', () => {
		expect(packVerifyLine({ sha256: HASH, code: 'ab12-cd34-ef56', url: 'https://wm.example/verify/ab12-cd34-ef56' })).toBe(
			`Manifest SHA-256 ${HASH} · verify code ab12-cd34-ef56 at https://wm.example/verify/ab12-cd34-ef56`
		);
	});

	it('links a pack page with its ids encoded', () => {
		expect(packHref('', 'p 1', 'k/2')).toBe('/projects/p%201/packs/k%2F2');
		expect(manifestFileName('ab12-cd34-ef56')).toBe('evidence-pack-ab12-cd34-ef56-manifest.json');
	});
});

describe('checkFile (the verify page’s in-browser check)', () => {
	// Not a whole manifest: the check only needs canonical JSON of an object, which packManifestText is.
	const manifest = { version: 'pack-1', pack: { id: 'p1', version: 1, supersedes: null }, project: { id: 'x', name: 'Catchment' } } as unknown as PackManifest;
	const canonical = manifestFileText(manifest);
	const manifestSha256 = hex(canonical);
	const pdf = new TextEncoder().encode('%PDF-1.7 synthetic');
	const pdfSha256 = hex(pdf);

	it('hashes with WebCrypto as node:crypto does', async () => {
		expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(hex('abc'));
	});

	it('matches the manifest byte for byte, and the PDF when one is recorded', async () => {
		expect(await checkFile(new TextEncoder().encode(canonical), { manifestSha256, pdfSha256 })).toEqual({ result: 'manifest', sha256: manifestSha256, canonical: false });
		expect(await checkFile(pdf, { manifestSha256, pdfSha256 })).toEqual({ result: 'pdf', sha256: pdfSha256 });
	});

	it('matches the reproduction bundle when one is recorded, and not when none is (positive control beside it)', async () => {
		const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
		const bundleSha256 = hex(zip);
		expect(await checkFile(zip, { manifestSha256, pdfSha256, bundleSha256 })).toEqual({ result: 'bundle', sha256: bundleSha256 });
		expect(await checkFile(zip, { manifestSha256, pdfSha256, bundleSha256: null })).toEqual({ result: 'no-match', sha256: bundleSha256 });
		const changed = zip.slice();
		changed[6] = 4;
		expect((await checkFile(changed, { manifestSha256, pdfSha256, bundleSha256 })).result).toBe('no-match');
	});

	it('names the files a pack can be checked with, and the picker’s types', () => {
		expect(checkableFiles({ pdfSha256: null, bundleSha256: null })).toBe('manifest');
		expect(checkableFiles({ pdfSha256: 'a', bundleSha256: null })).toBe('PDF or manifest');
		expect(checkableFiles({ pdfSha256: null, bundleSha256: 'b' })).toBe('reproduction bundle or manifest');
		expect(checkableFiles({ pdfSha256: 'a', bundleSha256: 'b' })).toBe('PDF, reproduction bundle or manifest');
		expect(checkableAccept({ pdfSha256: null, bundleSha256: 'b' })).toBe('.zip,application/zip,.json,application/json');
		expect(checkableAccept({ pdfSha256: null, bundleSha256: null })).toBe('.json,application/json');
	});

	it('matches a manifest saved pretty-printed, in its canonical form', async () => {
		const pretty = new TextEncoder().encode(JSON.stringify(JSON.parse(canonical), null, 2));
		const r = await checkFile(pretty, { manifestSha256, pdfSha256: null });
		expect(r).toMatchObject({ result: 'manifest', canonical: true });
		expect(r.sha256).toBe(hex(pretty));
	});

	it('refuses a manifest with one byte changed, pretty-printed or not', async () => {
		const changed = canonical.replace('Catchment', 'Catchmenu');
		expect(changed).not.toBe(canonical);
		expect((await checkFile(new TextEncoder().encode(changed), { manifestSha256, pdfSha256 })).result).toBe('no-match');
		const pretty = JSON.stringify(JSON.parse(changed), null, 2);
		expect((await checkFile(new TextEncoder().encode(pretty), { manifestSha256, pdfSha256 })).result).toBe('no-match');
	});

	it('never matches a PDF while none is recorded, and never reads a PDF or non-object JSON as a manifest', async () => {
		expect((await checkFile(pdf, { manifestSha256, pdfSha256: null })).result).toBe('no-match');
		for (const text of ['[1,2]', 'null', '"x"', 'not json'])
			expect((await checkFile(new TextEncoder().encode(text), { manifestSha256, pdfSha256: null })).result).toBe('no-match');
		// A PDF is never parsed as JSON: the hash is tried once, not twice.
		let calls = 0;
		const counting = async (b: Uint8Array) => ((calls += 1), hex(b));
		await checkFile(pdf, { manifestSha256, pdfSha256: null }, counting);
		expect(calls).toBe(1);
	});

	it('refuses bytes that aren’t UTF-8 rather than decoding them loosely', async () => {
		const bad = new Uint8Array([0x7b, 0xff, 0x7d]);
		expect((await checkFile(bad, { manifestSha256, pdfSha256: null })).result).toBe('no-match');
		expect(packManifestText(manifest)).toBe(canonical);
	});
});

describe('lists of packs', () => {
	const a1 = pack({ id: 'a1', version: 1, status: 'superseded', createdAt: '2026-09-01T00:00:00Z' });
	const a2 = pack({ id: 'a2', version: 2, status: 'issued', supersedesId: 'a1', scenarioRunId: 'app2', createdAt: '2026-09-02T00:00:00Z' });
	const b1 = pack({ id: 'b1', scenarioId: null, scenarioRunId: null, mode: 'baseline', status: 'draft' });
	const other = pack({ id: 'c1', scenarioId: 's2', scenarioRunId: 'app3' });

	it('groups by application, baseline evidence under null, newest version first', () => {
		const m = packsByScenario([a1, b1, a2, other]);
		expect(m.get('s1')!.map((p) => p.id)).toEqual(['a2', 'a1']);
		expect(m.get(null)!.map((p) => p.id)).toEqual(['b1']);
		expect(m.get('s2')!.map((p) => p.id)).toEqual(['c1']);
	});

	it('finds a run’s packs: an application pack by its scenario run, a baseline pack by its nominated run', () => {
		expect(packsOfRun([a1, a2, b1, other], 'app').map((p) => p.id)).toEqual(['a1']);
		expect(packsOfRun([a1, a2, b1, other], 'app2').map((p) => p.id)).toEqual(['a2']);
		// Application packs cite the baseline run too, but aren't the baseline report's.
		expect(packsOfRun([a1, a2, b1, other], 'base').map((p) => p.id)).toEqual(['b1']);
	});

	it('names the issued pack a new draft supersedes, per application or baseline evidence', () => {
		expect(issuedOf([a1, a2, b1], 's1')?.id).toBe('a2');
		expect(issuedOf([a1, a2, b1], null)).toBeNull();
		expect(issuedOf([a1, b1, pack({ id: 'b0', scenarioId: null, status: 'issued' })], null)?.id).toBe('b0');
	});
});

describe('issueChecklist', () => {
	it('lists the three checks in order, each with its done or to-do words', () => {
		const all = issueChecklist({ issuable: true, runsVerified: true, errataRecorded: true, signed: true });
		expect(all.map((c) => c.id)).toEqual(['issuable', 'runsVerified', 'errataRecorded', 'signed']);
		expect(all.every((c) => c.ok)).toBe(true);
		const unsigned = issueChecklist({ issuable: true, runsVerified: true, errataRecorded: true, signed: false });
		expect(unsigned.find((c) => !c.ok)).toMatchObject({ id: 'signed' });
		expect(unsigned[3]!.todo).toMatch(/Appendix B\.2/);
	});

	it('fails a draft missing an erratum found since it was made, saying to draft it again', () => {
		const stale = issueChecklist({ issuable: true, runsVerified: true, errataRecorded: false, signed: true });
		expect(stale.filter((c) => !c.ok).map((c) => c.id)).toEqual(['errataRecorded']);
		expect(stale[2]!.todo).toMatch(/can’t be issued\. Draft the pack again/);
	});
});

describe('the verify page’s lookup (lookUpCode, latestOnly)', () => {
	const found = (code: string) => ({ shortCode: code }) as unknown as import('$lib/api').PackVerification;
	const notFound = new Error('404');
	const isNotFound = (e: unknown) => e === notFound;
	const parse = (c: string) => (/^[0-9a-f-]+$/.test(c) ? c : null);

	it('asks for a code, says "not found" alike for a malformed and an unknown code, and keeps any other failure', async () => {
		const verify = async (c: string) => (c === 'ab12' ? found(c) : Promise.reject(c === 'ffff' ? notFound : new Error('network down')));
		expect(await lookUpCode('', parse, verify, isNotFound)).toEqual({ status: 'no-code' });
		expect(await lookUpCode('not a code', parse, verify, isNotFound)).toEqual({ status: 'not-found' });
		expect(await lookUpCode('ffff', parse, verify, isNotFound)).toEqual({ status: 'not-found' });
		expect(await lookUpCode('0000', parse, verify, isNotFound)).toEqual({ status: 'error', error: 'network down' });
		expect(await lookUpCode('ab12', parse, verify, isNotFound)).toEqual({ status: 'found', v: found('ab12') });
	});

	it('shows only the latest of two quick lookups, whichever answers last (the page’s load)', async () => {
		// Two navigations: the first code's answer is held until after the second's.
		const answers = new Map<string, (v: import('$lib/api').PackVerification) => void>();
		const failures = new Map<string, (e: unknown) => void>();
		const verify = (c: string) => new Promise<import('$lib/api').PackVerification>((res, rej) => (answers.set(c, res), failures.set(c, rej)));
		const shown: string[] = [];
		const latest = latestOnly();
		const load = async (c: string) => {
			const current = latest.begin();
			const r = await lookUpCode(c, parse, verify, isNotFound);
			if (current()) shown.push(r.status === 'found' ? r.v.shortCode : r.status);
		};
		const first = load('aaaa');
		const second = load('bbbb');
		answers.get('bbbb')!(found('bbbb'));
		await second;
		answers.get('aaaa')!(found('aaaa'));
		await first;
		expect(shown).toEqual(['bbbb']);
		// The error path too: a late failure of an older lookup doesn't replace the newer answer.
		const third = load('cccc');
		const fourth = load('dddd');
		answers.get('dddd')!(found('dddd'));
		await fourth;
		failures.get('cccc')!(new Error('network down'));
		await third;
		expect(shown).toEqual(['bbbb', 'dddd']);
	});

	it('keeps each check true only until a later request begins', () => {
		const latest = latestOnly();
		const a = latest.begin();
		expect(a()).toBe(true);
		const b = latest.begin();
		expect([a(), b()]).toEqual([false, true]);
	});
});

describe('errataFoundSinceNote', () => {
	it('says "since issue" once a pack was issued, whatever it is now, and that the pack never records them', () => {
		for (const p of [pack({ status: 'issued', issuedAt: '2026-09-29T10:00:00Z' }), pack({ status: 'withdrawn', issuedAt: '2026-09-29T10:00:00Z' })]) {
			const n = errataFoundSinceNote(p);
			expect(n.heading).toBe('Errata found since issue');
			expect(n.note).toMatch(/never will: its manifest and hash are fixed/);
		}
	});

	it('says "since this draft was made" before issue, with the way to record them (a draft again)', () => {
		const n = errataFoundSinceNote(pack({ status: 'draft', issuedAt: null }));
		expect(n.heading).toBe('Errata found since this draft was made');
		expect(n.note).toMatch(/so it can’t be issued: draft the pack again/);
		// A pack withdrawn before it was issued was never issued either.
		expect(errataFoundSinceNote(pack({ status: 'withdrawn', issuedAt: null })).heading).toBe('Errata found since this draft was made');
	});
});

describe('reproductionNote', () => {
	const ok = (id: string) => ({ id, ok: true, detail: 'fine' });
	const bad = (id: string) => ({ id, ok: false, detail: 'differs' });
	const state = (over: Partial<PackReproductionState>): PackReproductionState => ({
		status: 'none',
		engineVersion: null,
		runEngines: [],
		checkedAt: null,
		checks: [],
		error: null,
		...over
	});

	it('says nothing for a draft or a pack issued before re-runs', () => {
		expect(reproductionNote(state({}))).toBeNull();
	});

	it('names the engine, the date and both runs when it reproduced; one run for a baseline pack', () => {
		process.env.TZ = 'Pacific/Kiritimati';
		const both = reproductionNote(state({ status: 'reproduced', engineVersion: '9.1.0', runEngines: ['9.1.0'], checkedAt: '2026-09-30T23:30:00Z', checks: [ok('stored'), ok('reproduce:baseline'), ok('reproduce:application')] }))!;
		expect(both.tone).toBe('good');
		expect(both.text).toMatch(/^Reproduced on the server on 2026-10-01: re-run with engine 9\.1\.0 .*both its runs gave the same results, and every one of its 3 checks passed/);
		expect(both.failed).toEqual([]);
		const one = reproductionNote(state({ status: 'reproduced', engineVersion: '9.1.0', checks: [ok('reproduce:baseline')] }))!;
		expect(one.text).toContain('its run gave the same results');
		expect(one.text).not.toContain(' on 2');
	});

	it('lists the failed checks when it didn’t reproduce', () => {
		const n = reproductionNote(state({ status: 'not_reproduced', engineVersion: '9.1.0', checks: [ok('stored'), bad('results:baseline'), bad('reproduce:baseline')] }))!;
		expect(n.tone).toBe('bad');
		expect(n.text).toContain('2 checks failed');
		expect(n.failed.map((c) => c.id)).toEqual(['results:baseline', 'reproduce:baseline']);
		expect(reproductionNote(state({ status: 'not_reproduced', engineVersion: '9.1.0', checks: [bad('stored')] }))!.text).toContain('1 check failed');
	});

	it('warns, rather than fails, when only the re-runs differ on another engine than the runs’', () => {
		const n = reproductionNote(state({ status: 'other_engine', engineVersion: '9.2.0', runEngines: ['9.1.0'], checks: [ok('files'), bad('reproduce:baseline'), bad('reproduce:application')] }))!;
		expect(n.tone).toBe('warn');
		expect(n.text).toContain('made with engine 9.1.0 and the server runs 9.2.0, on which their results differ');
		expect(n.text).toContain('check out engine 9.1.0');
	});

	it('says the server is re-running it, that it couldn’t (with the reason), or that there is no bundle', () => {
		expect(reproductionNote(state({ status: 'checking' }))).toMatchObject({ tone: 'quiet', text: expect.stringMatching(/is re-running/) });
		expect(reproductionNote(state({ status: 'failed', error: 'the store was down' }))).toMatchObject({ tone: 'bad', text: 'The server couldn’t re-run this pack: the store was down' });
		expect(reproductionNote(state({ status: 'failed' }))!.text).toBe('The server couldn’t re-run this pack.');
		expect(reproductionNote(state({ status: 'no_bundle' }))!.text).toMatch(/without a reproduction bundle/);
	});
});
