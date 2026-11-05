ALTER TABLE `books` ADD `pov_voice` integer;--> statement-breakpoint
-- The Said aloud effect: a POV character's speech, set apart from their narration.
INSERT OR IGNORE INTO `effects` (`id`, `name`, `chain`, `position`) VALUES ('said-aloud', 'Said aloud', '[{"plugin":"PeakFilter","params":{"cutoff_frequency_hz":3000,"gain_db":2,"q":0.8},"on":true},{"plugin":"Reverb","params":{"room_size":0.2,"damping":0.5,"wet_level":0.12,"dry_level":0.95,"width":0.6},"on":true}]', (SELECT COALESCE(MAX(`position`), -1) + 1 FROM `effects`));
