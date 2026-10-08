<script lang="ts">
	// Settings → Seasonal outlook (issue #53 R5, docs/ui.md § Seasonal
	// outlook): the season a new outlook runs (a decision date and a season
	// end, as a month and day), the planning share and the review date (R6,
	// the review triggers' day). Part of the Settings
	// form (the save bar saves it), in the Settings tab's chunk. No model input. The defaults are the engine's, confirmed by
	// the client (plan.md O3, O6, issue #90).
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { DEFAULT_OUTLOOK_SEASON, DEFAULT_PLANNING_SHARE, defaultReviewDate } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { monthName } from '$lib/format/months';
	import type { OutlookSettings } from '$lib/api/types';

	let { value = $bindable(), readonly, error }: { value: OutlookSettings; readonly: boolean; error: string | null } = $props();

	const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
	const d = DEFAULT_OUTLOOK_SEASON;
	const day = (m: number, dd: number) => `${dd} ${monthName(m)}`;
	const defaultSeason = `${day(d.startMonth, d.startDay)} – ${day(d.endMonth, d.endDay)}`;
	const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;

	function useDefaultSeason(on: boolean) {
		value.season = on ? null : { ...DEFAULT_OUTLOOK_SEASON };
	}
	/** The default review date for the season set (or the default one), as a month and day: the engine's rule, in a common year. */
	const defaultReview = $derived.by(() => {
		const s = value.season ?? DEFAULT_OUTLOOK_SEASON;
		const crosses = s.endMonth < s.startMonth || (s.endMonth === s.startMonth && s.endDay < s.startDay);
		const iso = (y: number, m: number, dd: number) => `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		try {
			const r = defaultReviewDate({ decisionDate: iso(2001, s.startMonth, s.startDay), seasonEnd: iso(crosses ? 2002 : 2001, s.endMonth, s.endDay) });
			return { month: Number(r.slice(5, 7)), day: Number(r.slice(8, 10)) };
		} catch {
			return null;
		}
	});
	function useDefaultReview(on: boolean) {
		value.review = on ? null : (defaultReview ?? { month: 1, day: 1 });
	}
	function useDefaultShare(on: boolean) {
		value.planningShare = on ? null : DEFAULT_PLANNING_SHARE;
	}
</script>

<section class="panel" aria-labelledby="outlook-set-h-t" data-testid="outlook-settings">
	<div class="panel-head">
		<h2 id="outlook-set-h"><span id="outlook-set-h-t">Seasonal outlook</span> <HelpTip key="seasonal-outlook" /></h2>
		<span class="muted small">The season the Runs tab’s outlook runs, its planning share and its review date</span>
	</div>
	<fieldset class="group">
		<legend>
			Season <HelpTip key="outlook-season" />
		</legend>
		<label class="check">
			<input type="checkbox" disabled={readonly} checked={!value.season} onchange={(e) => useDefaultSeason(e.currentTarget.checked)} />
			Use the default season ({defaultSeason})
		</label>
		{#if value.season}
			<div class="fields">
				<div class="field">
					<label for="outlook-start-m">Decision date: month</label>
					<select id="outlook-start-m" disabled={readonly} bind:value={value.season.startMonth}>
						{#each MONTHS as m (m)}<option value={m}>{monthName(m)}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="outlook-start-d">Decision date: day</label>
					<NumberInput id="outlook-start-d" min={1} max={31} step={1} disabled={readonly} bind:value={value.season.startDay} />
				</div>
				<div class="field">
					<label for="outlook-end-m">Season end: month</label>
					<select id="outlook-end-m" disabled={readonly} bind:value={value.season.endMonth}>
						{#each MONTHS as m (m)}<option value={m}>{monthName(m)}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="outlook-end-d">Season end: day</label>
					<NumberInput id="outlook-end-d" min={1} max={31} step={1} disabled={readonly} bind:value={value.season.endDay} />
				</div>
			</div>
		{/if}
		<p class="hint">
			The decision date is the season’s first day: the outlook starts from the run’s state at the end of the day before, the latest such date the
			run reaches. The season ends on the end date (the next one after the decision date).
		</p>
	</fieldset>
	<fieldset class="group">
		<legend>
			Planning share <HelpTip key="planning-figure" />
		</legend>
		<label class="check">
			<input type="checkbox" disabled={readonly} checked={value.planningShare === null} onchange={(e) => useDefaultShare(e.currentTarget.checked)} />
			Use the default planning share ({pct(DEFAULT_PLANNING_SHARE)})
		</label>
		{#if value.planningShare !== null}
			<div class="field">
				<label for="outlook-share">Planning share <span class="u">(% of analogue years)</span></label>
				<NumberInput id="outlook-share" decimals={1} min={0} max={100} scale={100} disabled={readonly} bind:value={value.planningShare} />
			</div>
		{/if}
		<p class="hint">
			The outlook names the highest demand level that met the river’s requirement in at least this share of past years. It reports that trade-off; the
			WUA decides the level.
		</p>
	</fieldset>
	<fieldset class="group">
		<legend>Review date <HelpTip key="review-triggers" /></legend>
		<label class="check">
			<input type="checkbox" disabled={readonly} checked={!value.review} onchange={(e) => useDefaultReview(e.currentTarget.checked)} />
			Use the default review date{defaultReview ? ` (${day(defaultReview.month, defaultReview.day)})` : ''}
		</label>
		{#if value.review}
			<div class="fields">
				<div class="field">
					<label for="outlook-review-m">Review date: month</label>
					<select id="outlook-review-m" disabled={readonly} bind:value={value.review.month}>
						{#each MONTHS as m (m)}<option value={m}>{monthName(m)}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="outlook-review-d">Review date: day</label>
					<NumberInput id="outlook-review-d" min={1} max={31} step={1} disabled={readonly} bind:value={value.review.day} />
				</div>
			</div>
		{/if}
		<p class="hint">
			The day in the season the WUA reads its dams and reviews the level. Each outlook also draws review triggers for it: for each band of dam storage
			on that day, the highest demand level that met the river’s requirement in at least the planning share of past years.
		</p>
	</fieldset>
	{#if error}<p class="err" role="alert">{error}</p>{/if}
</section>

<style>
	.group {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.75rem 0.25rem;
		margin: 0.75rem 0 0;
	}
	.group legend {
		font-weight: 600;
		padding: 0 0.25rem;
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 1.25rem;
	}
	.check {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		margin: 0.25rem 0;
	}
	.hint {
		display: block;
		font-size: 0.8rem;
	}
	.err {
		color: var(--danger);
	}
</style>
