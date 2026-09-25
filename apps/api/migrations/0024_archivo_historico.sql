CREATE TABLE "archive_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"endpoint" text DEFAULT 'https://storage.googleapis.com' NOT NULL,
	"region" text DEFAULT 'us-central1' NOT NULL,
	"bucket" text DEFAULT 'nomflow' NOT NULL,
	"access_key_id" text,
	"secret_enc" text,
	"age_days" integer DEFAULT 365 NOT NULL,
	"grace_days" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"last_run_summary" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archived_objects" (
	"object_key" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"local_deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "archive_settings" ADD CONSTRAINT "archive_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archived_objects_status_idx" ON "archived_objects" USING btree ("status");