// The demo applicant's application (WP-3.3, docs/run-locally.md): what
// `pnpm seed:examples` submits for applicant@example.com on Sandspruit. Pure,
// so a unit test checks it against the evidence report's river checks
// (evidence-10, docs/evidence-pack.md § What stops issue on the river)
// without a database.
import type { ScenarioOp } from '@water-management/engine';

/** The farm the demo applicant owns and applies for. */
export const APPLICATION_FARM = 'Klipdrift';

/** Its name, description and the ops: double the dam, and keep the EWR in the river before River to dam fills it, as a new licence would require. */
export function applicationOf(nodeId: string, damCapacityM3: number): { name: string; description: string; ops: ScenarioOp[] } {
	return {
		name: `Raise the ${APPLICATION_FARM} dam`,
		description: 'Demo application: double the farm dam, keeping the EWR in the river before River to dam fills it (invented).',
		ops: [
			{ op: 'node.set', nodeId, field: 'damCapacityM3', value: damCapacityM3 * 2 },
			// Klipdrift fills its dam from the river (River to dam, every month): the licence's hands-off condition.
			{ op: 'node.set', nodeId, field: 'handsOffEwr', value: true }
		]
	};
}
