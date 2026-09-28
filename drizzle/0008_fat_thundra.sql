CREATE TABLE `cloned_voices` (
	`endpoint_id` text NOT NULL,
	`voice_id` text NOT NULL,
	`title` text NOT NULL,
	`made_at` integer NOT NULL,
	`consent_at` integer NOT NULL,
	`consent_text` text NOT NULL,
	`attached` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`endpoint_id`, `voice_id`)
);
--> statement-breakpoint
CREATE TABLE `voice_samples` (
	`endpoint_id` text NOT NULL,
	`voice_id` text NOT NULL,
	`file` text NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`bytes` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`endpoint_id`, `voice_id`, `file`),
	FOREIGN KEY (`endpoint_id`,`voice_id`) REFERENCES `cloned_voices`(`endpoint_id`,`voice_id`) ON UPDATE cascade ON DELETE cascade
);
