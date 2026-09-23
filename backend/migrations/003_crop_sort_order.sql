-- 003_crop_sort_order — user-defined display order for crops (like node.sort_order).
-- Display only: the engine doesn't depend on crop order.
ALTER TABLE crop ADD COLUMN sort_order integer NOT NULL DEFAULT 0;

-- Existing crops keep their current (alphabetical) order.
UPDATE crop c SET sort_order = o.rn
FROM (SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY name) - 1 AS rn FROM crop) o
WHERE o.id = c.id;
