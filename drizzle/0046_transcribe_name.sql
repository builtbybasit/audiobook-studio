-- "Check by ear" is now Transcribe: the book switch, the job kind (and its active key and run
-- detail) and the flag a mismatch raises, in live lines and in kept script versions.
ALTER TABLE `books` RENAME COLUMN `check_by_ear` TO `auto_transcribe`;--> statement-breakpoint
UPDATE `jobs` SET `kind` = 'transcribe', `active_key` = CASE WHEN `active_key` IS NULL THEN NULL ELSE 'transcribe' || substr(`active_key`, 6) END WHERE `kind` = 'check';--> statement-breakpoint
UPDATE `jobs` SET `run` = replace(replace(`run`, '"checkRun":', '"transcribeRun":'), '"checked":', '"transcribed":') WHERE `kind` = 'transcribe' AND `run` IS NOT NULL;--> statement-breakpoint
UPDATE `jobs` SET `label` = 'Transcribe' WHERE `kind` = 'transcribe' AND `label` = 'Check';--> statement-breakpoint
UPDATE `jobs` SET `bulk_op` = 'Transcribe' WHERE `kind` = 'transcribe' AND `bulk_op` = 'Check';--> statement-breakpoint
UPDATE `segments` SET `flag` = replace(`flag`, '"kind":"heard"', '"kind":"mismatch"') WHERE `flag` LIKE '%"kind":"heard"%';--> statement-breakpoint
UPDATE `script_versions` SET `segments` = replace(`segments`, '"kind":"heard"', '"kind":"mismatch"') WHERE `segments` LIKE '%"kind":"heard"%';--> statement-breakpoint
UPDATE `previous_scripts` SET `segments` = replace(`segments`, '"kind":"heard"', '"kind":"mismatch"') WHERE `segments` LIKE '%"kind":"heard"%';
