-- 189_one_line_names — model names are one line (issue #385).
--
-- A node, crop, borehole or demand object name, and a demand schedule
-- window's label, are drawn as one line: in the schematic, the map's labels,
-- tables and report headings. The model schema took line breaks, tabs and
-- other control characters in them (a multi-line workbook cell, a pasted
-- name), and those render broken. From this change the API refuses them
-- (backend/src/model/validate.ts, the engine's NAME_CONTROL_CHARS) and the
-- workbook importers turn them into spaces (extract_project.py clean(), the
-- browser importer's clean()).
--
-- A name already stored with one would make its project unsaveable: the
-- editor sends the whole model back on every save, and the API would refuse
-- it. So this cleans what is stored, as the engine's cleanName does: every
-- run of whitespace and control characters one space, trimmed. A node or
-- crop name the cleaning makes equal (ignoring case) to another in its
-- project gets " (2)", " (3)" … (names are unique per project, and the
-- editor treats a case-only difference as a duplicate); one with nothing
-- left becomes "Unnamed". Then a CHECK holds every name to it, so no path
-- that skips the API (a script, a later migration) can store one again.
--
-- Not cleaned: records of the past. A run's input snapshot and a model
-- revision keep the names they were made with (restoring one cleans them
-- on the way in, history/routes.ts), and a scenario's stored ops keep
-- theirs, because ops_sha256 and any evidence pack pin those bytes.

-- The characters are the engine's NAME_CONTROL_CHARS (text can't hold NUL);
-- a name made one line has every run of them and of whitespace replaced.
DO $$
DECLARE
	t record;
	r record;
	base text;
	candidate text;
	n integer;
	taken boolean;
BEGIN
	FOR t IN SELECT * FROM (VALUES ('node', 100, true), ('crop', 100, true), ('borehole', 200, false), ('demand_object', 200, false)) AS v(tbl, max_len, uniq) LOOP
		FOR r IN EXECUTE format(
			'SELECT id, project_id, name FROM %I WHERE name ~ ''[\u0001-\u001f\u007f-\u009f\u2028\u2029]'' ORDER BY project_id, id', t.tbl
		) LOOP
			base := btrim(left(btrim(regexp_replace(r.name, '[[:space:]\u0001-\u001f\u007f-\u009f\u2028\u2029]+', ' ', 'g')), t.max_len));
			IF base = '' THEN base := 'Unnamed'; END IF;
			candidate := base;
			n := 1;
			LOOP
				taken := false;
				IF t.uniq THEN
					EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE project_id = $1 AND id <> $2 AND lower(name) = lower($3))', t.tbl)
						INTO taken USING r.project_id, r.id, candidate;
				END IF;
				EXIT WHEN NOT taken;
				n := n + 1;
				candidate := btrim(left(base, t.max_len - length(' (' || n || ')'))) || ' (' || n || ')';
			END LOOP;
			EXECUTE format('UPDATE %I SET name = $1 WHERE id = $2', t.tbl) USING candidate, r.id;
		END LOOP;
	END LOOP;
END $$;

-- Schedule window labels (105_demand_object_schedule): may be blank, so no fallback.
UPDATE demand_object d
SET schedule = (
	SELECT jsonb_agg(
		CASE WHEN jsonb_typeof(e.w -> 'label') = 'string'
			THEN jsonb_set(e.w, '{label}', to_jsonb(btrim(left(btrim(regexp_replace(e.w ->> 'label', '[[:space:]\u0001-\u001f\u007f-\u009f\u2028\u2029]+', ' ', 'g')), 200))))
			ELSE e.w END
		ORDER BY e.i)
	FROM jsonb_array_elements(d.schedule) WITH ORDINALITY AS e(w, i)
)
WHERE jsonb_typeof(d.schedule) = 'array'
	AND EXISTS (
		SELECT 1 FROM jsonb_array_elements(d.schedule) AS x(w)
		WHERE x.w ->> 'label' ~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
	);

ALTER TABLE node ADD CONSTRAINT node_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]');
ALTER TABLE crop ADD CONSTRAINT crop_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]');
ALTER TABLE borehole ADD CONSTRAINT borehole_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]');
ALTER TABLE demand_object ADD CONSTRAINT demand_object_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]');
