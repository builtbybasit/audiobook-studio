CREATE TABLE `sample_fingerprints` (
	`file` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`vector` blob NOT NULL,
	`made_at` integer NOT NULL
);
