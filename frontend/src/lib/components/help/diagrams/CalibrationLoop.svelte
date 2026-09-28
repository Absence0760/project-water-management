<!-- Fit automatically: the DDS search loop, and which days are scored.
     Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 720 330"
	role="img"
	aria-label="The search starts from the current parameters. Each step perturbs them within their bounds (DDS perturbs fewer parameters as it homes in), runs the whole model, runoff model and network, and scores the simulated outflow against the observed record. A candidate that beats the best so far is kept, otherwise discarded, and the loop repeats, 1 500 runs by default. When the budget is used, the best parameters go on to validation. Below, a timeline: the scored days are the days of the observed record inside the calibration window, minus any exclusions."
>
	<defs>
		<marker id="cl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head" d="M0 0 L10 5 L0 10 z" />
		</marker>
		<marker id="cl-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head loop" d="M0 0 L10 5 L0 10 z" />
		</marker>
	</defs>

	<rect class="box key" x="20" y="30" width="170" height="56" rx="6" />
	<text class="t" x="105" y="54" text-anchor="middle">Current parameters</text>
	<text class="s" x="105" y="72" text-anchor="middle">the starting point</text>

	<rect class="box" x="265" y="30" width="190" height="56" rx="6" />
	<text class="t" x="360" y="54" text-anchor="middle">Perturb within bounds</text>
	<text class="s" x="360" y="72" text-anchor="middle">DDS: fewer parameters later</text>

	<rect class="box" x="510" y="30" width="190" height="56" rx="6" />
	<text class="t" x="605" y="54" text-anchor="middle">Run the whole model</text>
	<text class="s" x="605" y="72" text-anchor="middle">runoff model + network</text>

	<rect class="box" x="510" y="140" width="190" height="56" rx="6" />
	<text class="t" x="605" y="164" text-anchor="middle">Score the outflow</text>
	<text class="s" x="605" y="182" text-anchor="middle">vs observed, scored days</text>

	<rect class="box" x="265" y="140" width="190" height="56" rx="6" />
	<text class="t" x="360" y="164" text-anchor="middle">Better than the best?</text>
	<text class="s" x="360" y="182" text-anchor="middle">yes: keep it · no: discard</text>

	<rect class="box key" x="20" y="140" width="170" height="56" rx="6" />
	<text class="t" x="105" y="164" text-anchor="middle">Best parameters</text>
	<text class="s" x="105" y="182" text-anchor="middle">then validate</text>

	<path class="wire" d="M190 58 H263" marker-end="url(#cl-arrow)" />
	<path class="wire" d="M455 58 H508" marker-end="url(#cl-arrow)" />
	<path class="wire" d="M605 86 V138" marker-end="url(#cl-arrow)" />
	<path class="wire" d="M510 168 H457" marker-end="url(#cl-arrow)" />
	<path class="wire loop" d="M360 140 V88" marker-end="url(#cl-loop)" />
	<text class="s lbl" x="370" y="118">repeat: 1 500 runs by default</text>
	<path class="wire" d="M265 168 H192" marker-end="url(#cl-arrow)" />
	<text class="s lbl" x="228" y="160" text-anchor="middle">done</text>

	<!-- which days count -->
	<text class="m lbl" x="20" y="236">Which days are scored</text>
	<text class="s lbl" x="20" y="259">observed record</text>
	<rect class="bar" x="130" y="250" width="570" height="10" rx="2" />
	<text class="s lbl" x="20" y="281">calibration window</text>
	<rect class="box key" x="200" y="271" width="420" height="12" rx="2" />
	<text class="s lbl" x="20" y="303">scored days</text>
	<rect class="box fit" x="200" y="294" width="180" height="12" rx="2" />
	<rect class="box fit" x="450" y="294" width="170" height="12" rx="2" />
	<rect class="excl" x="380" y="244" width="70" height="68" rx="2" fill-opacity="0.6" />
	<text class="s lbl" x="415" y="326" text-anchor="middle">exclusion, with a reason</text>
</svg>
