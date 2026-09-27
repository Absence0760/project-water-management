// The Scenarios section header's context line (issue #17): how many
// scenarios, how many in each status (drafts first, the order they move
// through), and how many have results, so the header says what the list
// holds before anyone reads it. Zero counts are left out.
import type { Scenario, ScenarioStatus } from '$lib/api';

const ORDER: { status: ScenarioStatus; one: string; many: string }[] = [
	{ status: 'draft', one: 'draft', many: 'drafts' },
	{ status: 'submitted', one: 'submitted', many: 'submitted' },
	{ status: 'withdrawn', one: 'withdrawn', many: 'withdrawn' },
	{ status: 'decided', one: 'decided', many: 'decided' }
];

export function scenariosSummary(list: readonly Pick<Scenario, 'status' | 'lastRun'>[]): string {
	if (!list.length) return 'No scenarios yet';
	const parts = [`${list.length} scenario${list.length === 1 ? '' : 's'}`];
	for (const { status, one, many } of ORDER) {
		const n = list.filter((s) => s.status === status).length;
		if (n) parts.push(`${n} ${n === 1 ? one : many}`);
	}
	const run = list.filter((s) => s.lastRun).length;
	parts.push(run ? `${run} with results` : 'none run yet');
	return parts.join(' · ');
}
