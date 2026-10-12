// A scenario on a base run from before migration 220 (issue #523 B4): that
// run kept water for the EWR in its baseline, and its recorded input is
// reproduced as it is, so the scenario runs with those rules without an op of
// its own. The scenario page lists them (ScenarioCheck.baseEwrRules) so the
// comparison isn't read as "the EWR kept by this scenario".

/** The note's lead line for `n` rules. */
export function baseEwrRulesLead(n: number): string {
	const rules = n === 1 ? 'a rule that keeps' : `${n} rules that keep`;
	return `The base run carries ${rules} water for the EWR, from before the baseline stopped keeping it (it is now assessed and reported only). This scenario runs with ${n === 1 ? 'it' : 'them'} without a change of its own, so its comparison with the base isn't the EWR being kept by this scenario. Base the scenario on a newer run to compare without ${n === 1 ? 'it' : 'them'}:`;
}
