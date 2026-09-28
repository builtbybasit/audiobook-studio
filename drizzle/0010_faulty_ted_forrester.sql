CREATE TABLE `speaker_sample_files` (
	`sample_id` integer NOT NULL,
	`file` text NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`bytes` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`sample_id`, `file`),
	FOREIGN KEY (`sample_id`) REFERENCES `speaker_samples`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `speaker_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` text NOT NULL,
	`speaker` text NOT NULL,
	`title` text NOT NULL,
	`consent_at` integer NOT NULL,
	`consent_text` text NOT NULL,
	`source` text NOT NULL,
	`stored_at` integer NOT NULL,
	`discarded_at` integer,
	FOREIGN KEY (`book_id`,`speaker`) REFERENCES `characters`(`book_id`,`name`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `speaker_samples_book` ON `speaker_samples` (`book_id`);