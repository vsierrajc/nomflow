CREATE TABLE "log_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"kind" text,
	"period_from" timestamp with time zone,
	"period_to" timestamp with time zone,
	"row_count" integer DEFAULT 0 NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"purged_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"retention_days" integer DEFAULT 365 NOT NULL,
	"http_retention_days" integer DEFAULT 90 NOT NULL,
	"archive_before_purge" boolean DEFAULT true NOT NULL,
	"auto_enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"last_run_summary" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "log_archives" ADD CONSTRAINT "log_archives_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_settings" ADD CONSTRAINT "log_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_archives_created_idx" ON "log_archives" USING btree ("created_at");