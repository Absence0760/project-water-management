// answerAlike (issue #51, adversary finding 2): forgot-password and
// resend-confirmation must take the same time for a known and an unknown
// address, so the answer waits on one floor and never on the send. Driven by
// promises the test resolves itself, so nothing here depends on the clock.
import { describe, expect, it, vi } from 'vitest';
import type { Mail } from '../mail/transport.js';
import { answerAlike } from './accountMail.js';

const MAIL: Mail = { to: 'someone@example.com', subject: 'Reset your password', text: 't', html: '<p>t</p>' };

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => (open = resolve));
	return { promise, open };
}

/** Whether `p` has settled once pending callbacks have run. */
async function settled(p: Promise<unknown>): Promise<boolean> {
	let done = false;
	void p.then(() => (done = true));
	await new Promise((resolve) => setImmediate(resolve));
	return done;
}

describe('answerAlike', () => {
	it('answers when the floor opens, with a send that never finishes (a known address)', async () => {
		const floor = gate();
		const send = vi.fn(() => new Promise<boolean>(() => {}));
		const answer = answerAlike(async () => MAIL, { floor: floor.promise, send });
		expect(await settled(answer)).toBe(false);
		// The send started, but the answer isn't waiting on it.
		expect(send).toHaveBeenCalledWith(MAIL);
		floor.open();
		expect(await settled(answer)).toBe(true);
	});

	it('waits for the same floor when there is nothing to send (an unknown address)', async () => {
		const floor = gate();
		const send = vi.fn(async () => true);
		const answer = answerAlike(async () => null, { floor: floor.promise, send });
		expect(await settled(answer)).toBe(false);
		expect(send).not.toHaveBeenCalled();
		floor.open();
		expect(await settled(answer)).toBe(true);
	});

	it('never answers before the floor, even when the send is done at once', async () => {
		const floor = gate();
		const answer = answerAlike(async () => MAIL, { floor: floor.promise, send: async () => true });
		expect(await settled(answer)).toBe(false);
		floor.open();
		await answer;
	});

	it('keeps a failed send off the answer', async () => {
		const floor = gate();
		floor.open();
		await expect(answerAlike(async () => MAIL, { floor: floor.promise, send: () => Promise.reject(new Error('smtp down')) })).resolves.toBeUndefined();
	});

	it('throws what the lookup throws, sending nothing', async () => {
		const send = vi.fn(async () => true);
		await expect(answerAlike(() => Promise.reject(new Error('db down')), { floor: Promise.resolve(), send })).rejects.toThrow('db down');
		expect(send).not.toHaveBeenCalled();
	});
});
