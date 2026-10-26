<!--
	Model settings → EWR the results are judged by (issue #444; "Judge results
	by" until issue #586 E14, plainer now): which EWR test the results are
	judged by, the first thing on the page. Bind `value` (settings.ewrHeadline).
	Changes no result: it decides which test the EWR page's headline tile (the
	Summary's card until issue #558), the run sentence, the printable report and
	the "days below" wording report.
	Without a rule table there is nothing to choose, so it says so instead.
	Helpers in $lib/components/ewr/headline.ts.
-->
<script lang="ts">
	import type { EwrChargeSource, EwrDailySource, EwrRuleTable, NetworkNode } from '@water-management/engine';
	import type { EwrHeadline } from '#lib/api/types.js';
	import { headlineKey, headlineOfKey, headlineOptions, headlineProblem, headlineTest, ruleTableSites } from '#lib/components/ewr/headline.js';
	import { JUDGE_HEADING } from './sections';

	let {
		value = $bindable(),
		ewrRules,
		ewrPragmatic,
		ewrDaily = null,
		chargeSource,
		nodes,
		readonly = false
	}: {
		value: EwrHeadline;
		/** The Reserve rule tables as the form has them: the sites on offer. */
		ewrRules: readonly Pick<EwrRuleTable, 'siteNodeId'>[];
		/** The pragmatic EWR as the form has it: offered only when some month is above 0. */
		ewrPragmatic: readonly number[];
		/** settings.ewrDailySource (engine ≥ 1.77.0): the daily test's source, which names the daily choice. */
		ewrDaily?: EwrDailySource | null;
		/** settings.ewrChargeSource, for the hint when the charge follows another test. */
		chargeSource?: EwrChargeSource;
		nodes: readonly NetworkNode[];
		readonly?: boolean;
	} = $props();

	const options = $derived(headlineOptions(nodes, ewrRules, ewrPragmatic, value, ewrDaily));
	const problem = $derived(headlineProblem(value, nodes, ewrRules, ewrPragmatic, ewrDaily));
	// Nothing to choose: no rule table, and no stored choice to show.
	const nothing = $derived(ruleTableSites(nodes, ewrRules).length === 0 && value.source === 'auto');
	// The charge, curtailment and water account follow settings.ewrChargeSource, a model input; this choice
	// only reads results. Said when the two differ (Automatic included), so a reader isn't left assuming one sets the other.
	const differs = $derived(ewrRules.length > 0 && headlineTest(value, nodes, ewrRules) !== (chargeSource ?? 'pragmatic'));
	const describedBy = $derived(['judge-hint', problem && 'judge-problem', differs && 'judge-charge'].filter(Boolean).join(' '));
</script>

<section class="panel judge" id="set-judge" aria-labelledby="judge-h">
	{#if nothing}
		<!-- In a .panel-head like every other panel's, so the line under it keeps the same gap (it ran into the
		     heading at 1440, issue #586 R4-B). -->
		<div class="panel-head">
			<h2 id="judge-h">{JUDGE_HEADING}</h2>
		</div>
		<!-- The panel's one line, at the summary line's size like the other panels' (issue #586, C16); the link named as the heading it goes to. -->
		<p class="summary" data-testid="judge-nothing">
			Results are judged by the pragmatic EWR at the outflow gauge. Add a Reserve rule table under <a href="#set-reserve">Reserve rule tables</a> to
			choose another test here.
		</p>
	{:else}
		<div class="row">
			<h2 id="judge-h"><label for="judge-pick">{JUDGE_HEADING}</label></h2>
			<select id="judge-pick" disabled={readonly} value={headlineKey(value)} onchange={(e) => (value = headlineOfKey(e.currentTarget.value))} aria-describedby={describedBy}>
				{#each options as o (o.key)}<option value={o.key}>{o.label}</option>{/each}
			</select>
		</div>
		<p class="hint muted explain" id="judge-hint">
			Which EWR the headline on the EWR page, the run sentence and the printable report are judged by. It changes no result: save it and no
			re-run is needed. The pragmatic EWR and the Reserve rule tables are set under <a href="#set-ewr">EWR</a> and
			<a href="#set-reserve">Reserve rule tables</a>.
		</p>
		{#if problem}<p class="alert alert-warning small" role="status" id="judge-problem" data-testid="judge-problem">{problem}</p>{/if}
		{#if differs}
			<p class="hint muted" id="judge-charge" data-testid="judge-charge-note">
				The daily EWR charge and curtailment follow {chargeSource === 'ruleTable' ? 'the rule tables' : 'the pragmatic EWR'} (Reserve rule tables → EWR charge follows), a different test.
			</p>
		{/if}
	{/if}
</section>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}
	h2 {
		margin: 0;
	}
	select {
		flex: 1 1 18rem;
		min-width: 0;
		max-width: 100%;
	}
	.hint {
		font-size: var(--font-sm);
		max-width: 75ch;
		margin: 0.5rem 0 0;
	}
	.alert {
		margin: 0.5rem 0 0;
	}
</style>
