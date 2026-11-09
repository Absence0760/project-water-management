import { describe, expect, it } from 'vitest';
import { answerConfirm, confirmDialog, confirmQueue, confirmWithOption } from './confirm.svelte';

describe('confirmDialog', () => {
	it('queues questions in order and resolves each with its answer', async () => {
		const a = confirmDialog({ title: 'A?' });
		const b = confirmDialog({ title: 'B?', danger: true });
		expect(confirmQueue.items.map((r) => r.title)).toEqual(['A?', 'B?']);
		answerConfirm(confirmQueue.items[0]!.id, true);
		expect(confirmQueue.items.map((r) => r.title)).toEqual(['B?']);
		answerConfirm(confirmQueue.items[0]!.id, false);
		expect(await a).toBe(true);
		expect(await b).toBe(false);
		expect(confirmQueue.items).toEqual([]);
	});
	it('an unknown id changes nothing', () => {
		void confirmDialog({ title: 'C?' });
		answerConfirm(-1, true);
		expect(confirmQueue.items).toHaveLength(1);
		answerConfirm(confirmQueue.items[0]!.id, false);
	});
	it('a question with an option answers whether it was ticked, never ticked when cancelled', async () => {
		const option = { label: 'Also replace theirs', items: ['B: typed 700 mm → 790 mm'] };
		const a = confirmWithOption({ title: 'A?', option });
		const b = confirmWithOption({ title: 'B?', option });
		const c = confirmWithOption({ title: 'C?', option });
		expect(confirmQueue.items[0]!.option).toEqual(option);
		answerConfirm(confirmQueue.items[0]!.id, true);
		answerConfirm(confirmQueue.items[0]!.id, true, true);
		answerConfirm(confirmQueue.items[0]!.id, false, true);
		expect(await a).toEqual({ ok: true, option: false });
		expect(await b).toEqual({ ok: true, option: true });
		expect(await c).toEqual({ ok: false, option: false });
	});
});
