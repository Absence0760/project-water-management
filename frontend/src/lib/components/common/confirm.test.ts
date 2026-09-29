import { describe, expect, it } from 'vitest';
import { answerConfirm, confirmDialog, confirmQueue } from './confirm.svelte';

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
});
