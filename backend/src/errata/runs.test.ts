import type { Erratum } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { withErrata } from './runs.js';

const er = (id: string, keyedOn: 'run' | 'fit', firstAffected: string, fixedIn: string | null): Erratum => ({
	id,
	keyedOn,
	firstAffected,
	fixedIn,
	severity: 'High',
	appliesWhen: 'always',
	summary: 'wrong',
	source: 'x'
});
const LIST = [er('ER-1', 'run', '1.0.0', '1.2.0'), er('ER-2', 'fit', '1.1.0', null), er('ER-3', 'run', '1.1.0', '1.10.0')];

describe('withErrata (issue #103)', () => {
	it('lists the run errata whose range holds the run’s engine, numerically, in the list’s order', () => {
		expect(withErrata({ id: 'r', engineVersion: '1.1.5' }, LIST)).toEqual({ id: 'r', engineVersion: '1.1.5', errata: ['ER-1', 'ER-3'] });
		expect(withErrata({ engineVersion: '1.9.0' }, LIST).errata).toEqual(['ER-3']);
		expect(withErrata({ engineVersion: '1.10.0' }, LIST).errata).toEqual([]);
	});

	it('keys a fit erratum on the fit’s engine; a run with entered parameters has none', () => {
		expect(withErrata({ engineVersion: '2.0.0', fitEngineVersion: '1.1.0' }, LIST).errata).toEqual(['ER-2']);
		expect(withErrata({ engineVersion: '2.0.0', fitEngineVersion: null }, LIST).errata).toEqual([]);
		expect(withErrata({ engineVersion: '2.0.0' }, LIST).errata).toEqual([]);
	});

	it('a version that isn’t x.y.z matches nothing, and doesn’t throw', () => {
		expect(withErrata({ engineVersion: 'b023', fitEngineVersion: 'junk' }, LIST).errata).toEqual([]);
	});
});
