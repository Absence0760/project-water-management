<!--
	Validation signatures (RunSummary.plausibility.signatures, engine ≥ 1.55.0;
	docs/model.md §2.10d "Validation signatures"): the base-flow index by the
	Hughes et al. (2003) and Eckhardt (2005) filters, the low-flow FDC's slope
	and volume bias, and the skill on held-out recession segments, of the
	scored record against the simulated outflow on the same days. Part of the
	Plausibility checks panel.
-->
<script lang="ts">
	import type { ValidationSignatures } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { holdoutText, scoredRecordText, signatureRows, signaturesOk } from './signatures';

	let { signatures }: { signatures: ValidationSignatures | null } = $props();

	const uid = $props.id();
	const rows = $derived(signatures ? signatureRows(signatures) : []);
	const ok = $derived(signaturesOk(signatures));
	const days = $derived(signatures?.lowFlowFdc?.days ?? signatures?.baseflow?.days ?? null);
</script>

<h4 id="{uid}-h">Validation signatures <HelpTip key="plausibility-signatures" /></h4>
{#if signatures}
	<p class="small">
		On {scoredRecordText(signatures)} (the record the calibration statistics score){days === null ? '' : `, ${fmtNum(days)} days`}, against the simulated
		outflow on the same days. Base-flow index and the low-flow curve need a year of scored days. The limits are provisional, for the hydrologist to confirm.
	</p>
	<p class="flag {ok === null ? 'none' : ok ? 'good' : 'bad'}" role="status">
		{ok === null ? 'Not judged: too few scored days or recession segments.' : ok ? 'Every signature is within its limit.' : 'A signature is outside its limit: see the run’s warnings.'}
	</p>
	<div class="table-wrap">
		<table class="data compact" aria-labelledby="{uid}-h" data-testid="validation-signatures">
			<thead>
				<tr>
					<th scope="col">Signature</th>
					<th scope="col" class="num">Observed</th>
					<th scope="col" class="num">Simulated</th>
					<th scope="col" class="num">Difference or bias</th>
					<th scope="col" class="num">Provisional limit</th>
					<th scope="col">Result</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.label)}
					<tr class:short-row={r.ok === false}>
						<th scope="row">{r.label}</th>
						<td class="num">{r.observed}</td>
						<td class="num">{r.simulated}</td>
						<td class="num">{r.difference}</td>
						<td class="num">{r.limit}</td>
						<td>{r.ok === null ? 'not judged' : r.ok ? 'within' : 'outside'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="muted small">{holdoutText(signatures)}</p>
{:else}
	<p class="muted small">Not computed: needs an observed flow record.</p>
{/if}

<style>
	h4 {
		margin: 1.25rem 0 0.35rem;
	}
	.flag {
		padding: 0.4rem 0.65rem;
		border-radius: var(--radius, 6px);
		border-left: 4px solid var(--border-strong);
		background: var(--surface-2);
		font-size: 0.85rem;
	}
	.flag.good {
		border-left-color: var(--success);
	}
	.flag.bad {
		border-left-color: var(--danger);
	}
	tr.short-row {
		background: var(--row-flag);
	}
</style>
