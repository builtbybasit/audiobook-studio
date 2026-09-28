CREATE TABLE `clone_fees` (
	`endpoint_id` text NOT NULL,
	`voice_id` text NOT NULL,
	`title` text NOT NULL,
	`usd` real,
	`said` text NOT NULL,
	`made_at` integer NOT NULL,
	PRIMARY KEY(`endpoint_id`, `voice_id`)
);
