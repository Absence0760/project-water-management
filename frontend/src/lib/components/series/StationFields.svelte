<script lang="ts">
	// A rainfall station's details (issue #553, docs/ui.md § Data): under the Series details of a catchment rain
	// series with no site, its MAP and that MAP's source, and where it stands. Saved together with one button
	// (PATCH …/series/:id { station }), as the engine's rainStationError judges them together; a viewer reads them.
	// Settings → Rain for each unit reads the MAP from here and links to it (id="series-station").
	import { MAP_MM_MAX, MAP_MM_MIN, PE_SOURCE_MAX, type RainStationMeta, type SeriesMeta } from '@water-management/engine';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import { stationChanged, stationDraft, stationFromDraft, stationMapText, stationPlaceText, stationProblem } from './station';

	let {
		series,
		readonly = false,
		onsave
	}: {
		series: SeriesMeta;
		readonly?: boolean;
		/** Save the station (null clears it); resolves with what the API stored. */
		onsave: (station: RainStationMeta | null) => Promise<RainStationMeta | null>;
	} = $props();

	const uid = $props.id();
	const id = (s: string) => `${uid}-${s}`;
	// The draft starts from the stored station; the parent keys this component by series id.
	// svelte-ignore state_referenced_locally
	let draft = $state(stationDraft(series.station));
	let saving = $state(false);
	let error = $state<string | null>(null);
	let done = $state(false);

	const problem = $derived(stationProblem(draft));
	const changed = $derived(stationChanged(draft, series.station));
	const describe = (field: 'map' | 'source' | 'coords', hint: string) => (problem?.field === field ? `${hint} ${id('err')}` : hint);
	const mapText = $derived(stationMapText(series.station));
	const placeText = $derived(stationPlaceText(series.station));

	function edit(patch: Partial<typeof draft>) {
		draft = { ...draft, ...patch };
		done = false;
		error = null;
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (saving || problem || !changed) return;
		saving = true;
		error = null;
		try {
			const stored = await onsave(stationFromDraft(draft));
			draft = stationDraft(stored);
			done = true;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<div class="station" id="series-station" role="group" aria-labelledby={id('h')} data-testid="series-station">
	<h4 id={id('h')}>Rainfall station</h4>
	{#if readonly}
		<dl class="read">
			<div><dt>MAP</dt><dd data-testid="station-map">{mapText ?? 'Not recorded'}</dd></div>
			<div><dt>Where it stands</dt><dd data-testid="station-place">{placeText ?? 'Not recorded'}</dd></div>
		</dl>
	{:else}
		<form onsubmit={save}>
			<div class="form-row">
				<div class="field">
					<label for={id('map')}>MAP <span class="u">(mm)</span></label>
					<NumberInput
						id={id('map')}
						min={MAP_MM_MIN}
						max={MAP_MM_MAX}
						step={1}
						nullable
						placeholder="not set"
						value={draft.mapMm}
						aria-invalid={problem?.field === 'map' || undefined}
						aria-describedby={describe('map', id('map-h'))}
						onchange={(v) => edit(v === null ? { mapMm: null, mapSource: '' } : { mapMm: v })}
					/>
				</div>
				{#if draft.mapMm !== null}
					<div class="field source">
						<label for={id('src')}>Source of the MAP</label>
						<input
							id={id('src')}
							required
							maxlength={PE_SOURCE_MAX}
							value={draft.mapSource}
							placeholder="e.g. the station’s record 1991–2020, complete years"
							aria-invalid={problem?.field === 'source' || undefined}
							aria-describedby={describe('source', id('map-h'))}
							oninput={(e) => edit({ mapSource: e.currentTarget.value })}
						/>
					</div>
				{/if}
				<div class="field coord">
					<label for={id('lat')}>Latitude <span class="u">(°)</span></label>
					<NumberInput
						id={id('lat')}
						min={-90}
						max={90}
						step={0.0001}
						nullable
						grouped={false}
						placeholder="not set"
						value={draft.lat}
						aria-invalid={problem?.field === 'coords' || undefined}
						aria-describedby={describe('coords', id('place-h'))}
						onchange={(v) => edit({ lat: v })}
					/>
				</div>
				<div class="field coord">
					<label for={id('lon')}>Longitude <span class="u">(°)</span></label>
					<NumberInput
						id={id('lon')}
						min={-180}
						max={180}
						step={0.0001}
						nullable
						grouped={false}
						placeholder="not set"
						value={draft.lon}
						aria-invalid={problem?.field === 'coords' || undefined}
						aria-describedby={describe('coords', id('place-h'))}
						onchange={(v) => edit({ lon: v })}
					/>
				</div>
				<button type="submit" class="btn btn-sm btn-primary save" disabled={saving || !!problem || !changed}>{saving ? 'Saving…' : 'Save the station'}</button>
			</div>
			<p class="hint muted" id={id('map-h')}>
				The station’s own mean annual rain, with the record or study it comes from and its years. Rain for each unit scales this station’s rain to a unit by
				unit MAP ÷ this MAP.
			</p>
			<p class="hint muted" id={id('place-h')}>Optional: where the station stands, in WGS84 degrees (south is negative), both or neither.</p>
			{#if problem}<p class="err" id={id('err')} data-testid="station-error">{problem.message}</p>{/if}
			{#if error}<div class="alert alert-error" role="alert" data-testid="station-save-error">Not saved: {error}</div>{/if}
			{#if done}<p class="ok" role="status" data-testid="station-saved">Saved the station.</p>{/if}
		</form>
	{/if}
</div>

<style>
	.station {
		margin-top: 0.75rem;
		font-size: 0.85rem;
	}
	h4 {
		margin: 0 0 0.4rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-2);
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
	.field :global(input) {
		width: 9rem;
	}
	.source {
		flex: 1 1 16rem;
	}
	.source input {
		width: 100%;
		max-width: 40rem;
	}
	.save {
		min-height: 32px;
	}
	.hint {
		margin: 0.4rem 0 0;
		max-width: 75ch;
		font-size: var(--font-sm);
	}
	.err {
		margin: 0.4rem 0 0;
		color: var(--danger);
		font-size: var(--font-sm);
	}
	.ok {
		color: var(--success);
		margin: 0.4rem 0 0;
	}
	.read {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.5rem;
		margin: 0;
	}
	.read dt {
		font-size: var(--font-sm);
		font-weight: 600;
		color: var(--text-2);
	}
	.read dd {
		margin: 0.15rem 0 0;
	}
	@media (max-width: 640px) {
		.field,
		.field :global(input),
		.save {
			width: 100%;
		}
		.field :global(input),
		.save {
			min-height: 44px;
		}
	}
</style>
