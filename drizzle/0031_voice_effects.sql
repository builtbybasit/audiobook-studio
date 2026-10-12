CREATE TABLE `effects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`chain` text NOT NULL,
	`position` integer
);
--> statement-breakpoint
ALTER TABLE `books` ADD `thoughts` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `effect` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `thoughts` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `sound` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `raw` text;--> statement-breakpoint
-- The thought effect narration has run through ffmpeg since 0024, written as a Pedalboard chain:
-- the same highpass, lowpass, cut at 2.5 kHz, compression and level, with Pedalboard's own reverb
-- for the small room ffmpeg could only fake with echoes. It is the library's thought effect.
INSERT INTO `effects` (`id`, `name`, `chain`, `position`) VALUES ('inner-voice', 'Inner voice', '[{"plugin":"HighpassFilter","params":{"cutoff_frequency_hz":220},"on":true},{"plugin":"LowpassFilter","params":{"cutoff_frequency_hz":6000},"on":true},{"plugin":"PeakFilter","params":{"cutoff_frequency_hz":2500,"gain_db":-4,"q":1},"on":true},{"plugin":"Compressor","params":{"threshold_db":-20,"ratio":3},"on":true},{"plugin":"Reverb","params":{"room_size":0.12,"damping":0.5,"wet_level":0.18,"dry_level":0.9},"on":true},{"plugin":"Gain","params":{"gain_db":-1},"on":true}]', 0);--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`) VALUES ('thoughts', '"inner-voice"');--> statement-breakpoint
-- A book that narrated its thoughts plain chooses no thought effect; every other follows the library.
UPDATE `books` SET `thoughts` = 'none' WHERE `plain_thoughts` = 1;--> statement-breakpoint
-- A clip given the ffmpeg thought effect says so. No raw file was kept, so it cannot be re-applied.
UPDATE `clips` SET `sound` = 'ffmpeg' WHERE `effect` = 'thought';--> statement-breakpoint
ALTER TABLE `books` DROP COLUMN `plain_thoughts`;--> statement-breakpoint
ALTER TABLE `clips` DROP COLUMN `effect`;
