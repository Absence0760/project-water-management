// A decided application's licence in words (227_licence_terms,
// 228_decision_events, issue #523 G3/G4; docs/ui.md § Applications): whether
// it counts in cumulative assessments now and on which terms, what an open
// appeal changes (nothing, until it is decided), and which event can be
// recorded next. The server holds every rule (app_scenario_licence and the
// decision_event guard); this only says them.
import { DECISION_EVENT_FORUM_LABEL, DECISION_EVENT_LABEL, type DecisionEvent, type DecisionEventForum, type DecisionEventKind, type LicenceTerms, type Scenario } from '#lib/api/types.js';
import { fmtDay } from '#lib/format/number.js';

/** "Water Tribunal, 5 Oct 2026": where and when an event happened. */
export const eventWhere = (e: Pick<DecisionEvent, 'forum' | 'eventDate'>) => `${DECISION_EVENT_FORUM_LABEL[e.forum]}, ${fmtDay(e.eventDate)}`;

/** The terms a licence in force counts on: its decision's, or the newest variation's; null when none is in force. */
export function licensedTerms(s: Pick<Scenario, 'licence' | 'grantedTerms' | 'decisionEvents'>): LicenceTerms | null {
	if (!s.licence?.inForce) return null;
	if (s.licence.from === 'decision') return s.grantedTerms ?? null;
	return s.decisionEvents?.find((e) => e.id === s.licence!.eventId)?.terms ?? null;
}

/**
 * Where the licence stands, one sentence: counting on its granted terms (or a
 * variation's), set aside, or no licence at all; and, with an appeal open,
 * that nothing changes until it is decided. null until decided with an outcome.
 */
export function licenceLine(s: Pick<Scenario, 'licence' | 'decisionEvents' | 'outcome'>): string | null {
	const l = s.licence;
	if (!l) return null;
	const events = s.decisionEvents ?? [];
	const from = l.from === 'event' ? events.find((e) => e.id === l.eventId) : undefined;
	let line: string;
	if (l.inForce)
		line = from
			? `The licence counts in cumulative assessments on the terms it was varied to (${eventWhere(from)}).`
			: 'The licence counts in cumulative assessments on its granted terms, not the changes applied for.';
	else if (from) line = `Set aside (${eventWhere(from)}): it no longer counts in cumulative assessments.`;
	else line = 'No licence was issued, so it doesn’t count in cumulative assessments.';
	const open = events.at(-1);
	if (l.appealPending && open?.kind === 'lodged')
		line += ` An appeal is lodged with the ${DECISION_EVENT_FORUM_LABEL[open.forum]}: nothing changes until it is decided.`;
	return line;
}

/**
 * What can be recorded next, as the server's guard allows it: an appeal
 * lodged (in either forum) after the decision or an earlier appeal's outcome;
 * while one is open, its outcome only, in the forum it was lodged with.
 */
export function nextEvents(events: readonly DecisionEvent[]): { kinds: DecisionEventKind[]; forum: DecisionEventForum | null } {
	const last = events.at(-1);
	if (last?.kind === 'lodged') return { kinds: ['upheld', 'set_aside', 'varied'], forum: last.forum };
	return { kinds: ['lodged'], forum: null };
}

/** The earliest date the next event may carry: the previous event's, else the decision letter's (YYYY-MM-DD); null when neither is known. */
export function earliestEventDate(s: Pick<Scenario, 'decisionEvents' | 'decisionDate'>): string | null {
	return s.decisionEvents?.at(-1)?.eventDate ?? s.decisionDate ?? null;
}

/** An event's heading: "Appeal lodged: Water Tribunal, 2 Oct 2026". */
export const eventHeading = (e: DecisionEvent) => `${DECISION_EVENT_LABEL[e.kind]}: ${eventWhere(e)}`;

/**
 * The background run of a licence's terms (293_scenario_run_job), where the
 * **Run the licensed terms** button is: what it is doing, whether to look
 * again soon (`busy`), and whether the button shows. While the job waits or
 * runs the button is hidden (pressing it would make the same run twice).
 * After a failure the button is back, with why. A finished job, or a failed
 * one some run of the scenario has followed, says nothing. null: nothing to
 * say (no licence in force, or no job).
 */
export function licensedRunState(
	s: Pick<Scenario, 'licence' | 'grantedTerms' | 'decisionEvents' | 'licensedRunJob' | 'lastRun'>
): { text: string; busy: boolean; showButton: boolean } | null {
	const job = s.licensedRunJob;
	if (!licensedTerms(s) || !job) return null;
	const why = job.error ? `: ${job.error}` : '';
	switch (job.status) {
		case 'queued':
			return { text: 'Queued: the licensed terms run in the background, so the evidence report counts this licence. Nothing to press.', busy: true, showButton: false };
		case 'running':
			return { text: 'Running the licensed terms in the background…', busy: true, showButton: false };
		case 'failed':
			return { text: `The background run of the licensed terms failed and will try again${why}.`, busy: true, showButton: true };
		case 'dead': {
			const ranSince = s.lastRun && job.finishedAt && Date.parse(s.lastRun.createdAt) > Date.parse(job.finishedAt);
			return ranSince ? null : { text: `The background run of the licensed terms failed${why}. Run them here.`, busy: false, showButton: true };
		}
		case 'done':
			return null;
	}
}
