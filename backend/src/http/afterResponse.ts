// Work that must finish after a response has gone (issue #610): the
// assistant charges a turn's tokens once the turn ends, the client gone
// included. The Node server keeps running, so it would finish anyway; a
// Lambda can be frozen as soon as its handler settles, which for a streamed
// response is when the client disconnects. lambdaStream.ts waits for
// settleAfterResponse() before it returns, so the charge isn't lost.

const pending = new Set<Promise<unknown>>();

/** Keep `work` running past the response: the Lambda handler waits for it. Its rejection is the caller's to handle. */
export function afterResponse(work: Promise<unknown>): void {
	pending.add(work);
	void work.then(
		() => pending.delete(work),
		() => pending.delete(work)
	);
}

/** Wait until every afterResponse() work has settled, also work registered while waiting. */
export async function settleAfterResponse(): Promise<void> {
	while (pending.size) await Promise.allSettled([...pending]);
}
