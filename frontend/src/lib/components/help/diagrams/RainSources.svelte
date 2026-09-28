<!-- Which rain a day uses: catchment rain, else bias-corrected CHIRPS, else
     forecast rain. Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 720 256"
	role="img"
	aria-label="Each day takes the first series that has a value: first catchment rain; if that is blank, CHIRPS multiplied by its calendar month's factor; if that is blank too, forecast rain. The chosen value is the final rain for the day, which drives the runoff model and the effective rain in irrigation demand. A day with no value in any series is treated as dry and counted in the run's warnings. The factor for a month is the catchment rain divided by the CHIRPS rain on the days both have a value, kept between 0.25 and 4."
>
	<defs>
		<marker id="rs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head" d="M0 0 L10 5 L0 10 z" />
		</marker>
	</defs>

	<rect class="box" x="20" y="20" width="230" height="44" rx="6" />
	<text class="t" x="135" y="38" text-anchor="middle">1 · Catchment rain</text>
	<text class="s" x="135" y="55" text-anchor="middle">the catchment’s own record</text>

	<rect class="box" x="20" y="95" width="230" height="44" rx="6" />
	<text class="t" x="135" y="113" text-anchor="middle">2 · CHIRPS × month factor</text>
	<text class="s" x="135" y="130" text-anchor="middle">bias-corrected satellite rain</text>

	<rect class="box" x="20" y="170" width="230" height="44" rx="6" />
	<text class="t" x="135" y="188" text-anchor="middle">3 · Forecast rain</text>
	<text class="s" x="135" y="205" text-anchor="middle">a few days ahead</text>

	<path class="wire" d="M60 64 V93" marker-end="url(#rs-arrow)" />
	<text class="s lbl" x="68" y="84">if blank</text>
	<path class="wire" d="M60 139 V168" marker-end="url(#rs-arrow)" />
	<text class="s lbl" x="68" y="159">if blank</text>

	<text class="s lbl" x="430" y="70" text-anchor="middle">first series with a value</text>
	<rect class="box key" x="340" y="80" width="180" height="60" rx="6" />
	<text class="t" x="430" y="106" text-anchor="middle">Final rain</text>
	<text class="s" x="430" y="124" text-anchor="middle">for the day, mm</text>
	<path class="wire" d="M250 42 L338 96" marker-end="url(#rs-arrow)" />
	<path class="wire" d="M250 117 H338" marker-end="url(#rs-arrow)" />
	<path class="wire" d="M250 182 L338 132" marker-end="url(#rs-arrow)" />

	<rect class="box" x="340" y="180" width="180" height="44" rx="6" />
	<text class="t" x="430" y="198" text-anchor="middle">No value anywhere</text>
	<text class="s" x="430" y="215" text-anchor="middle">a dry day, counted</text>
	<path class="wire" d="M250 204 H338" marker-end="url(#rs-arrow)" />
	<text class="s lbl" x="294" y="222" text-anchor="middle">all blank</text>

	<rect class="box" x="570" y="46" width="140" height="44" rx="6" />
	<text class="t" x="640" y="73" text-anchor="middle">Runoff model</text>
	<rect class="box" x="570" y="118" width="140" height="44" rx="6" />
	<text class="t" x="640" y="136" text-anchor="middle">Irrigation demand</text>
	<text class="s" x="640" y="153" text-anchor="middle">effective rain</text>
	<path class="wire" d="M520 100 L568 72" marker-end="url(#rs-arrow)" />
	<path class="wire" d="M520 122 L568 138" marker-end="url(#rs-arrow)" />

	<text class="m lbl" x="20" y="248">factor(month) = Σ catchment rain ÷ Σ CHIRPS, on days both have a value; kept within 0.25–4</text>
</svg>
