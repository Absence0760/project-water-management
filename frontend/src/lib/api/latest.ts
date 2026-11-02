// The request sequencer (docs/architecture.md § Stale responses): a page that
// asks again (another project, a refresh, Try again, a pasted link) while its
// last request is still out must never let that earlier answer land over the
// newer one. Two forms of one rule, latest wins:
//
// - `latestCall(load)` wraps a loader, so a call site in a `.ts` module can
//   be tested with a fake loader: an earlier call that comes back later
//   answers `{ current: false }`, and so does its failure.
// - `latestOnly()` hands out checks, for a step of several awaits written in
//   place: each `begin()` returns a check that stays true until a later
//   `begin()`.
//
// Reading a picked file has its own, files/latest.ts latestFileText.

/**
 * A guard against stale responses: each `begin()` starts a new request and
 * returns a check that stays true only while no later request has begun. A
 * page that loads on navigation applies an answer only when its check is
 * still true, so a slow first lookup can't overwrite a later one.
 */
export function latestOnly(): { begin: () => () => boolean } {
	let seq = 0;
	return {
		begin() {
			const mine = ++seq;
			return () => mine === seq;
		}
	};
}

/** What a sequenced call answers: its value while it is the latest call, else only that it was superseded. */
export type Latest<R> = { current: true; value: R } | { current: false };

/**
 * Wraps a loader so only its latest call's answer counts: an earlier call that
 * comes back later answers `{ current: false }`, whether it succeeded or
 * failed (a superseded failure is no longer news). The latest call's failure
 * is thrown.
 */
export function latestCall<A extends unknown[], R>(load: (...args: A) => Promise<R>): (...args: A) => Promise<Latest<R>> {
	const latest = latestOnly();
	return async (...args: A) => {
		const current = latest.begin();
		let value: R;
		try {
			value = await load(...args);
		} catch (e) {
			if (!current()) return { current: false };
			throw e;
		}
		return current() ? { current: true, value } : { current: false };
	};
}
