// Errata found since a pack's manifest was frozen (errata.ts; issue #71
// follow-up "Errata found after issue on verify"): the current list over the
// runs' engines and fits' engines, less what the manifest recorded.
import type { Erratum } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { errataFoundSince } from './errata.js';

const er = (id: string, keyedOn: Erratum['keyedOn'], firstAffected: string, fixedIn: string | null): Erratum => ({
	id,
	keyedOn,
	firstAffected,
	fixedIn,
	severity: 'Medium',
	appliesWhen: 'always',
	summary: `${id} goes wrong`,
	source: 'engine-audit.md X'
});

const LIST = [er('ER-1', 'run', '1.0.0', '1.5.0'), er('ER-2', 'run', '1.2.0', null), er('ER-3', 'fit', '1.0.0', '1.3.0'), er('ER-4', 'run', '2.0.0', null)];

describe('errataFoundSince', () => {
	it('lists what applies to a run’s engine now and the manifest didn’t record, as id and summary', () => {
		expect(errataFoundSince([], [{ engineVersion: '1.4.0', fitEngineVersion: null }], LIST)).toEqual([
			{ id: 'ER-1', summary: 'ER-1 goes wrong' },
			{ id: 'ER-2', summary: 'ER-2 goes wrong' }
		]);
	});

	it('leaves out one the manifest recorded (positive control: the same run with nothing recorded lists it)', () => {
		const runs = [{ engineVersion: '1.4.0', fitEngineVersion: null }];
		expect(errataFoundSince([{ id: 'ER-1' }], runs, LIST).map((e) => e.id)).toEqual(['ER-2']);
		expect(errataFoundSince([{ id: 'ER-1' }, { id: 'ER-2' }], runs, LIST)).toEqual([]);
	});

	it('keys a fit erratum on the fit’s engine, not the run’s; entered parameters (no fit) meet none', () => {
		expect(errataFoundSince([], [{ engineVersion: '1.6.0', fitEngineVersion: '1.1.0' }], LIST).map((e) => e.id)).toEqual(['ER-2', 'ER-3']);
		expect(errataFoundSince([], [{ engineVersion: '1.6.0', fitEngineVersion: null }], LIST).map((e) => e.id)).toEqual(['ER-2']);
		expect(errataFoundSince([], [{ engineVersion: '1.6.0', fitEngineVersion: '1.3.0' }], LIST).map((e) => e.id)).toEqual(['ER-2']);
	});

	it('takes either run, each erratum once, in the list’s order', () => {
		const runs = [
			{ engineVersion: '2.1.0', fitEngineVersion: null },
			{ engineVersion: '1.2.0', fitEngineVersion: '1.2.0' }
		];
		expect(errataFoundSince([], runs, LIST).map((e) => e.id)).toEqual(['ER-1', 'ER-2', 'ER-3', 'ER-4']);
	});

	it('meets nothing for an engine outside every range or not a version (legacy)', () => {
		expect(errataFoundSince([], [{ engineVersion: '0.9.0', fitEngineVersion: null }], LIST)).toEqual([]);
		expect(errataFoundSince([], [{ engineVersion: 'legacy', fitEngineVersion: 'legacy' }], LIST)).toEqual([]);
		expect(errataFoundSince([], [], LIST)).toEqual([]);
	});
});
