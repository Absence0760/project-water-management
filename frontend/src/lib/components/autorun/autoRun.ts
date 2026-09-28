// Automatic runs after new data (WP-2.11; backend runs/autoRun.ts,
// docs/ui.md § Automatic runs): the setting over its defaults, the header's
// "re-run queued for 14:05", and the Overview's "New auto run: publish?".
import type { AutoRunSettings, RunMeta } from '$lib/api/types';

/** The backend's defaults (runs/autoRun.ts AUTO_RUN_DEFAULTS). */
export const AUTO_RUN_DEFAULTS: Readonly<AutoRunSettings> = Object.freeze({ enabled: false, debounceMinutes: 15, publish: 'never' });
/** The longest debounce the API accepts, in minutes. */
export const AUTO_RUN_DEBOUNCE_MAX = 120;
/** However often data arrives, a queued re-run waits at most this long after the first of it. */
export const AUTO_RUN_MAX_WAIT_MINUTES = 120;

/** settings.autoRun over the defaults (an older API sends none). */
export function resolveAutoRun(settings: { autoRun?: Partial<AutoRunSettings> } | null | undefined): AutoRunSettings {
	return { ...AUTO_RUN_DEFAULTS, ...(settings?.autoRun ?? {}) };
}

/** Why the Settings group can't be saved, or null. */
export function autoRunError(a: AutoRunSettings): string | null {
	const d = a.debounceMinutes;
	if (!Number.isInteger(d) || d < 0 || d > AUTO_RUN_DEBOUNCE_MAX) return `The wait must be a whole number of minutes from 0 to ${AUTO_RUN_DEBOUNCE_MAX}.`;
	return null;
}

const pad = (x: number) => String(x).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The header's clause for a queued re-run, in the viewer's own time:
 * "an automatic re-run is queued for 14:05", "… for 27 Sep 14:05" on another
 * day, "… is due now" once its time has come (the worker picks it up within
 * minutes), or "… is queued" when the time isn't known.
 */
export function rerunQueuedText(queuedFor: string | null | undefined, now: Date = new Date()): string {
	const at = queuedFor ? new Date(queuedFor) : null;
	if (!at || Number.isNaN(at.getTime())) return 'an automatic re-run is queued';
	if (at.getTime() <= now.getTime()) return 'an automatic re-run is due now';
	const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
	const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
	return `an automatic re-run is queued for ${sameDay ? time : `${at.getDate()} ${MONTHS[at.getMonth()]} ${time}`}`;
}

/**
 * The auto run an editor is asked to publish (Overview, "New auto run:
 * publish?"): the newest auto run, when it is newer than the published run
 * and isn't the published run itself. Null otherwise, and while nothing is
 * published (the first publication is chosen in the Runs tab). `runs` newest
 * first, as the API lists them.
 */
export function autoRunToPublish(runs: readonly RunMeta[] | null | undefined, publishedRunId: string | null | undefined): RunMeta | null {
	if (!runs || !publishedRunId) return null;
	const latestAuto = runs.find((r) => r.trigger === 'auto');
	if (!latestAuto || latestAuto.id === publishedRunId) return null;
	const published = runs.find((r) => r.id === publishedRunId);
	return !published || latestAuto.createdAt > published.createdAt ? latestAuto : null;
}
