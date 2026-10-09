// "Send again (in N s)" for an emailed two-step sign-in code (206; docs/ui.md
// § Account → Two-step sign-in, the sign-in page's code step and the fresh
// code dialog): the server allows a send a minute after the last (429
// mfa_email_wait with the seconds otherwise), so the button counts down the
// seconds it gave and is disabled until then. Holds no words.

export interface ResendTimer {
	/** Whole seconds until the next send may go; 0 when it may. */
	readonly left: number;
	/** Start (or restart) the count from `seconds`. */
	start(seconds: number): void;
	/** Stop the count (the component went away). */
	stop(): void;
}

/** A countdown in whole seconds, from the clock (`now`, for tests), not by counting ticks: a throttled background tab still ends on time. */
export function resendTimer(now: () => number = Date.now): ResendTimer {
	let until = $state(0);
	let tick = $state(0);
	let handle: ReturnType<typeof setInterval> | null = null;
	const stop = () => {
		if (handle !== null) clearInterval(handle);
		handle = null;
	};
	return {
		get left() {
			void tick;
			return Math.max(0, Math.ceil((until - now()) / 1000));
		},
		start(seconds: number) {
			stop();
			until = now() + Math.max(0, seconds) * 1000;
			tick++;
			handle = setInterval(() => {
				tick++;
				if (now() >= until) stop();
			}, 1000);
		},
		stop
	};
}
