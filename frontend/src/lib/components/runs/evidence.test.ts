import { describe, expect, it } from 'vitest';
import type { Nomination, RunMeta } from '$lib/api';
import {
	compareEvidenceNote,
	currentNomination,
	evidenceLine,
	historyEntries,
	modelDriftWarning,
	nominateBlocker,
	runoffModelName
} from './evidence';

// Dates are the caller's to format; the tests keep the ISO day so they don't depend on the TZ.
const fmt = (iso: string) => iso.slice(0, 10);

const nom = (runId: string, day: number, extra: Partial<Nomination> = {}): Nomination => ({
	id: `n${day}`,
	runId,
	runLabel: `Run ${runId.toUpperCase()}`,
	runCreatedAt: `2026-08-${String(day).padStart(2, '0')}T08:00:00.000Z`,
	runoffModel: 'gr4j',
	engineVersion: '0.19.2',
	reason: `reason ${day}`,
	nominatedAt: `2026-09-${String(day).padStart(2, '0')}T08:00:00.000Z`,
	nominatedBy: 'Ann',
	...extra
});

const run = (id: string, createdAt: string, runoffModel?: string): RunMeta => ({
	id,
	label: id,
	engineVersion: '0.19.2',
	startDate: '2020-01-01',
	endDate: '2020-12-31',
	createdAt,
	createdBy: 'Ann',
	legacy: runoffModel === 'legacy',
	runoffModel: runoffModel as RunMeta['runoffModel']
});

describe('runoffModelName', () => {
	it('names the models, treating absent as legacy', () => {
		expect(runoffModelName('gr4j')).toBe('GR4J');
		expect(runoffModelName('legacy')).toBe('legacy (b023 workbook)');
		expect(runoffModelName(undefined)).toBe('legacy (b023 workbook)');
		expect(runoffModelName('awbm')).toBe('awbm');
	});
});

describe('historyEntries', () => {
	it('reads the first as nominated and each later one as a replacement, the last current', () => {
		const h = [nom('a', 1), nom('b', 2, { nominatedBy: null, runLabel: '' }), nom('a', 3)];
		expect(currentNomination(h)?.id).toBe('n3');
		expect(currentNomination([])).toBeNull();
		expect(historyEntries(h, fmt)).toEqual([
			{ id: 'n1', runId: 'a', text: 'Nominated “Run A” on 2026-09-01 by Ann', reason: 'reason 1', model: 'GR4J, engine 0.19.2', current: false },
			{ id: 'n2', runId: 'b', text: 'Replaced by “Untitled run” on 2026-09-02', reason: 'reason 2', model: 'GR4J, engine 0.19.2', current: false },
			{ id: 'n3', runId: 'a', text: 'Replaced by “Run A” on 2026-09-03 by Ann', reason: 'reason 3', model: 'GR4J, engine 0.19.2', current: true }
		]);
	});
});

describe('modelDriftWarning', () => {
	const h = [nom('a', 1)]; // run A made 2026-08-01, GR4J
	it('is null with nothing nominated, or no newer run with another model', () => {
		expect(modelDriftWarning([run('x', '2026-08-02T00:00:00Z', 'legacy')], [])).toBeNull();
		expect(modelDriftWarning([run('a', '2026-08-01T08:00:00Z', 'gr4j'), run('b', '2026-08-05T00:00:00Z', 'gr4j')], h)).toBeNull();
		// Older runs of another model are what the applicant moved away from, not a warning.
		expect(modelDriftWarning([run('old', '2026-07-01T00:00:00Z', 'legacy')], h)).toBeNull();
		// A run from an older API without runoffModel isn't guessed at.
		expect(modelDriftWarning([run('b', '2026-08-05T00:00:00Z')], h)).toBeNull();
	});

	it('warns about newer runs with a different runoff model, naming the models', () => {
		expect(modelDriftWarning([run('b', '2026-08-05T00:00:00Z', 'legacy')], h)).toBe(
			'1 run made after the nominated evidence run “Run A” uses a different runoff model (legacy (b023 workbook), not GR4J). ' +
				'The nomination still stands: results from those runs are not the evidence unless one is nominated, with a reason.'
		);
		expect(modelDriftWarning([run('b', '2026-08-05T00:00:00Z', 'legacy'), run('c', '2026-08-06T00:00:00Z', 'awbm')], h)).toMatch(
			/^2 runs made after .* use a different runoff model \(legacy \(b023 workbook\), awbm, not GR4J\)/
		);
	});

	it('compares instants, not strings, so offsets in the timestamps don’t matter', () => {
		// 2026-08-01T09:00+02:00 is 07:00Z, before the nominated run's 08:00Z.
		expect(modelDriftWarning([run('b', '2026-08-01T09:00:00+02:00', 'legacy')], h)).toBeNull();
	});
});

describe('evidenceLine', () => {
	it('says when a run was nominated and, if replaced, by what', () => {
		const h = [nom('a', 1), nom('b', 2)];
		expect(evidenceLine('b', h, fmt)).toBe('Nominated as evidence on 2026-09-02 by Ann.');
		expect(evidenceLine('a', h, fmt)).toBe('Nominated as evidence on 2026-09-01 by Ann; replaced by “Run B” on 2026-09-02.');
		expect(evidenceLine('c', h, fmt)).toBeNull();
		// A run nominated again reads by its latest nomination.
		expect(evidenceLine('a', [...h, nom('a', 3)], fmt)).toBe('Nominated as evidence on 2026-09-03 by Ann.');
	});
});

describe('compareEvidenceNote', () => {
	it('names the current evidence run with its reason, and a past one with what replaced it and why', () => {
		expect(compareEvidenceNote('A', null, fmt)).toBeNull();
		expect(compareEvidenceNote('A', { status: 'current', nominatedAt: '2026-09-01T08:00:00Z', nominatedBy: 'Ann', reason: 'calibrated', replacedBy: null }, fmt)).toBe(
			'Run A is the nominated evidence run, nominated on 2026-09-01 by Ann (“calibrated”).'
		);
		expect(
			compareEvidenceNote(
				'B',
				{
					status: 'past',
					nominatedAt: '2026-09-01T08:00:00Z',
					nominatedBy: 'Ann',
					reason: 'calibrated',
					replacedBy: { runId: 'x', runLabel: 'Refit', nominatedAt: '2026-09-03T08:00:00Z', nominatedBy: 'Ben', reason: 'logger fixed' }
				},
				fmt
			)
		).toBe('Run B was the evidence run, nominated on 2026-09-01 by Ann (“calibrated”), then replaced by “Refit” on 2026-09-03 by Ben because “logger fixed”.');
	});
});

describe('nominateBlocker', () => {
	it('refuses a legacy run and the current one; any other run may be nominated', () => {
		const h = [nom('a', 1)];
		expect(nominateBlocker({ id: 'l', legacy: true }, h)).toMatch(/workbook comparison only/);
		expect(nominateBlocker({ id: 'a', legacy: false }, h)).toBe('This run is the nominated evidence run.');
		expect(nominateBlocker({ id: 'b', legacy: false }, h)).toBeNull();
		expect(nominateBlocker({ id: 'b', legacy: false }, [])).toBeNull();
	});
});
