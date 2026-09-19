CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`author` text NOT NULL,
	`cover_from` text NOT NULL,
	`cover_to` text NOT NULL,
	`added_at` integer NOT NULL,
	`importing` integer DEFAULT false NOT NULL,
	`budget_cap` real,
	`budget_paused` integer,
	`script_budget` real,
	`pacing_line` real,
	`pacing_turn` real
);
--> statement-breakpoint
CREATE TABLE `chapter_texts` (
	`book_id` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`book_id`, `chapter_id`),
	FOREIGN KEY (`book_id`,`chapter_id`) REFERENCES `chapters`(`book_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chapters` (
	`book_id` text NOT NULL,
	`id` integer NOT NULL,
	`uid` text NOT NULL,
	`volume_id` integer NOT NULL,
	`volume_index` integer NOT NULL,
	`title` text NOT NULL,
	`words` integer NOT NULL,
	`scripting` text DEFAULT 'none' NOT NULL,
	`scripting_progress` real DEFAULT 0 NOT NULL,
	`narration` text DEFAULT 'none' NOT NULL,
	`narration_progress` real DEFAULT 0 NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`excluded` integer,
	`kept` integer,
	`note` text,
	PRIMARY KEY(`book_id`, `id`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chapters_book_volume` ON `chapters` (`book_id`,`volume_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chapters_uid` ON `chapters` (`uid`);--> statement-breakpoint
CREATE TABLE `volumes` (
	`book_id` text NOT NULL,
	`id` integer NOT NULL,
	`name` text NOT NULL,
	`file` text NOT NULL,
	`from_index` integer NOT NULL,
	`to_index` integer NOT NULL,
	`position` integer NOT NULL,
	`importing` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`book_id`, `id`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `characters` (
	`book_id` text NOT NULL,
	`name` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`gender` text DEFAULT '?' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`voice` text,
	`style` text DEFAULT '' NOT NULL,
	`color` text NOT NULL,
	`major` integer DEFAULT false NOT NULL,
	`is_new` integer,
	`keep` integer,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`book_id`, `name`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `lexicon_entries` (
	`book_id` text NOT NULL,
	`id` integer NOT NULL,
	`term` text NOT NULL,
	`say` text NOT NULL,
	`ipa` text,
	`note` text,
	`match_case` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`book_id`, `id`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lexicon_book_term` ON `lexicon_entries` (`book_id`,`term`);--> statement-breakpoint
CREATE TABLE `clips` (
	`book_id` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`segment_id` integer NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role` text NOT NULL,
	`n` integer,
	`status` text DEFAULT 'none' NOT NULL,
	`endpoint` text,
	`ms` real DEFAULT 0 NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`url` text,
	`started_at` integer,
	`at` integer,
	`voice_ref` text,
	`voice` text,
	`model` text,
	`direction` text,
	`style` text,
	`instructions` text,
	`type` text,
	`text` text,
	`said` text,
	`lex` integer,
	`pronounced` text,
	`expression_signature` text,
	`expressions` text,
	`parts` integer,
	`split_at` text,
	`cuts` text,
	`auto` integer,
	`rejected` integer,
	`cost` real,
	`charge` text,
	`error` text,
	FOREIGN KEY (`book_id`,`chapter_id`,`segment_id`) REFERENCES `segments`(`book_id`,`chapter_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `clips_segment` ON `clips` (`book_id`,`chapter_id`,`segment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `clips_one_per_role` ON `clips` (`book_id`,`chapter_id`,`segment_id`,`role`) WHERE role <> 'take';--> statement-breakpoint
CREATE TABLE `previous_scripts` (
	`book_id` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`segments` text NOT NULL,
	`corrections` text,
	PRIMARY KEY(`book_id`, `chapter_id`),
	FOREIGN KEY (`book_id`,`chapter_id`) REFERENCES `chapters`(`book_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `script_heads` (
	`book_id` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`at` integer NOT NULL,
	`origin` text NOT NULL,
	`open` integer,
	`next_id` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`book_id`, `chapter_id`),
	FOREIGN KEY (`book_id`,`chapter_id`) REFERENCES `chapters`(`book_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `script_versions` (
	`book_id` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`id` integer NOT NULL,
	`at` integer NOT NULL,
	`origin` text NOT NULL,
	`segments` text NOT NULL,
	PRIMARY KEY(`book_id`, `chapter_id`, `id`),
	FOREIGN KEY (`book_id`,`chapter_id`) REFERENCES `chapters`(`book_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `script_versions_chapter` ON `script_versions` (`book_id`,`chapter_id`,`at`);--> statement-breakpoint
CREATE TABLE `segments` (
	`book_id` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`id` integer NOT NULL,
	`position` integer NOT NULL,
	`type` text NOT NULL,
	`speaker` text NOT NULL,
	`text` text NOT NULL,
	`direction` text DEFAULT '' NOT NULL,
	`fallback` integer,
	`fallback_count` integer,
	`fallback_mismatch` text,
	`edited` integer,
	`pause` real,
	`sep` text,
	`flag` text,
	`expressions` text,
	PRIMARY KEY(`book_id`, `chapter_id`, `id`),
	FOREIGN KEY (`book_id`,`chapter_id`) REFERENCES `chapters`(`book_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `segments_chapter_order` ON `segments` (`book_id`,`chapter_id`,`position`);--> statement-breakpoint
CREATE INDEX `segments_speaker` ON `segments` (`book_id`,`speaker`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`note` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`model` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`concurrency` integer DEFAULT 1 NOT NULL,
	`needs_key` integer DEFAULT false NOT NULL,
	`max_chars` integer DEFAULT 0 NOT NULL,
	`split_at` text DEFAULT 'sentence' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`in_price` real,
	`out_price` real,
	`cached_input` real,
	`cache_write` real,
	`max_output_tokens` integer,
	`sec_per_chunk` real,
	`billing_unit` text,
	`billing_rate` real,
	`billing_audio_rate` real,
	`audio_tokens_per_second` real,
	`bills_instructions` integer,
	`parked_rates` text,
	`price` real,
	`timezone` text,
	`timeout_sec` integer,
	`max_retries` integer,
	`cooldown_sec` integer,
	`spend_limit` real,
	`credential_id` text,
	`quota_group` text,
	`latency` real,
	`fail_rate` real,
	`expression_status` text,
	`expression_model` text,
	`expression_base_url` text,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `endpoints_kind` ON `endpoints` (`kind`,`position`);--> statement-breakpoint
CREATE TABLE `expression_tags` (
	`endpoint_id` text NOT NULL,
	`id` text NOT NULL,
	`label` text NOT NULL,
	`token` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`endpoint_id`, `id`),
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `promotions` (
	`endpoint_id` text NOT NULL,
	`id` text NOT NULL,
	`label` text NOT NULL,
	`from_at` integer,
	`until_at` integer,
	`scope` text NOT NULL,
	`percent` real,
	`rates` text,
	`note` text,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`endpoint_id`, `id`),
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `promotions_window` ON `promotions` (`endpoint_id`,`from_at`,`until_at`);--> statement-breakpoint
CREATE TABLE `rate_windows` (
	`endpoint_id` text NOT NULL,
	`id` text NOT NULL,
	`label` text NOT NULL,
	`days` text DEFAULT '[]' NOT NULL,
	`from_minute` integer NOT NULL,
	`to_minute` integer NOT NULL,
	`percent` real,
	`rates` text,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`endpoint_id`, `id`),
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `voices` (
	`endpoint_id` text NOT NULL,
	`id` text NOT NULL,
	`label` text NOT NULL,
	`gender` text DEFAULT '?' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`endpoint_id`, `id`),
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `job_events` (
	`job_id` integer NOT NULL,
	`id` integer NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`detail` text,
	PRIMARY KEY(`job_id`, `id`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_events_time` ON `job_events` (`job_id`,`at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`book_id` text NOT NULL,
	`chapter_id` integer,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`cancelled` integer DEFAULT false NOT NULL,
	`waiting_reason` text,
	`bulk_id` integer,
	`bulk_op` text,
	`bulk_index` integer,
	`bulk_total` integer,
	`bulk_scope` text,
	`reserved` real DEFAULT 0 NOT NULL,
	`estimated` real,
	`run` text,
	`dropped_events` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`book_id`,`chapter_id`) REFERENCES `chapters`(`book_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_book` ON `jobs` (`book_id`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_bulk` ON `jobs` (`bulk_id`,`bulk_index`);--> statement-breakpoint
CREATE INDEX `jobs_reserved` ON `jobs` (`book_id`,`status`);--> statement-breakpoint
CREATE TABLE `export_chapters` (
	`export_id` integer NOT NULL,
	`book_id` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`position` integer NOT NULL,
	`file_index` integer,
	`title` text,
	`duration` real,
	`signature` text,
	PRIMARY KEY(`export_id`, `chapter_id`),
	FOREIGN KEY (`export_id`) REFERENCES `exports`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`book_id`,`chapter_id`) REFERENCES `chapters`(`book_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `export_chapters_order` ON `export_chapters` (`export_id`,`position`);--> statement-breakpoint
CREATE TABLE `export_files` (
	`export_id` integer NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`size` real DEFAULT 0 NOT NULL,
	`markers` integer DEFAULT 0 NOT NULL,
	`volume` text,
	PRIMARY KEY(`export_id`, `position`),
	FOREIGN KEY (`export_id`) REFERENCES `exports`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `exports` (
	`id` integer PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`key` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`replaces` integer,
	`status` text NOT NULL,
	`progress` real,
	`error` text,
	`job_id` integer,
	`filename` text NOT NULL,
	`title` text NOT NULL,
	`series` text DEFAULT '' NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`narrator` text DEFAULT '' NOT NULL,
	`year` integer,
	`description` text DEFAULT '' NOT NULL,
	`custom_cover` integer,
	`format` text NOT NULL,
	`grouping` text NOT NULL,
	`bitrate` integer,
	`chapter_gap` real,
	`normalize` integer,
	`loudness` integer,
	`chapter_count` integer DEFAULT 0 NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`size` real DEFAULT 0 NOT NULL,
	`markers` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`scope` text,
	`settings` text,
	`rebuilt` integer,
	`reused` integer,
	`stale` integer,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `exports_book` ON `exports` (`book_id`,`id`);--> statement-breakpoint
CREATE INDEX `exports_key` ON `exports` (`book_id`,`key`,`version`);--> statement-breakpoint
CREATE TABLE `opening_spend` (
	`book_id` text PRIMARY KEY NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`kind` text NOT NULL,
	`book_id` text,
	`chapter_uid` text,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`queue_ms` real DEFAULT 0 NOT NULL,
	`response_ms` real DEFAULT 0 NOT NULL,
	`waiting` text,
	`rate_limited` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_input` integer,
	`cache_write` integer,
	`chars` integer,
	`bytes` integer,
	`text_tokens` integer,
	`audio_seconds` real,
	`audio_tokens` integer,
	`cost` real,
	`cost_basis` text NOT NULL,
	`priced` text,
	`speech` text,
	`error` text,
	`simulated` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`chapter_uid`) REFERENCES `chapters`(`uid`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `requests_endpoint_time` ON `requests` (`endpoint_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `requests_book` ON `requests` (`book_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `requests_chapter` ON `requests` (`chapter_uid`);--> statement-breakpoint
CREATE INDEX `requests_status` ON `requests` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
