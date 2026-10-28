<!--
	Settings field for settings.rainStations.unreliable on every rain record
	(engine ≥ 1.102.0, issue #611, docs/model.md §2.4i): date ranges in which
	one rain record can't be trusted, by its series id. A run reads those days
	as missing, so the record's next source stands in: a rainfall station's
	pairing CHIRPS, a unit's own CHIRPS (levelled) then its rule's next link,
	the alternative gauge's rain-source period's next source. A station's are
	read only while it is assigned. The catchment gauge's own days are the
	missing periods under Flagged zero runs (zeroRainRuns.missing), as before.
	One group of From/To rows a record; a record the setting names but the
	project no longer has shows as a deleted series. Its rows mirror
	common/PeriodList.svelte's layout without a reason (the setting keeps
	none). Bind `value` (the whole rainStations setting, kept tidy by
	flowGeneration tidyStations); `error` is set while a list is invalid.
-->
<script lang="ts">
	import type { RainStationSettings } from '@water-management/engine';
	import DayInput from '#lib/components/common/DayInput.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { localIsoDate } from '#lib/format/number.js';
	import { unreliableError, withUnlisted, withUnreliable, type RecordOption } from './recordPeriods';

	let {
		value = $bindable(),
		error = $bindable(null),
		records,
		readonly = false
	}: {
		value: RainStationSettings | null | undefined;
		error?: string | null;
		/** The project's rain records (recordPeriods.ts rainRecordOptions); null = not loaded yet. */
		records: RecordOption[] | null;
		readonly?: boolean;
	} = $props();

	const uid = $props.id();
	const shown = $derived(records ? withUnlisted(records, value?.unreliable) : []);
	const listOf = (id: string): [string, string][] => value?.unreliable?.[id] ?? [];

	$effect(() => {
		for (const r of shown) {
			const e = unreliableError(listOf(r.id));
			if (e) {
				error = `${r.label}: ${e}`;
				return;
			}
		}
		error = null;
	});

	const write = (id: string, list: [string, string][]) => (value = withUnreliable(value, id, list));
	function add(id: string) {
		// The month before the earliest listed, else last month by the viewer's own day: pressing twice never repeats a row.
		const list = listOf(id);
		const first = list.length ? list.map((p) => p[0]).sort()[0]! : localIsoDate();
		const [y, m] = first.split('-').map(Number) as [number, number];
		const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
		const mm = String(pm).padStart(2, '0');
		const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
		write(id, [...list, [`${py}-${mm}-01`, `${py}-${mm}-${String(last).padStart(2, '0')}`]]);
	}
	const set = (id: string, i: number, at: 0 | 1, v: string) => write(id, listOf(id).map((p, j) => (j === i ? ((at === 0 ? [v, p[1]] : [p[0], v]) as [string, string]) : p)));
	const remove = (id: string, i: number) => write(id, listOf(id).filter((_, j) => j !== i));
</script>

<div class="rr" role="group" aria-labelledby="{uid}-l" aria-describedby="{uid}-hint" data-testid="rain-record-periods">
	<div class="head">
		<span class="legend"><span id="{uid}-l">Unreliable periods of a rain record</span> <HelpTip key="settings.rainStations" label="Unreliable periods of a rain record" /></span>
	</div>
	<p class="hint explain" id="{uid}-hint">
		Days a rain record can’t be trusted. A run reads them as missing, so the record’s next source stands in, as on any gap. A rainfall station’s count while it is
		assigned; the catchment gauge’s own days are the missing periods under Flagged zero runs.
	</p>
	{#if records === null}
		<p class="muted small">Loading the rain records…</p>
	{:else if shown.length === 0}
		<p class="muted small">None to set: the project has no rain record yet.</p>
	{:else}
		<ul class="records">
			{#each shown as r (r.id)}
				{@const list = listOf(r.id)}
				<li class="record" data-testid="rain-record" data-series={r.id}>
					<div class="head">
						<span class="name" id="{uid}-n-{r.id}">{r.label}</span>
						{#if !readonly}<button type="button" class="btn btn-sm" aria-describedby="{uid}-n-{r.id}" onclick={() => add(r.id)}>Mark a period unreliable</button>{/if}
					</div>
					{#if list.length}
						<ol class="rows" aria-labelledby="{uid}-n-{r.id}">
							{#each list as p, i (i)}
								<li class="row">
									<div class="field">
										<label for="{uid}-{r.id}-s{i}">From</label>
										<DayInput id="{uid}-{r.id}-s{i}" {readonly} value={p[0]} onchange={(v) => set(r.id, i, 0, v)} />
									</div>
									<div class="field">
										<label for="{uid}-{r.id}-e{i}">To</label>
										<DayInput id="{uid}-{r.id}-e{i}" {readonly} value={p[1]} onchange={(v) => set(r.id, i, 1, v)} />
									</div>
									{#if !readonly}
										<button type="button" class="btn btn-icon" aria-label="Remove unreliable period {i + 1} of {r.label}" title="Remove" onclick={() => remove(r.id, i)}>✕</button>
									{/if}
								</li>
							{/each}
						</ol>
					{:else}
						<p class="muted small">None: every reading of this record is used.</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if error}<p class="err" role="alert">{error}.</p>{/if}
</div>

<style>
	.rr {
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		margin-bottom: 0.2rem;
	}
	.legend {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.name {
		font-size: var(--font-sm);
		color: var(--text-2);
	}
	.hint {
		font-size: var(--font-sm);
		color: var(--text-muted);
		max-width: 75ch;
		margin: 0 0 0.4rem;
	}
	.records,
	.rows {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.4rem;
	}
	.records {
		gap: 0.75rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.25rem 0.75rem;
	}
	.row .field {
		margin: 0;
	}
	.err {
		color: var(--danger);
		font-size: var(--font-sm);
	}
</style>
