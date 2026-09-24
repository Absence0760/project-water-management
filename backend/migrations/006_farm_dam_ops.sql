-- 006_farm_dam_ops — farm and dam operating rules (engine 0.16.0).
--
-- Decided on persona recommendation (simulated hydrologist + licensing
-- assessor reviews, 2026-09-24), pending the real hydrologist. Each block names
-- its finding in docs/engine-audit.md; the formulas are in docs/model.md §2.6–2.7.
-- New columns sit on existing tables, so the table-level grants to water_app in
-- 001 and the existing RLS policies already cover them.

-- ---------------------------------------------------------------------------
-- Q5: node.dam_min_pct is now the dam's minimum operating level (dead
-- storage): irrigation draws only the storage above capacity × dam_min_pct,
-- and a transfer keeps at least that much in its source dam. The value the
-- workbook importer stored here was the workbook's *transfer* minimum, which
-- every transfer rule already carries as min_storage_pct, so it is reset to 0
-- (irrigation may empty the dam, as before): no stored result changes meaning.
-- ---------------------------------------------------------------------------
UPDATE node SET dam_min_pct = 0 WHERE dam_min_pct <> 0;
COMMENT ON COLUMN node.dam_min_pct IS
	'Minimum operating level (dead storage) as a fraction of capacity: irrigation draws only above it; transfers keep MAX(rule minimum, this). Engine >= 0.16.0.';

-- ---------------------------------------------------------------------------
-- N1: irrigation application efficiency e and the share β of the losses that
-- returns to the river. Abstraction demand = crop requirement ÷ e; return
-- flow = β × (1 − e) × supplied, replacing return_flow_pct × supplied.
-- A new farm defaults to e = 0.80, β = 0.5 (a typical mixed system).
-- Backfill from the old return flow r, so stored results stay explainable:
--   r = 0 → e = 1, β = 0  (bit-identical results);
--   r > 0 → e = 1 − r, β = 1 (the balance per unit supplied is as before, and
--           the crop is now fully supplied at 1 / (1 − r) times the
--           abstraction). r = 1 (every drop returned, the crop got nothing)
--           maps to e = 0.01, the smallest efficiency the model accepts.
-- The engine's upgradeLegacyModel applies the same mapping to project
-- documents and run snapshots saved before 0.16.0.
-- return_flow_pct is dropped here rather than in a later contract step: no
-- deployed code reads it (the first production deploy is still ahead), and
-- keeping a column nothing writes would invite the two to drift.
-- ---------------------------------------------------------------------------
ALTER TABLE node
	ADD COLUMN irrigation_efficiency double precision NOT NULL DEFAULT 0.8
		CHECK (irrigation_efficiency > 0 AND irrigation_efficiency <= 1),
	ADD COLUMN loss_return_fraction double precision NOT NULL DEFAULT 0.5
		CHECK (loss_return_fraction BETWEEN 0 AND 1);
UPDATE node SET
	irrigation_efficiency = CASE WHEN return_flow_pct > 0 THEN GREATEST(1 - return_flow_pct, 0.01) ELSE 1 END,
	loss_return_fraction  = CASE WHEN return_flow_pct > 0 THEN 1 ELSE 0 END;
ALTER TABLE node DROP COLUMN return_flow_pct;
COMMENT ON COLUMN node.irrigation_efficiency IS
	'Irrigation application efficiency e (0 < e <= 1): abstraction demand = crop requirement / e. Engine >= 0.16.0.';
COMMENT ON COLUMN node.loss_return_fraction IS
	'Share of the application losses (1 - e) x supplied that returns to the river the same day. Engine >= 0.16.0.';

-- ---------------------------------------------------------------------------
-- N2: dam evaporation and seepage. Each day, before irrigation, a dam's
-- surface A = dam_area_full_m2 × (storage[t−1] / capacity)^dam_area_exponent
-- loses lake factor × A-pan × A (settings.lakeEvapFactor, A-pan based) and
-- gains the rain on A; dam_seepage_per_day × storage[t−1] seeps out and joins
-- the farm's outflow. dam_area_full_m2 NULL = unknown: the run estimates
-- capacity ÷ 3 m mean depth and warns (W6). The exponent's default 0.7 is
-- Liebe et al. (2005) for small reservoirs. Existing rows get NULL / 0.7 / 0.
-- ---------------------------------------------------------------------------
ALTER TABLE node
	ADD COLUMN dam_area_full_m2 double precision CHECK (dam_area_full_m2 >= 0),
	ADD COLUMN dam_area_exponent double precision NOT NULL DEFAULT 0.7
		CHECK (dam_area_exponent > 0 AND dam_area_exponent <= 3),
	ADD COLUMN dam_seepage_per_day double precision NOT NULL DEFAULT 0
		CHECK (dam_seepage_per_day BETWEEN 0 AND 1);
COMMENT ON COLUMN node.dam_area_full_m2 IS
	'Dam surface area when full (m2); NULL = unknown, the run estimates capacity / 3 m. Engine >= 0.16.0.';
COMMENT ON COLUMN node.dam_area_exponent IS
	'Exponent b of A = A_full x (S / capacity)^b (0 < b <= 3; Liebe et al. 2005: 0.7). Engine >= 0.16.0.';
COMMENT ON COLUMN node.dam_seepage_per_day IS
	'Seepage per day as a fraction of storage; it joins the outflow. Engine >= 0.16.0.';

-- ---------------------------------------------------------------------------
-- N4 / Q3 / Q18: transfer rules. Each rule moves MAX(0, MIN(source free,
-- destination room, max daily)), with destination room = capacity − storage
-- yesterday + the destination's demand today − what is already scheduled into
-- it, so water isn't pumped into a full dam only to spill. Rules run by
-- priority, lower first; rules of equal priority from one source dam share it
-- pro rata to their limits. The engine used to serve rules in the order the
-- model listed them, which was id order (loadModel ORDER BY id), so each
-- project's rules get priority = their position in id order: a dam with one
-- rule, or several rules at distinct priorities, runs as before apart from
-- the room cap. Table-level grants cover the new column.
-- ---------------------------------------------------------------------------
ALTER TABLE transfer ADD COLUMN priority integer NOT NULL DEFAULT 0;
UPDATE transfer t SET priority = o.rank
FROM (SELECT id, (row_number() OVER (PARTITION BY project_id ORDER BY id) - 1)::integer AS rank FROM transfer) o
WHERE o.id = t.id;
COMMENT ON COLUMN transfer.priority IS
	'Lower moves first; equal priorities from one source dam share it pro rata to their limits. Engine >= 0.16.0.';
