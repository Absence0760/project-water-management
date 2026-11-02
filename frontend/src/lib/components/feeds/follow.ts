// Following a queued fetch (issue #586 Round 4): after "Run now" the Data
// feeds panel re-reads the feed list on its own until the fetch has run, then
// says how it went, instead of waiting for the reader to press Refresh status.
// A fetch has run once the feed's lastAttemptAt moves: only a recorded result
// sets it (app_record_feed_result / app_record_feed_checked), in production
// when the fetcher's answer comes back, not when the worker hands it over.
//
// The poller is plain timers, so its schedule, its cap and its pause while
// the page is hidden are unit-tested with fake timers (follow.test.ts).
import { describeTarget, type FeedMeta } from './feeds';

/**
 * The waits between polls: every 2 s for the first 10 s (the local worker
 * answers in a second or two), then every 5 s, then every 10 s, then every
 * 30 s, five minutes in all (a production fetch went through the fetcher
 * Lambda in ~35 s, but one that waits its turn at a throttled source, CHC's
 * one request a second shared with the copy's passes, can take minutes).
 * After the last, the panel stops and says Refresh status will show it.
 */
export const FOLLOW_DELAYS_MS: readonly number[] = [
	...Array<number>(5).fill(2_000),
	...Array<number>(10).fill(5_000),
	...Array<number>(6).fill(10_000),
	...Array<number>(6).fill(30_000)
];

/** What became of a followed fetch: still waiting, run (ok or failed), or the feed is gone or switched off. */
export type FetchOutcome = 'waiting' | 'done' | 'failed' | 'gone';

/** `f` (the feed now, or undefined when it left the list) against its lastAttemptAt when Run now was pressed. */
export function fetchOutcome(before: string | null, f: Pick<FeedMeta, 'enabled' | 'lastAttemptAt' | 'consecutiveFailures'> | undefined): FetchOutcome {
	if (!f || !f.enabled) return 'gone';
	if (f.lastAttemptAt === before) return 'waiting';
	return f.consecutiveFailures > 0 ? 'failed' : 'done';
}

/**
 * The live region's words for a fetch that has run: "Fetch done: <series>.
 * <its health>" or "Fetch failed: <series>: <why>. <when it tries again>".
 * `health` and `nextTry` are the row's own sentences (feeds.ts), so the
 * announcement says what the row now shows.
 */
export function outcomeMessage(
	outcome: 'done' | 'failed',
	f: Pick<FeedMeta, 'targetKind' | 'targetName' | 'lastError'>,
	health: string,
	nextTry: string | null
): string {
	if (outcome === 'done') return `Fetch done: ${describeTarget(f)}. ${health}`;
	return `Fetch failed: ${describeTarget(f)}: ${f.lastError ?? 'unknown error'}.${nextTry ? ` ${nextTry}` : ''}`;
}

/** How often the panel goes on re-reading the list after the schedule while the server reports a fetch under way. */
export const FOLLOW_TAIL_MS = 30_000;

export const STILL_WAITING = 'The fetch is still waiting to run. Refresh status will show it once it has.';

/** Where a card's Run now stands, as the panel saw it: queued (followed), run (done or failed), or still waiting when the follow gave up. */
export type CardFetchState = 'queued' | 'done' | 'failed' | 'slow';

/**
 * The line on the card that was run (its `data-fetch`): the press's feedback
 * sits on the card, not only in the section's status line. `created` is the
 * run-now answer's (false: a fetch was already waiting, and this press joined it).
 */
export function cardFetchNote(state: CardFetchState, created = true): string {
	switch (state) {
		case 'queued':
			return created
				? 'Fetch queued: it waits for the background worker, and this card updates by itself once it has run.'
				: 'A fetch for this feed was already waiting to run: this card updates by itself once it has.';
		case 'done':
			return 'Fetch done.';
		case 'failed':
			return 'Fetch failed: the line above says why.';
		case 'slow':
			return STILL_WAITING;
	}
}

/** What the live region says when Run now has queued (or joined) a fetch, naming the feed. */
export function queuedMessage(f: Pick<FeedMeta, 'targetKind' | 'targetName'>, created: boolean): string {
	return created
		? `Fetch queued: ${describeTarget(f)}. Its card updates by itself once the fetch has run.`
		: `A fetch for ${describeTarget(f)} is already waiting to run. Its card updates by itself once it has.`;
}

export interface PollerOptions {
	/** One poll; resolves true to keep following, false when nothing is left to follow. */
	poll: () => Promise<boolean>;
	/** The cap ran out with something still followed. */
	onGiveUp: () => void;
	delays?: readonly number[];
	/**
	 * After the schedule (and onGiveUp), go on every `tailMs` while `poll` says
	 * there is more: what the server itself reports under way (a backfill's
	 * windows) is followed for as long as it lasts. Unset: stop at the cap.
	 */
	tailMs?: number;
	/** Whether the page is hidden now (document.hidden); a hidden page isn't polled. */
	hidden?: () => boolean;
}

/**
 * A poller that runs `poll` on FOLLOW_DELAYS_MS's schedule (then every
 * `tailMs`, when set). start() (again)
 * restarts the schedule; pause() while the page is hidden and resume() when it
 * shows again (one poll at once, the schedule going on from where it was);
 * stop() for good (the panel unmounting). Polls never overlap.
 */
export function createPoller(o: PollerOptions) {
	const delays = o.delays ?? FOLLOW_DELAYS_MS;
	const hidden = o.hidden ?? (() => false);
	let step = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active = false;
	let polling = false;
	let stopped = false;
	let gaveUp = false;

	const clear = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	const schedule = () => {
		clear();
		if (!active || stopped || polling || hidden()) return;
		if (step >= delays.length) {
			if (!gaveUp) {
				gaveUp = true;
				o.onGiveUp();
			}
			if (o.tailMs === undefined) active = false;
			else timer = setTimeout(() => void run(), o.tailMs);
			return;
		}
		timer = setTimeout(() => void run(), delays[step++]);
	};
	async function run() {
		timer = null;
		if (!active || stopped || polling) return;
		polling = true;
		let more = true;
		try {
			more = await o.poll();
		} catch {
			// A failed poll is just a poll that learnt nothing: the schedule goes on.
		}
		polling = false;
		if (!more) active = false;
		schedule();
	}

	return {
		start() {
			if (stopped) return;
			active = true;
			step = 0;
			gaveUp = false;
			schedule();
		},
		pause: clear,
		resume() {
			if (!active || stopped || timer !== null || polling) return;
			void run();
		},
		stop() {
			stopped = true;
			active = false;
			clear();
		},
		get active() {
			return active;
		}
	};
}
