<!-- An example network, drawn like the Network tab's schematic.
     Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 560 310"
	role="img"
	aria-label="An example network. Farm A, without a dam, and Farm B, with a dam, drain into Farm C, which has a dam. Farm C drains into a weir gauge, and the weir gauge drains into the outflow gauge. Farm D, with a dam, drains straight into the outflow gauge. A transfer carries water from Farm B's dam to Farm D's dam."
>
	<defs>
		<marker id="nw-transfer" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head transfer" d="M0 0 L10 5 L0 10 z" />
		</marker>
	</defs>

	<!-- rivers: thicker downstream -->
	<path class="river" stroke-width="2.5" d="M110 59 L198 132" />
	<path class="river" stroke-width="2.5" d="M300 58 L204 132" />
	<path class="river" stroke-width="4" d="M200 150 V204" />
	<path class="river" stroke-width="4.5" d="M204 224 L312 270" />
	<path class="river" stroke-width="2.5" d="M420 150 L326 264" />

	<path class="wire transfer" d="M312 56 Q 404 66 418 128" marker-end="url(#nw-transfer)" />
	<text class="s lbl" x="392" y="78">transfer</text>

	<circle class="node" cx="110" cy="50" r="9" />
	<text class="t lbl" x="126" y="55">Farm A</text>

	<rect class="node" x="292" y="42" width="16" height="16" />
	<text class="t lbl" x="282" y="55" text-anchor="end">Farm B · dam</text>

	<rect class="node" x="192" y="132" width="16" height="16" />
	<text class="t lbl" x="218" y="145">Farm C · dam</text>

	<rect class="node" x="412" y="132" width="16" height="16" />
	<text class="t lbl" x="438" y="145">Farm D · dam</text>

	<polygon class="node-open" points="200,205 211,224 189,224" />
	<text class="t lbl" x="220" y="220">Weir gauge</text>

	<polygon class="outlet" points="320,262 332,284 308,284" />
	<text class="t lbl" x="342" y="280">Outflow gauge</text>

	<!-- legend -->
	<circle class="node" cx="20" cy="196" r="6" />
	<text class="s lbl" x="34" y="200">hydrological unit</text>
	<rect class="node" x="14" y="211" width="12" height="12" />
	<text class="s lbl" x="34" y="221">hydrological unit with a dam</text>
	<polygon class="node-open" points="20,234 27,246 13,246" />
	<text class="s lbl" x="34" y="244">gauge</text>
	<polygon class="outlet" points="20,256 27,268 13,268" />
	<text class="s lbl" x="34" y="266">outflow gauge</text>
	<path class="wire transfer" d="M10 284 H30" />
	<text class="s lbl" x="34" y="288">transfer</text>
</svg>
