// The focus through a hand-built Try again on the Calibration page (issue #586 R4-A, WCAG 2.4.3): the runs list's and
// the shown run's in CalibrationResults, and the calibration check's series. Each Try again takes its alert out of the
// page (a loading line replaces it), which dropped the focus on <body>. As the shared LoadState does
// (common/LoadState.svelte), the focus goes to the loading line while it loads, to the new Try again if it fails
// again, and to the heading of the panel round it once it has loaded (common/loadState.ts retryLanding).
import { retryLanding } from '#lib/components/common/loadState.js';

export type RetryState = 'loading' | 'failed' | 'loaded';

export class RetryFocus {
	/** Where Try again was (its alert's parent), set by its click and cleared once the focus is placed. */
	private from: Element | null = null;
	/** The Try again that was pressed: until a new one replaces it, the retry hasn't failed again yet. */
	private pressed: Element | null = null;

	/** Call from Try again's click, before starting the retry. */
	press(button: Element): void {
		this.pressed = button;
		this.from = button.closest('[role="alert"]')?.parentElement ?? button.parentElement;
	}

	/**
	 * Call from an $effect that reads the state and the elements, so it runs once the DOM shows the new state.
	 * `status`: the loading line (tabindex -1); `retry`: the Try again drawn now, if any.
	 */
	follow(state: RetryState, status: HTMLElement | null | undefined, retry: HTMLElement | null | undefined): void {
		if (!this.from) return;
		if (state === 'loading') {
			if (status?.isConnected) status.focus();
			return;
		}
		if (state === 'failed') {
			if (!retry?.isConnected || retry === this.pressed) return;
			this.from = this.pressed = null;
			retry.focus();
			return;
		}
		const from = this.from;
		this.from = this.pressed = null;
		retryLanding(from)?.focus();
	}
}
