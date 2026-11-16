<!--
	Attach a feed → Weather station API (issue #784; docs/ui.md § Data feeds): a rainfall station read from whatever
	web API its provider offers. The URL template, how the key is sent (the key itself write-only), how to read the
	answer, presets that prefill a few known shapes, and "Try it on a sample", which reads a pasted answer in the
	browser with the feed's own reader (@water-management/engine/station-format), so the preview and the feed can't
	read one answer two ways. Its own lazy chunk: DataFeedsPanel loads it only when this source is picked. The
	panel owns the form element, the error line and Attach feed; it calls build() for the body. Helpers in
	./stationApi.ts.
-->
<script lang="ts">
	import DayInput from '#lib/components/common/DayInput.svelte';
	import Fold from '#lib/components/common/Fold.svelte';
	import { ApiError } from '#lib/api/index.js';
	import { fmtDay, fmtNum } from '#lib/format/number.js';
	import { previewStationAnswer, StationFormatError } from '@water-management/engine/station-format';
	import {
		AUTH_CHOICES,
		DELIMITER_CHOICES,
		emptyStationDraft,
		MAX_EXTRA_HEADERS,
		moreLine,
		previewRows,
		previewSummary,
		requestLine,
		STATION_PRESETS,
		stationDraftToBody,
		stationFormatOf,
		stationServerProblem,
		TIME_CHOICES,
		TIME_ZONES,
		URL_TIME_CHOICES,
		urlPlaceholderNote,
		type StationBody,
		type StationDraft,
		type StationField,
		type StationPreviewResult
	} from './stationApi';

	let {
		uid,
		name = $bindable(''),
		errorField = null,
		error = null,
		errorId
	}: {
		/** The panel's id prefix: the fields' ids are `${uid}-<field>`, so the panel can focus the one a problem is about. */
		uid: string;
		/** The station's name, which is the series name (the panel's draft.targetName). */
		name?: string;
		/** The field the panel's problem is about. */
		errorField?: string | null;
		/** The problem's words: shown under the field it is about (errorField), which names it as its description. */
		error?: string | null;
		/** The problem line's id. */
		errorId: string;
	} = $props();

	let d = $state<StationDraft>(emptyStationDraft());
	let preset = $state('');
	const presetNote = $derived(STATION_PRESETS.find((p) => p.id === preset)?.note ?? null);
	const urlNote = $derived(urlPlaceholderNote(d.url));

	let sample = $state('');
	let preview = $state<{ result: StationPreviewResult } | { error: string } | null>(null);

	/** The request body's parts, or the first problem and its field (the panel shows it and focuses the field). */
	export function build(): { body: StationBody } | { error: string; field: StationField } {
		return stationDraftToBody(d, name);
	}

	/** A refused attach on the field it is about (the server's 400 details, a 409 for the series), or null. */
	export function serverProblem(e: unknown): { error: string; field: StationField } | null {
		return e instanceof ApiError ? stationServerProblem(e, d.authKind) : null;
	}

	function applyPreset(id: string) {
		preset = id;
		const p = STATION_PRESETS.find((x) => x.id === id);
		if (p) d = p.apply(d);
		preview = null;
	}

	function addHeader() {
		if (d.headers.length < MAX_EXTRA_HEADERS) d.headers.push({ name: '', value: '' });
	}

	/** Read the pasted answer as the feed would, in the browser: nothing is sent. */
	function tryIt() {
		const f = stationFormatOf(d);
		if ('error' in f) {
			preview = { error: f.error };
			return;
		}
		if (!sample.trim()) {
			preview = { error: 'Paste an answer from the API first.' };
			return;
		}
		try {
			preview = { result: previewStationAnswer(sample, f.format, Date.now()) };
		} catch (e) {
			const msg = e instanceof StationFormatError ? e.message : 'the answer couldn’t be read';
			preview = { error: `${msg.charAt(0).toUpperCase()}${msg.slice(1)}.` };
		}
	}

	const inv = (f: StationField) => (errorField === f ? true : undefined);
	const desc = (f: StationField, ...ids: string[]) => [...ids, errorField === f ? errorId : ''].filter(Boolean).join(' ') || undefined;
	const hours = Array.from({ length: 24 }, (_, h) => h);
</script>

<!-- The fields in the order someone reads their provider's documentation: which API and station, the key, how to read the
     answer, then a sample; the rarely changed ones folded into their values. A problem shows under its own field. -->
<div class="station" data-testid="station-api-form">
	{#snippet problem(f: StationField)}
		{#if error && errorField === f}<p class="err num-err" id={errorId} role="alert">{error}</p>{/if}
	{/snippet}

	<h4 class="sub first">The API and the station</h4>
	<div class="field">
		<label for="{uid}-st-preset">Start from a known API <span class="muted">(optional)</span></label>
		<select id="{uid}-st-preset" value={preset} onchange={(e) => applyPreset(e.currentTarget.value)} aria-describedby="{uid}-st-preset-h">
			<option value="">Fill it in myself</option>
			{#each STATION_PRESETS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
		</select>
		<span class="hint" id="{uid}-st-preset-h">
			{#if presetNote}{presetNote}{' '}{/if}A preset only fills in the fields: check them against your provider’s documentation.
		</span>
	</div>

	<div class="field">
		<label for="{uid}-st-url">The API’s URL</label>
		<!-- A text box, not a one-line input, so a long URL wraps and can be read whole; a line break is never kept. -->
		<textarea
			id="{uid}-st-url"
			class="url"
			rows="2"
			maxlength="2000"
			required
			inputmode="url"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			placeholder="https://"
			value={d.url}
			oninput={(e) => (d.url = e.currentTarget.value.replace(/[\r\n]+/g, ''))}
			onkeydown={(e) => {
				// Enter submits, as in a one-line field.
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					e.currentTarget.form?.requestSubmit();
				}
			}}
			aria-invalid={inv('st-url')}
			aria-describedby={desc('st-url', `${uid}-st-url-h`, urlNote ? `${uid}-st-url-n` : '')}
		></textarea>
		<span class="hint" id="{uid}-st-url-h">
			Write {'{station}'} where the station ID goes, and {'{start}'} and {'{end}'} where the first and last day of each request go, e.g.
			<code>https://api.example.com/rain?station={'{station}'}&amp;from={'{start}'}&amp;to={'{end}'}</code>. Leave the key out: it has its own field.
		</span>
		{#if urlNote}<span class="hint" id="{uid}-st-url-n" data-testid="station-url-note">{urlNote}</span>{/if}
		{@render problem('st-url')}
	</div>

	<div class="form-row">
		<div class="field">
			<label for="{uid}-st-station">Station ID</label>
			<input
				id="{uid}-st-station"
				type="text"
				maxlength="100"
				autocomplete="off"
				spellcheck="false"
				bind:value={d.station}
				aria-invalid={inv('st-station')}
				aria-describedby={desc('st-station', `${uid}-st-station-h`)}
			/>
			<span class="hint" id="{uid}-st-station-h">As your provider writes it; it fills {'{station}'}.</span>
			{@render problem('st-station')}
		</div>
		<div class="field grow">
			<label for="{uid}-name">Station name</label>
			<input id="{uid}-name" type="text" maxlength="100" required bind:value={name} aria-invalid={inv('name')} aria-describedby={desc('name', `${uid}-name-h`)} />
			<span class="hint" id="{uid}-name-h">The rainfall series is called this.</span>
			{@render problem('name')}
		</div>
	</div>

	<p class="hint terms" data-testid="station-terms">
		As the project’s owner you are responsible for having the provider’s permission to fetch this station’s data this way: check
		their API terms. The request is made with your key, under your agreement with them.
	</p>

	<h4 class="sub">The key</h4>
	<div class="form-row">
		<div class="field">
			<label for="{uid}-st-auth">How the key is sent</label>
			<select id="{uid}-st-auth" bind:value={d.authKind}>
				{#each AUTH_CHOICES as a (a.value)}<option value={a.value}>{a.label}</option>{/each}
			</select>
		</div>
		{#if d.authKind === 'header'}
			<div class="field">
				<label for="{uid}-st-header-name">Header name</label>
				<input
					id="{uid}-st-header-name"
					type="text"
					maxlength="64"
					autocomplete="off"
					spellcheck="false"
					placeholder="X-Api-Key"
					bind:value={d.headerName}
					aria-invalid={inv('st-header-name')}
					aria-describedby={desc('st-header-name')}
				/>
				{@render problem('st-header-name')}
			</div>
			<div class="field">
				<label for="{uid}-st-header-prefix">Before the key <span class="muted">(optional)</span></label>
				<input id="{uid}-st-header-prefix" type="text" maxlength="32" autocomplete="off" spellcheck="false" placeholder="e.g. Token" bind:value={d.headerPrefix} />
			</div>
		{:else if d.authKind === 'query'}
			<div class="field">
				<label for="{uid}-st-query-name">Parameter name</label>
				<input
					id="{uid}-st-query-name"
					type="text"
					maxlength="64"
					autocomplete="off"
					spellcheck="false"
					placeholder="apiKey"
					bind:value={d.queryName}
					aria-invalid={inv('st-query-name')}
					aria-describedby={desc('st-query-name')}
				/>
				{@render problem('st-query-name')}
			</div>
		{/if}
	</div>
	{#if d.authKind !== 'none'}
		<div class="form-row">
			{#if d.authKind === 'basic'}
				<div class="field">
					<label for="{uid}-st-user">User name</label>
					<input id="{uid}-st-user" type="text" maxlength="256" autocomplete="off" spellcheck="false" bind:value={d.user} aria-invalid={inv('st-user')} aria-describedby={desc('st-user')} />
					{@render problem('st-user')}
				</div>
			{/if}
			<div class="field grow key">
				<label for="{uid}-st-secret">{d.authKind === 'basic' ? 'Password' : 'Key'}</label>
				<input
					id="{uid}-st-secret"
					type="password"
					autocomplete="off"
					spellcheck="false"
					bind:value={d.secret}
					aria-invalid={inv('st-secret')}
					aria-describedby={desc('st-secret', `${uid}-st-secret-h`)}
				/>
				<span class="hint" id="{uid}-st-secret-h">At least 8 characters. Kept sealed: only the server’s fetcher can read it, and it is never shown again, here or anywhere else.</span>
				{@render problem('st-secret')}
			</div>
		</div>
	{/if}

	<Fold name="Requests:" line={requestLine(d)} atDefaults={requestLine(d) === requestLine(emptyStationDraft())} spaced testid="station-requests">
		<!-- With a pattern, the pattern's box takes the id a problem focuses, and the select keeps its label by its own. -->
		<div class="field">
			<label for={d.urlTime === 'custom' ? `${uid}-st-url-time-kind` : `${uid}-st-url-time`}>Dates in the URL</label>
			<select
				id={d.urlTime === 'custom' ? `${uid}-st-url-time-kind` : `${uid}-st-url-time`}
				bind:value={d.urlTime}
				aria-invalid={d.urlTime !== 'custom' ? inv('st-url-time') : undefined}
				aria-describedby={d.urlTime !== 'custom' ? desc('st-url-time') : undefined}
			>
				{#each URL_TIME_CHOICES as c (c.value)}<option value={c.value}>{c.label}</option>{/each}
			</select>
			{#if d.urlTime !== 'custom'}{@render problem('st-url-time')}{/if}
		</div>
		{#if d.urlTime === 'custom'}
			<div class="field">
				<label for="{uid}-st-url-time">Date pattern</label>
				<input
					id="{uid}-st-url-time"
					type="text"
					maxlength="40"
					spellcheck="false"
					placeholder="DD-MM-YYYY"
					bind:value={d.urlTimeCustom}
					aria-invalid={inv('st-url-time')}
					aria-describedby={desc('st-url-time', `${uid}-st-pattern-h`)}
				/>
				<span class="hint" id="{uid}-st-pattern-h">YYYY, MM, DD, HH, mm and ss, with anything between.</span>
				{@render problem('st-url-time')}
			</div>
		{/if}
		<div class="field">
			<label for="{uid}-st-max-days">Days per request <span class="muted">(optional)</span></label>
			<input
				id="{uid}-st-max-days"
				type="text"
				inputmode="numeric"
				placeholder="31"
				bind:value={d.maxDays}
				aria-invalid={inv('st-max-days')}
				aria-describedby={desc('st-max-days', `${uid}-st-max-days-h`)}
			/>
			<span class="hint" id="{uid}-st-max-days-h">Your provider’s limit for one call. Default 31.</span>
			{@render problem('st-max-days')}
		</div>
		<div class="field">
			<label for="{uid}-st-revision">Days read again <span class="muted">(optional)</span></label>
			<input
				id="{uid}-st-revision"
				type="text"
				inputmode="numeric"
				placeholder="7"
				bind:value={d.revisionDays}
				aria-invalid={inv('st-revision')}
				aria-describedby={desc('st-revision', `${uid}-st-revision-h`)}
			/>
			<span class="hint" id="{uid}-st-revision-h">Each fetch reads these recent days again, for late or corrected readings. Default 7.</span>
			{@render problem('st-revision')}
		</div>
		<div class="field">
			<label for="{uid}-st-start">Start date <span class="muted">(optional)</span></label>
			<DayInput id="{uid}-st-start" bind:value={d.startDate} aria-invalid={inv('st-start')} aria-describedby={desc('st-start', `${uid}-st-start-h`)} />
			<span class="hint" id="{uid}-st-start-h">The first day to fetch, 1 Jan 2000 or later. Default: 90 days back.</span>
			{@render problem('st-start')}
		</div>
		<fieldset class="headers" aria-describedby={desc('st-headers', `${uid}-st-headers-h`)}>
			<legend>Extra headers <span class="muted">(optional)</span></legend>
			<span class="hint" id="{uid}-st-headers-h">Only if the API asks for them; anyone who can open the project can read them, so never a key.</span>
			{#each d.headers as h, i (i)}
				<div class="header-row">
					<!-- The first row's name takes the id a problem with the headers focuses. -->
					<input
						id={i === 0 ? `${uid}-st-headers` : undefined}
						type="text"
						maxlength="64"
						autocomplete="off"
						spellcheck="false"
						aria-label="Header {i + 1} name"
						aria-invalid={inv('st-headers')}
						bind:value={h.name}
					/>
					<input type="text" maxlength="1024" autocomplete="off" spellcheck="false" aria-label="Header {i + 1} value" bind:value={h.value} />
					<button type="button" class="btn btn-sm" aria-label="Remove header {i + 1}" onclick={() => d.headers.splice(i, 1)}>Remove</button>
				</div>
			{/each}
			{@render problem('st-headers')}
			{#if d.headers.length < MAX_EXTRA_HEADERS}
				<button type="button" class="btn btn-sm" id={d.headers.length ? undefined : `${uid}-st-headers`} onclick={addHeader}>Add a header</button>
			{:else}
				<span class="hint">At most {MAX_EXTRA_HEADERS} extra headers.</span>
			{/if}
		</fieldset>
	</Fold>

	<h4 class="sub">How to read the answer</h4>
	<div class="form-row">
		<div class="field">
			<label for="{uid}-st-format">The answer is</label>
			<select id="{uid}-st-format" bind:value={d.format}>
				<option value="json">JSON</option>
				<option value="csv">CSV (a table of text)</option>
			</select>
		</div>
		{#if d.format === 'json'}
			<div class="field grow">
				<label for="{uid}-st-records">Path to the records <span class="muted">(optional)</span></label>
				<input
					id="{uid}-st-records"
					type="text"
					maxlength="200"
					autocomplete="off"
					spellcheck="false"
					placeholder="e.g. data.readings"
					bind:value={d.records}
					aria-invalid={inv('st-records')}
					aria-describedby={desc('st-records', `${uid}-st-records-h`)}
				/>
				<span class="hint" id="{uid}-st-records-h">Where the list of readings sits, names joined by dots; blank when the answer is the list.</span>
				{@render problem('st-records')}
			</div>
		{:else}
			<div class="field">
				<label for="{uid}-st-delimiter">Delimiter</label>
				<select id="{uid}-st-delimiter" bind:value={d.delimiter}>
					{#each DELIMITER_CHOICES as c (c.value)}<option value={c.value}>{c.label}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="{uid}-st-skip">Lines to skip first <span class="muted">(optional)</span></label>
				<input id="{uid}-st-skip" type="text" inputmode="numeric" placeholder="0" bind:value={d.skipLines} aria-invalid={inv('st-skip')} aria-describedby={desc('st-skip')} />
				{@render problem('st-skip')}
			</div>
		{/if}
	</div>
	<div class="checks">
		{#if d.format === 'json'}
			<div class="check-field">
				<label class="check"><input type="checkbox" bind:checked={d.recordsKeyedByTime} aria-describedby="{uid}-st-keyed-h" /> Records keyed by time</label>
				<span class="hint" id="{uid}-st-keyed-h">An object whose names are the times, e.g. {'{'}"1731650400": 1.2, …{'}'}.</span>
			</div>
		{:else}
			<label class="check"><input type="checkbox" bind:checked={d.headerRow} /> The first line names the columns</label>
		{/if}
		<label class="check"><input type="checkbox" bind:checked={d.decimalComma} /> Numbers use a decimal comma (1,5)</label>
	</div>

	<div class="form-row">
		{#if !(d.format === 'json' && d.recordsKeyedByTime)}
			<div class="field">
				<label for="{uid}-st-time">Time {d.format === 'csv' ? 'column' : 'field'}</label>
				<input
					id="{uid}-st-time"
					type="text"
					maxlength="200"
					autocomplete="off"
					spellcheck="false"
					placeholder={d.format === 'csv' ? 'e.g. TIMESTAMP or 1' : 'e.g. date'}
					bind:value={d.time}
					aria-invalid={inv('st-time')}
					aria-describedby={desc('st-time')}
				/>
				{@render problem('st-time')}
			</div>
		{/if}
		<div class="field">
			<label for="{uid}-st-value">Rain {d.format === 'csv' ? 'column' : 'field'}</label>
			<input
				id="{uid}-st-value"
				type="text"
				maxlength="200"
				autocomplete="off"
				spellcheck="false"
				placeholder={d.format === 'csv' ? 'e.g. Rain_mm or 2' : 'e.g. rain_mm'}
				bind:value={d.value}
				aria-invalid={inv('st-value')}
				aria-describedby={desc('st-value', `${uid}-st-value-h`)}
			/>
			<span class="hint" id="{uid}-st-value-h">
				{d.format === 'csv' ? 'A column’s name, or its number (1, 2, …) with no header line.' : 'Within each record; names joined by dots.'}
			</span>
			{@render problem('st-value')}
		</div>
	</div>
	<div class="form-row">
		<div class="field">
			<label for={d.timeFormat === 'custom' ? `${uid}-st-time-format-kind` : `${uid}-st-time-format`}>Time format</label>
			<select
				id={d.timeFormat === 'custom' ? `${uid}-st-time-format-kind` : `${uid}-st-time-format`}
				bind:value={d.timeFormat}
				aria-invalid={d.timeFormat !== 'custom' ? inv('st-time-format') : undefined}
				aria-describedby={d.timeFormat !== 'custom' ? desc('st-time-format') : undefined}
			>
				{#each TIME_CHOICES as c (c.value)}<option value={c.value}>{c.label}</option>{/each}
			</select>
			{#if d.timeFormat !== 'custom'}{@render problem('st-time-format')}{/if}
		</div>
		{#if d.timeFormat === 'custom'}
			<div class="field">
				<label for="{uid}-st-time-format">Time pattern</label>
				<input
					id="{uid}-st-time-format"
					type="text"
					maxlength="40"
					spellcheck="false"
					placeholder="DD/MM/YYYY HH:mm"
					bind:value={d.timeFormatCustom}
					aria-invalid={inv('st-time-format')}
					aria-describedby={desc('st-time-format', `${uid}-st-tpattern-h`)}
				/>
				<span class="hint" id="{uid}-st-tpattern-h">YYYY, MM, DD, HH, mm and ss, with anything between.</span>
				{@render problem('st-time-format')}
			</div>
		{/if}
		<div class="field">
			<label for="{uid}-st-zone">Time zone</label>
			<input
				id="{uid}-st-zone"
				type="text"
				maxlength="64"
				list="{uid}-st-zones"
				autocomplete="off"
				spellcheck="false"
				bind:value={d.timeZone}
				aria-invalid={inv('st-zone')}
				aria-describedby={desc('st-zone', `${uid}-st-zone-h`)}
			/>
			<datalist id="{uid}-st-zones">{#each TIME_ZONES as z (z)}<option value={z}></option>{/each}</datalist>
			<span class="hint" id="{uid}-st-zone-h">For times written without one, and the days are counted in it.</span>
			{@render problem('st-zone')}
		</div>
	</div>

	<div class="form-row">
		<div class="field">
			<label for="{uid}-st-resolution">Readings</label>
			<select id="{uid}-st-resolution" bind:value={d.resolution}>
				<option value="daily">One a day (the day’s total)</option>
				<option value="subdaily">Within the day (summed into days)</option>
			</select>
		</div>
		{#if d.resolution === 'subdaily'}
			<div class="field">
				<label for="{uid}-st-day-start">Rain day starts at</label>
				<select id="{uid}-st-day-start" bind:value={d.dayStartHour} aria-describedby="{uid}-st-day-start-h">
					{#each hours as h (h)}<option value={String(h)}>{String(h).padStart(2, '0')}:00</option>{/each}
				</select>
				<span class="hint" id="{uid}-st-day-start-h">08:00 is South African practice.</span>
			</div>
			<div class="field">
				<label for="{uid}-st-credit">A rain day is dated by</label>
				<select id="{uid}-st-credit" bind:value={d.creditDayTo}>
					<option value="start">The day it starts</option>
					<option value="end">The day it ends</option>
				</select>
			</div>
		{/if}
	</div>
	{#if d.resolution === 'subdaily'}
		<div class="form-row">
			<div class="field">
				<label for="{uid}-st-stamp">A reading’s time marks</label>
				<select id="{uid}-st-stamp" bind:value={d.stampMarks}>
					<option value="end">The end of its interval</option>
					<option value="start">The start of its interval</option>
				</select>
			</div>
			<div class="field">
				<label for="{uid}-st-kind">Each reading is</label>
				<select id="{uid}-st-kind" bind:value={d.valueKind}>
					<option value="amount">The rain in its interval</option>
					<option value="cumulative">A running total</option>
				</select>
			</div>
		</div>
	{/if}

	<Fold name="Values:" line={moreLine(d)} atDefaults={moreLine(d) === moreLine(emptyStationDraft())} spaced testid="station-values">
		<div class="field">
			<label for="{uid}-st-scale">Scale <span class="muted">(optional)</span></label>
			<input
				id="{uid}-st-scale"
				type="text"
				inputmode="decimal"
				placeholder="1"
				bind:value={d.scale}
				aria-invalid={inv('st-scale')}
				aria-describedby={desc('st-scale', `${uid}-st-scale-h`)}
			/>
			<span class="hint" id="{uid}-st-scale-h">Every value is multiplied by it: 25.4 for inches, or the mm per tip for tip counts.</span>
			{@render problem('st-scale')}
		</div>
		<div class="field">
			<label for="{uid}-st-missing">Missing markers</label>
			<input
				id="{uid}-st-missing"
				type="text"
				maxlength="400"
				autocomplete="off"
				spellcheck="false"
				bind:value={d.missing}
				aria-invalid={inv('st-missing')}
				aria-describedby={desc('st-missing', `${uid}-st-missing-h`)}
			/>
			<span class="hint" id="{uid}-st-missing-h">Values that mean no reading, separated by commas; an empty value always is one.</span>
			{@render problem('st-missing')}
		</div>
		<div class="field">
			<label for="{uid}-st-no-readings">A day with no readings is</label>
			<select id="{uid}-st-no-readings" bind:value={d.noReadingsMeans} aria-describedby="{uid}-st-no-readings-h">
				<option value="gap">A gap</option>
				<option value="zero">0 mm (the logger only reports rain)</option>
			</select>
			<span class="hint" id="{uid}-st-no-readings-h">A missing reading is always a gap, never 0.</span>
		</div>
	</Fold>

	<section class="sample" aria-labelledby="{uid}-st-sample-h">
		<h4 class="sub" id="{uid}-st-sample-h">Try it on a sample</h4>
		<p class="hint" id="{uid}-st-sample-x">Paste what your provider’s API returns; nothing leaves your browser.</p>
		<div class="field">
			<label for="{uid}-st-sample">An answer from the API</label>
			<textarea id="{uid}-st-sample" rows="5" spellcheck="false" bind:value={sample} aria-describedby="{uid}-st-sample-x"></textarea>
		</div>
		<button type="button" class="btn btn-sm" onclick={tryIt}>Try it</button>
		<div data-testid="station-preview">
			<!-- Only the result's words are announced; the table is read when the reader moves to it. -->
			<div role="status">
				{#if preview && 'error' in preview}
					<p class="err">{preview.error}</p>
				{:else if preview}
					<p class="summary">{previewSummary(preview.result)}</p>
				{/if}
			</div>
			{#if preview && 'result' in preview}
				{@const rows = previewRows(preview.result)}
				{#if rows.length}
					<div class="table-wrap">
						<table class="data" aria-label="The last days the sample would write">
							<thead>
								<tr><th scope="col">Day</th><th scope="col" class="num">Rain (mm)</th></tr>
							</thead>
							<tbody>
								{#each rows as r (r.day)}
									<tr><th scope="row">{fmtDay(r.day)}</th><td class="num">{r.mm === null ? 'gap' : fmtNum(r.mm, 2, true)}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			{/if}
		</div>
	</section>
</div>

<style>
	/* A child component: the panel's .add rules don't reach in here, so a long option can't push a phone sideways. */
	.station .field {
		min-width: 0;
		max-width: 100%;
	}
	.station select {
		max-width: 100%;
	}
	/* Labels on one line, so the inputs of a row line up whatever hint hangs under one of them. */
	.station .form-row {
		align-items: flex-start;
	}
	.station .grow {
		flex: 1 1 18rem;
	}
	.station .key {
		max-width: 32rem;
	}
	.url {
		width: 100%;
		resize: vertical;
		font-family: var(--font-mono, monospace);
		font-size: var(--font-sm);
		overflow-wrap: anywhere;
		field-sizing: content;
		min-height: 2.6rem;
	}
	.hint {
		font-size: var(--font-sm);
		max-width: 75ch;
	}
	code {
		overflow-wrap: anywhere;
	}
	.terms {
		margin: 0 0 0.6rem;
	}
	.sub {
		margin: 0.75rem 0 0.4rem;
		font-size: 0.95rem;
	}
	.sub.first {
		margin-top: 0.25rem;
	}
	.checks {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.25rem 1.5rem;
		margin-bottom: 0.6rem;
	}
	.check-field {
		display: grid;
	}
	.check {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
	}
	@media (pointer: coarse), (max-width: 640px) {
		.check {
			min-height: var(--tap);
		}
	}
	.headers {
		border: 0;
		padding: 0;
		margin: 0 0 0.6rem;
		min-width: 0;
		display: grid;
		gap: 0.4rem;
	}
	.headers legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		padding: 0;
	}
	.header-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.header-row input {
		flex: 1 1 10rem;
		min-width: 0;
	}
	.headers > .btn {
		justify-self: start;
	}
	.sample {
		margin-top: 0.5rem;
	}
	.sample textarea {
		width: 100%;
		font-family: var(--font-mono, monospace);
		font-size: var(--font-sm);
	}
	.summary {
		margin: 0.5rem 0 0.3rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
		margin: 0.3rem 0 0;
		max-width: 75ch;
	}
	.table-wrap {
		max-width: 22rem;
	}
</style>
