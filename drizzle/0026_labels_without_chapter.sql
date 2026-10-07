-- A label names the work and never the chapter: the page puts the chapter in by its reading number,
-- the one a person sees, where a stored "ch 4" was the chapter's id — the cover and contents pages
-- counted — and went stale the moment a chapter was skipped or kept. So " · ch 4" comes out of every
-- job's label: "Script · ch 4 · DeepSeek" is "Script · DeepSeek", "Narrate · ch 4" is "Narrate".
UPDATE `jobs` SET `label` = s.`head` || s.`tail`
FROM (
  SELECT `id`, `head`,
    CASE WHEN instr(`rest`, ' · ') = 0 THEN `rest` ELSE substr(`rest`, 1, instr(`rest`, ' · ') - 1) END AS `n`,
    CASE WHEN instr(`rest`, ' · ') = 0 THEN '' ELSE substr(`rest`, instr(`rest`, ' · ')) END AS `tail`
  FROM (
    SELECT `id`, substr(`label`, 1, instr(`label`, ' · ch ') - 1) AS `head`,
      substr(`label`, instr(`label`, ' · ch ') + 6) AS `rest`
    FROM `jobs` WHERE instr(`label`, ' · ch ') > 0
  )
) AS s
WHERE `jobs`.`id` = s.`id` AND s.`n` <> '' AND s.`n` NOT GLOB '*[^0-9]*';--> statement-breakpoint
-- The ledger's labels the same way ("Script chunk 2 · ch 4" is "Script chunk 2"), and a check's,
-- which named the chapter by its title, a spoiler for a chapter not yet read, is "Check". Only where
-- the chapter is still in the book, which the Activity list names beside the label: once it has
-- gone, the frozen label is the one trace left of which chapter the money went on, and stays.
UPDATE `requests` SET `label` = s.`head` || s.`tail`
FROM (
  SELECT `id`, `head`,
    CASE WHEN instr(`rest`, ' · ') = 0 THEN `rest` ELSE substr(`rest`, 1, instr(`rest`, ' · ') - 1) END AS `n`,
    CASE WHEN instr(`rest`, ' · ') = 0 THEN '' ELSE substr(`rest`, instr(`rest`, ' · ')) END AS `tail`
  FROM (
    SELECT `id`, substr(`label`, 1, instr(`label`, ' · ch ') - 1) AS `head`,
      substr(`label`, instr(`label`, ' · ch ') + 6) AS `rest`
    FROM `requests` WHERE instr(`label`, ' · ch ') > 0 AND `chapter_uid` IS NOT NULL
  )
) AS s
WHERE `requests`.`id` = s.`id` AND s.`n` <> '' AND s.`n` NOT GLOB '*[^0-9]*';--> statement-breakpoint
UPDATE `requests` SET `label` = 'Check' WHERE `label` LIKE 'Check · %' AND `chapter_uid` IS NOT NULL;
