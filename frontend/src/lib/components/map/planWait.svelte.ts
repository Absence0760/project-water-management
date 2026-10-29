// A Start or Divide plan the background worker routes (#646 item 3,
// 272_plan_request; docs/ui.md § Map, docs/api.md § Start from the map): the
// sheet asks about it every POLL_MS until the job proposes the routed plan,
// refuses it or dies, as the Delineate sheet waits for a large click
// (DelineateSheet.svelte, delineation.ts). Shared by StartSheet and
// DivideSheet; the words are planWait.ts's.
import { ApiError } from '#lib/api/client.js';
import { api } from '#lib/api/index.js';
import type { PlanRequest } from '#lib/api/types.js';
import { afterPollError, POLL_MS } from './delineation';
import { isPlanWaiting } from './planWait';

/**
 * The waiting plan and its poll. `start` it with a request (a propose's answer, or the state's on opening); `settle` hears the
 * outcome once (proposed, refused, failed or superseded). Call `stop` when the sheet closes.
 */
export class PlanWait {
	waiting = $state<PlanRequest | null>(null);
	#timer: ReturnType<typeof setTimeout> | null = null;
	#failures = 0;
	readonly #projectId: () => string;
	readonly #settle: (r: PlanRequest) => Promise<void> | void;
	constructor(projectId: () => string, settle: (r: PlanRequest) => Promise<void> | void) {
		this.#projectId = projectId;
		this.#settle = settle;
	}

	start(r: PlanRequest | null | undefined): void {
		this.stop();
		if (!isPlanWaiting(r)) return;
		this.waiting = r;
		this.#arm(r.id);
	}

	stop(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.#failures = 0;
		this.waiting = null;
	}

	#arm(id: string): void {
		this.#timer = setTimeout(() => void this.#poll(id), POLL_MS);
	}

	async #poll(id: string): Promise<void> {
		let r: PlanRequest;
		try {
			r = (await api.start.request(this.#projectId(), id)).request;
		} catch (err) {
			if (this.waiting?.id !== id) return;
			this.#failures++;
			// A dropped connection or a 5xx says nothing about the job, which keeps running: ask again; give up after a few.
			if (afterPollError(this.#failures, err instanceof ApiError ? err.status : undefined) === 'retry') return this.#arm(id);
			const gone = this.waiting;
			this.stop();
			await this.#settle({ ...gone, status: 'failed', error: err instanceof Error ? err.message : String(err) });
			return;
		}
		if (this.waiting?.id !== id) return;
		this.#failures = 0;
		if (isPlanWaiting(r)) {
			this.waiting = r;
			return this.#arm(id);
		}
		this.stop();
		await this.#settle(r);
	}
}
