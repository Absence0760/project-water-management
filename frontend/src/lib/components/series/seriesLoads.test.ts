import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api/index.js', () => ({ api: {} }));

import type { SeriesMeta } from '@water-management/engine';
import { seriesListLoader, seriesValuesLoader, type ValuesSink } from './seriesLoads';
import { forgetValues } from './valuesCache';

const meta = (id: string, updatedAt: string, length = 2) => ({ id, startDate: '2024-01-01', length, updatedAt }) as SeriesMeta;

describe('seriesListLoader (the Time series tab: Try again, a day edited)', () => {
	it('drops the earlier list when it answers after the later one', async () => {
		const answers: ((l: SeriesMeta[]) => void)[] = [];
		const list = seriesListLoader(() => new Promise((res) => answers.push(res)));
		const first = list('p');
		const second = list('p');
		answers[1]!([meta('s1', 'edited')]);
		expect(await second).toEqual({ current: true, value: [meta('s1', 'edited')] });
		answers[0]!([meta('s1', 'before')]);
		expect(await first).toEqual({ current: false });
	});
});

describe('seriesValuesLoader (each list change reads the values again)', () => {
	function sink() {
		const got: Record<string, (number | null)[]> = {};
		const failed: Record<string, string> = {};
		const s: ValuesSink = {
			retry: (id) => delete failed[id],
			value: (id, v) => (got[id] = v.values),
			failed: (id, m) => (failed[id] = m)
		};
		return { s, got, failed };
	}

	it('drops an earlier round’s values, and its failure, when they answer after a later round’s', async () => {
		const project = `p-${Math.random()}`;
		const pending: { res: (v: SeriesMeta & { values: number[] }) => void; rej: (e: unknown) => void }[] = [];
		const read = seriesValuesLoader(() => new Promise((res, rej) => pending.push({ res, rej })));
		const { s, got, failed } = sink();
		// Round 1 asks for s1 and s2 as they were; a day of s1 is edited and round 2 asks again.
		const round1 = read(project, [meta('s1', 'before'), meta('s2', 'before')], s);
		forgetValues(project, 's1');
		const round2 = read(project, [meta('s1', 'edited'), meta('s2', 'before')], s);
		pending[2]!.res({ ...meta('s1', 'edited'), values: [9, 9] });
		pending[3]!.res({ ...meta('s2', 'before'), values: [2, 2] });
		await round2;
		pending[0]!.res({ ...meta('s1', 'before'), values: [1, 1] });
		pending[1]!.rej(new Error('offline'));
		await round1;
		expect(got).toEqual({ s1: [9, 9], s2: [2, 2] });
		expect(failed).toEqual({});
	});

	it('a round on its own writes its values and failures', async () => {
		const project = `p-${Math.random()}`;
		const read = seriesValuesLoader(async (_p, id) => (id === 'bad' ? Promise.reject(new Error('gone')) : { ...meta(id, 'x'), values: [3, 4] }));
		const { s, got, failed } = sink();
		await read(project, [meta('ok', 'x'), meta('bad', 'x')], s);
		expect(got).toEqual({ ok: [3, 4] });
		expect(failed).toEqual({ bad: 'gone' });
	});
});
