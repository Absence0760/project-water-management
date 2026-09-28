import { describe, expect, it } from 'vitest';
import type { RunMeta } from '$lib/api/types';
import { compareSearch, compareTabHref, defaultPair, defaultRunFor, defaultWhatIf, formatRef, parseRef, publishedBaseline, runOptionLabel } from './picker';

const run = (id: string, label = ''): RunMeta => ({
	id,
	label,
	engineVersion: '0.2.0',
	startDate: '2000-01-01',
	endDate: '2020-12-31',
	createdAt: '2026-09-23T12:00:00Z',
	createdBy: 'A',
	legacy: false
});

describe('run refs', () => {
	it('parses and formats <projectId>:<runId>', () => {
		expect(parseRef('p1:r1')).toEqual({ projectId: 'p1', runId: 'r1' });
		expect(formatRef({ projectId: 'p1', runId: 'r1' })).toBe('p1:r1');
		for (const bad of [null, undefined, '', 'p1', 'p1:', ':r1', 'p1:r1:x']) expect(parseRef(bad)).toBeNull();
	});

	it('builds the page query, ?project= only when no side is chosen', () => {
		const a = { projectId: 'p', runId: 'r1' };
		const b = { projectId: 'q', runId: 'r2' };
		expect(compareSearch(a, b)).toBe('?a=p%3Ar1&b=q%3Ar2');
		expect(compareSearch(a, null, 'p')).toBe('?a=p%3Ar1');
		expect(compareSearch(null, null, 'p')).toBe('?project=p');
		expect(compareSearch(null, null)).toBe('');
	});

	it('adds the second what-if as c, after a and b, and round-trips it', () => {
		const a = { projectId: 'p', runId: 'r1' };
		const b = { projectId: 'p', runId: 'r2' };
		const c = { projectId: 'q', runId: 'r3' };
		const s = compareSearch(a, b, 'p', c);
		expect(s).toBe('?a=p%3Ar1&b=p%3Ar2&c=q%3Ar3');
		const q = new URLSearchParams(s);
		expect([q.get('a'), q.get('b'), q.get('c')].map(parseRef)).toEqual([a, b, c]);
		// An old two-run link is unchanged.
		expect(compareSearch(a, b, 'p', null)).toBe('?a=p%3Ar1&b=p%3Ar2');
	});
});

describe('picker defaults', () => {
	it('opens with A = previous run and B = latest run of the project', () => {
		expect(defaultPair('p', [run('new'), run('old'), run('older')])).toEqual({
			a: { projectId: 'p', runId: 'old' },
			b: { projectId: 'p', runId: 'new' }
		});
	});

	it('opens with A = the published baseline when it isn’t the latest run', () => {
		const pub = { ...run('older'), published: true };
		expect(defaultPair('p', [run('new'), run('old'), pub])).toEqual({
			a: { projectId: 'p', runId: 'older' },
			b: { projectId: 'p', runId: 'new' }
		});
	});

	it('falls back to the previous run when the latest run is the published one', () => {
		expect(defaultPair('p', [{ ...run('new'), published: true }, run('old')])).toEqual({
			a: { projectId: 'p', runId: 'old' },
			b: { projectId: 'p', runId: 'new' }
		});
	});

	it('has no default pair with fewer than two runs', () => {
		expect(defaultPair('p', [run('only')])).toBeNull();
		expect(defaultPair('p', [])).toBeNull();
	});

	it('switching a side to a project avoids the run chosen on the other side', () => {
		const runs = [run('r3'), run('r2'), run('r1')];
		expect(defaultRunFor(runs, { projectId: 'p', runId: 'r3' }, 'p')).toBe('r2');
		expect(defaultRunFor(runs, { projectId: 'other', runId: 'r3' }, 'p')).toBe('r3');
		expect(defaultRunFor(runs, null, 'p')).toBe('r3');
		expect(defaultRunFor([run('r1')], { projectId: 'p', runId: 'r1' }, 'p')).toBe('r1');
		expect(defaultRunFor([], null, 'p')).toBeNull();
	});

	it('adds as what-if 2 the newest run that is neither the baseline nor what-if 1', () => {
		const runs = [run('r4'), run('r3'), run('r2'), run('r1')];
		const p = (runId: string) => ({ projectId: 'p', runId });
		expect(defaultWhatIf(runs, [p('r1'), p('r4')], 'p')).toBe('r3');
		expect(defaultWhatIf(runs, [p('r3'), p('r4')], 'p')).toBe('r2');
		// A run of another project isn't taken here.
		expect(defaultWhatIf(runs, [{ projectId: 'q', runId: 'r4' }, null], 'p')).toBe('r4');
		expect(defaultWhatIf([run('r2'), run('r1')], [p('r1'), p('r2')], 'p')).toBeNull();
	});

	it('labels runs, falling back to "Untitled run"', () => {
		const fmt = (iso: string) => iso.slice(0, 10);
		expect(runOptionLabel(run('r', 'Baseline'), fmt)).toBe('Baseline · 2026-09-23 · 2000–2020');
		expect(runOptionLabel(run('r'), fmt)).toBe('Untitled run · 2026-09-23 · 2000–2020');
		expect(runOptionLabel({ ...run('r', 'Base'), published: true }, fmt, true)).toBe('Base · 2026-09-23 · 2000–2020 · latest · published');
	});

	it('adds the Runs list tags that apply, in its order', () => {
		const fmt = (iso: string) => iso.slice(0, 10);
		const tagged: RunMeta = { ...run('r', 'Dam raise'), evidence: 'current', pinned: true, legacy: true };
		expect(runOptionLabel(tagged, fmt, true)).toBe('Dam raise · 2026-09-23 · 2000–2020 · latest · evidence · pinned · workbook comparison');
		expect(runOptionLabel({ ...run('r', 'Old'), evidence: 'past' }, fmt)).toBe('Old · 2026-09-23 · 2000–2020 · former evidence');
	});
});

describe('publishedBaseline (the "Compare with published" offer)', () => {
	const runs = [run('r3'), { ...run('r2'), published: true }, run('r1')];
	const ref = (runId: string, projectId = 'p') => ({ projectId, runId });

	it('offers B’s project’s published run as A', () => {
		expect(publishedBaseline(runs, ref('r1'), ref('r3'))).toEqual(ref('r2'));
		expect(publishedBaseline(runs, null, ref('r3'))).toEqual(ref('r2'));
		// A from another project: the offer is still B's project's baseline.
		expect(publishedBaseline(runs, ref('x', 'q'), ref('r3'))).toEqual(ref('r2'));
	});

	it('offers nothing when it would change nothing', () => {
		expect(publishedBaseline(runs, ref('r2'), ref('r3'))).toBeNull(); // A is already it
		expect(publishedBaseline(runs, ref('r1'), ref('r2'))).toBeNull(); // B is the published run
		expect(publishedBaseline([run('r3'), run('r1')], ref('r1'), ref('r3'))).toBeNull(); // nothing published
		expect(publishedBaseline(undefined, ref('r1'), ref('r3'))).toBeNull(); // runs not loaded yet
		expect(publishedBaseline(runs, ref('r1'), null)).toBeNull(); // no B
	});
});

describe('compareTabHref', () => {
	it('opens the workspace tab with the pair, and never names the project', () => {
		const a = { projectId: 'p', runId: 'r1' };
		const b = { projectId: 'q', runId: 'r2' };
		expect(compareTabHref(a, b)).toBe('?tab=compare&a=p%3Ar1&b=q%3Ar2');
		expect(compareTabHref(null, b)).toBe('?tab=compare&b=q%3Ar2');
		expect(compareTabHref(null, null)).toBe('?tab=compare');
		expect(compareTabHref(a, b, { projectId: 'p', runId: 'r3' })).toBe('?tab=compare&a=p%3Ar1&b=q%3Ar2&c=p%3Ar3');
	});
});
