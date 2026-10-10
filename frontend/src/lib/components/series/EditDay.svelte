<script lang="ts">
	// Edit a day (issue #477 (a)): set or clear one day of the charted series
	// by hand, under its chart. PUT …/series/:seriesId/days/:date goes through
	// the same merge as an upload (the history keeps the values before it), and
	// marks the day as edited by hand (212_series_hand_days), which the row,
	// the details and the chart show. Days outside the series come from Add
	// data (a file or pasted rows).
	import type { SeriesMeta } from '@water-management/engine';
	import { api } from '$lib/api';
	import type { SeriesWriteResult } from '$lib/api/types';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { feedMark } from '$lib/series/provenance';
	import { isHandDay, lastDay, readTypedValue, valueOn, type DailyValues } from '$lib/series/editDay';
	import { forgetValues } from './valuesCache';

	let {
		projectId,
		series,
		values,
		onsaved
	}: {
		projectId: string;
		series: SeriesMeta;
		/** The series' stored values (SeriesTab's); null while they load. */
		values: DailyValues | null;
		onsaved?: (meta: SeriesWriteResult) => void | Promise<void>;
	} = $props();

	const uid = $props.id();
	// A day's value as stored, up to 6 decimals and no trailing zeros: what was typed reads back as typed.
	const exact = (v: number) => fmtNum(v, 6, true);
	const id = (s: string) => `${uid}-${s}`;
	const end = $derived(lastDay(series));
	let date = $state('');
	let text = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);

	const stored = $derived(values && date ? valueOn(values, date) : undefined);
	const inRange = $derived(!!date && date >= series.startDate && date <= end);
	const typed = $derived(readTypedValue(text));
	// The stored value as the box shows it (rounded to 6 decimals) is no change either.
	const unchanged = $derived(typed.ok && stored !== undefined && (typed.value === stored || (stored !== null && text.trim() === exact(stored))));
	const edited = $derived(isHandDay(series.handDays, date));
	const fed = $derived(feedMark(series.feed));
	const disabled = $derived(saving || !values || !inRange || !typed.ok || unchanged || !!series.rebuilding);

	/** A day picked: its stored value in the box, ready to correct (blank for a gap). */
	function pick(next: string) {
		date = next;
		error = null;
		done = null;
		const v = values && next ? valueOn(values, next) : undefined;
		text = v === undefined || v === null ? '' : exact(v);
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (disabled || !typed.ok) return;
		saving = true;
		error = null;
		done = null;
		try {
			const meta = await api.series.setDay(projectId, series.id, date, typed.value);
			forgetValues(projectId, series.id);
			done = typed.value === null ? `Cleared ${date}.` : `Saved ${date}: ${exact(typed.value)} ${series.unit}.`;
			await onsaved?.(meta);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<div class="edit-day" role="group" aria-labelledby={id('h')} data-testid="edit-day">
	<div class="edit-h"><h3 id={id('h')}>Edit a day</h3><HelpTip key="series-edit-day" /></div>
	{#if series.rebuilding}
		<p class="hint muted" data-testid="edit-day-rebuilding">A data feed is replacing this series. Edit its days once the replacement is in.</p>
	{:else}
		<form onsubmit={save}>
			<div class="form-row">
				<div class="field">
					<label for={id('date')}>Day</label>
					<input id={id('date')} type="date" min={series.startDate} max={end} value={date} oninput={(e) => pick(e.currentTarget.value)} aria-describedby={id('stored')} />
				</div>
				<div class="field value">
					<label for={id('value')}>Value ({series.unit})</label>
					<input
						id={id('value')}
						inputmode="decimal"
						autocomplete="off"
						bind:value={text}
						disabled={!inRange}
						aria-invalid={!typed.ok ? 'true' : undefined}
						aria-describedby={id('stored')}
					/>
				</div>
				<button type="submit" class="btn btn-sm btn-primary save" {disabled}>{saving ? 'Saving…' : typed.ok && typed.value === null ? 'Clear the day' : 'Save the day'}</button>
			</div>
			<p class="hint muted" id={id('stored')} data-testid="edit-day-stored">
				{#if !date}
					Pick a day from {series.startDate} to {end}. Leave the value blank to clear the day (no reading).
				{:else if !inRange}
					<span class="warn-text">{date} is outside the series ({series.startDate} to {end}). Add days outside it from Add data, as a file or pasted rows.</span>
				{:else if !values}
					Loading the stored values…
				{:else}
					Stored: {stored === null || stored === undefined ? 'no reading' : `${exact(stored)} ${series.unit}`}{edited ? ', edited by hand' : ''}.
					{#if fed}A day you edit is yours: the data feed won’t write over it.{/if}
				{/if}
			</p>
			{#if !typed.ok}<p class="hint warn-text" data-testid="edit-day-invalid">{typed.error}</p>{/if}
			{#if error}<div class="alert alert-error" role="alert" data-testid="edit-day-error">{error}</div>{/if}
			{#if done}<p class="ok" role="status" data-testid="edit-day-done">{done} Kept in History, where the value before can be restored.</p>{/if}
		</form>
	{/if}
</div>

<style>
	.edit-day {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
		font-size: 0.85rem;
	}
	.edit-h {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.edit-h h3 {
		margin: 0;
		font-size: 0.95rem;
	}
	.form-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 0.75rem;
	}
	.field {
		margin: 0;
	}
	.value input {
		width: 9rem;
	}
	.save {
		min-height: 32px;
	}
	.hint {
		margin: 0.4rem 0 0;
	}
	.warn-text {
		color: var(--warning);
		font-weight: 600;
	}
	.ok {
		color: var(--success);
		margin: 0.4rem 0 0;
	}
	@media (max-width: 640px) {
		.field,
		.value input,
		.save {
			width: 100%;
		}
		.field input,
		.save {
			min-height: 44px;
		}
	}
</style>
