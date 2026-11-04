-- 311_transfer_splits_monthly_formula — a transfer split between destinations,
-- and a river off-take that takes a maximum or a formula by month (engine
-- 1.114.0, docs/model.md §2.6 *Split between destinations* and §2.6a *A maximum
-- or a formula by month*).
--
--   split_node_ids   the destinations of a rule split between two to five, in
--                    order: each a node, or NULL (outside the catchment, a dam
--                    rule only, as to_node_id NULL is since 224). NULL (every
--                    existing row) = all of it to to_node_id, as before. When
--                    set, to_node_id is its first element (kept in step, as
--                    months is with monthly_rate_m3s), so a reader of
--                    to_node_id alone still sees the main destination.
--   split_pct        each destination's share, 0 < p <= 1, adding up to 1
--                    (within 0.0001); NULL exactly when split_node_ids is.
--   monthly_diversion_coefficient, _exponent, _max_pct
--                    a diversion curve per water-year month (Oct–Sep), twelve
--                    elements each: a month with a NULL coefficient takes up to
--                    its rate (a maximum); one with a coefficient takes a ·
--                    x^b percent of the river, at most its largest share (NULL
--                    = 1). Only on a 'diversionCurve' rule, and then the one
--                    curve of 308 (diversion_coefficient, …) is NULL. NULL
--                    (every existing row) = 308's one curve in every month.
--
-- Arrays on the transfer row, not a child table: the rule is saved whole (the
-- model save rewrites it), nothing references a destination on its own, and
-- transfer's own RLS policies then cover them, where a child table's farmer
-- policy and transfer's would have to read each other (a recursive policy).
-- What a foreign key would give, the triggers below give: each destination is
-- a node of the same project (transfer_split_same_project), and deleting a
-- node deletes the rules that send to it (transfer_split_node_deleted), as
-- to_node_id's ON DELETE CASCADE does for the first. A farmer linked to any
-- destination sees the rule, as one linked to to_node_id does (020).
--
-- New columns on an existing table: the table-level grants to water_app (001)
-- cover them; no foreign key, so no index. Every existing row keeps NULLs and
-- runs as before; no data is rewritten.

CREATE FUNCTION transfer_split_valid(nodes uuid[], pcts double precision[]) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT (nodes IS NULL AND pcts IS NULL)
			OR (nodes IS NOT NULL AND pcts IS NOT NULL
				AND array_ndims(nodes) = 1 AND array_ndims(pcts) = 1
				AND cardinality(nodes) BETWEEN 2 AND 5 AND cardinality(pcts) = cardinality(nodes)
				AND NOT EXISTS (SELECT 1 FROM unnest(pcts) p WHERE p IS NULL OR NOT (p > 0 AND p <= 1))
				AND abs((SELECT sum(p) FROM unnest(pcts) p) - 1) <= 0.0001
				AND (SELECT count(DISTINCT coalesce(n::text, '-')) FROM unnest(nodes) n) = cardinality(nodes))
	$$;
COMMENT ON FUNCTION transfer_split_valid(uuid[], double precision[]) IS
	'transfer.split_*: both NULL, or two to five destinations (no one twice) with shares 0 < p <= 1 adding up to 1 within 0.0001. Engine >= 1.114.0.';

CREATE FUNCTION transfer_monthly_diversion_valid(a double precision[], b double precision[], m double precision[]) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT (a IS NULL AND b IS NULL AND m IS NULL)
			OR (a IS NOT NULL AND b IS NOT NULL AND m IS NOT NULL
				AND array_ndims(a) = 1 AND array_ndims(b) = 1 AND array_ndims(m) = 1
				AND cardinality(a) = 12 AND cardinality(b) = 12 AND cardinality(m) = 12
				AND EXISTS (SELECT 1 FROM unnest(a) x WHERE x IS NOT NULL)
				AND NOT EXISTS (
					SELECT 1 FROM unnest(a, b, m) AS u(ca, cb, cm)
					WHERE (ca IS NULL) <> (cb IS NULL)
						OR (ca IS NULL AND cm IS NOT NULL)
						OR NOT (ca IS NULL OR (ca > 0 AND ca < 'Infinity'::float8))
						OR NOT (cb IS NULL OR (cb > '-Infinity'::float8 AND cb < 'Infinity'::float8))
						OR NOT (cm IS NULL OR (cm > 0 AND cm <= 1))))
	$$;
COMMENT ON FUNCTION transfer_monthly_diversion_valid(double precision[], double precision[], double precision[]) IS
	'transfer.monthly_diversion_*: all NULL, or twelve months each a curve (a > 0, finite b, 0 < m <= 1 or NULL) or none (all three NULL), at least one a curve. Engine >= 1.114.0.';

ALTER TABLE transfer
	ADD COLUMN split_node_ids uuid[],
	ADD COLUMN split_pct double precision[],
	ADD COLUMN monthly_diversion_coefficient double precision[],
	ADD COLUMN monthly_diversion_exponent double precision[],
	ADD COLUMN monthly_diversion_max_pct double precision[],
	ADD CONSTRAINT transfer_split CHECK (transfer_split_valid(split_node_ids, split_pct)),
	ADD CONSTRAINT transfer_split_first CHECK (split_node_ids IS NULL OR to_node_id IS NOT DISTINCT FROM split_node_ids[1]),
	ADD CONSTRAINT transfer_split_external_from_dam CHECK (split_node_ids IS NULL OR source = 'dam' OR array_position(split_node_ids, NULL) IS NULL),
	ADD CONSTRAINT transfer_split_not_source CHECK (split_node_ids IS NULL OR array_position(split_node_ids, from_node_id) IS NULL),
	ADD CONSTRAINT transfer_monthly_diversion CHECK (transfer_monthly_diversion_valid(monthly_diversion_coefficient, monthly_diversion_exponent, monthly_diversion_max_pct)),
	ADD CONSTRAINT transfer_monthly_diversion_sizing CHECK (
		monthly_diversion_coefficient IS NULL
		OR (sizing = 'diversionCurve' AND diversion_coefficient IS NULL AND diversion_exponent IS NULL AND diversion_max_pct IS NULL)
	);

-- 308's rule needed the one curve; a curve by month stands in for it.
ALTER TABLE transfer DROP CONSTRAINT transfer_diversion_curve;
ALTER TABLE transfer ADD CONSTRAINT transfer_diversion_curve CHECK (
	sizing <> 'diversionCurve'
	OR (diversion_flow_unit IS NOT NULL
		AND ((diversion_coefficient IS NOT NULL AND diversion_exponent IS NOT NULL) OR monthly_diversion_coefficient IS NOT NULL))
);

-- Each destination a node of the rule's own project (as assert_same_project checks to_node_id).
CREATE FUNCTION transfer_split_same_project() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		bad uuid;
	BEGIN
		IF NEW.split_node_ids IS NULL THEN
			RETURN NEW;
		END IF;
		SELECT n INTO bad FROM unnest(NEW.split_node_ids) n
			WHERE n IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node WHERE node.id = n AND node.project_id = NEW.project_id)
			LIMIT 1;
		IF bad IS NOT NULL THEN
			RAISE EXCEPTION 'split_node_ids % belongs to a different project', bad USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER transfer_split_same_project BEFORE INSERT OR UPDATE OF split_node_ids, project_id ON transfer
	FOR EACH ROW EXECUTE FUNCTION transfer_split_same_project();

-- Deleting a node deletes the rules that send any share to it (to_node_id's ON DELETE CASCADE, for every destination).
CREATE FUNCTION transfer_split_node_deleted() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		DELETE FROM transfer WHERE project_id = OLD.project_id AND split_node_ids @> ARRAY[OLD.id];
		RETURN OLD;
	END
	$$;
CREATE TRIGGER transfer_split_node_deleted AFTER DELETE ON node
	FOR EACH ROW EXECUTE FUNCTION transfer_split_node_deleted();

-- A farmer sees a rule with any destination on their farm (020's two arms, and the split's).
DROP POLICY transfer_select_farmer ON transfer;
CREATE POLICY transfer_select_farmer ON transfer FOR SELECT
	USING (
		from_node_id IN (SELECT app_farm_nodes(project_id))
		OR to_node_id IN (SELECT app_farm_nodes(project_id))
		OR split_node_ids && ARRAY(SELECT app_farm_nodes(project_id))
	);

COMMENT ON COLUMN transfer.split_node_ids IS
	'The destinations of a rule split between two to five, in order (NULL element = outside the catchment, a dam rule only); to_node_id is the first. NULL = all of it to to_node_id. Engine >= 1.114.0.';
COMMENT ON COLUMN transfer.split_pct IS
	'Each split destination''s share, 0 < p <= 1, adding up to 1. NULL exactly when split_node_ids is. Engine >= 1.114.0.';
COMMENT ON COLUMN transfer.monthly_diversion_coefficient IS
	'river, sizing diversionCurve: a of each water-year month''s curve (Oct–Sep); a NULL element = a month up to its rate. NULL = the one curve (diversion_coefficient) every month. Engine >= 1.114.0.';
COMMENT ON COLUMN transfer.monthly_diversion_exponent IS
	'river, sizing diversionCurve: b of each water-year month''s curve; NULL where the month has none. Engine >= 1.114.0.';
COMMENT ON COLUMN transfer.monthly_diversion_max_pct IS
	'river, sizing diversionCurve: each month''s largest share 0 < m <= 1 (NULL = 1; NULL where the month has no curve). Engine >= 1.114.0.';
