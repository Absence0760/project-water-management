import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api/index.js', () => ({ api: {} }));

import { startDataLoader, type StartDataRead } from './startDataLoad';

const readOf = (kinds: string[]): StartDataRead => ({ settings: null, feeds: [], series: kinds.map((kind) => ({ kind, length: 1 })) });

describe('startDataLoader (the Map’s data step, read again after each change)', () => {
	it('drops the read from before a change when it answers after the read from after it', async () => {
		const answers: ((r: StartDataRead) => void)[] = [];
		const read = startDataLoader(() => new Promise((res) => answers.push(res)));
		const before = read('p');
		const after = read('p');
		answers[1]!(readOf(['rain_catchment_mm']));
		expect(await after).toEqual({ current: true, value: readOf(['rain_catchment_mm']) });
		answers[0]!(readOf([]));
		expect(await before).toEqual({ current: false });
	});
});
