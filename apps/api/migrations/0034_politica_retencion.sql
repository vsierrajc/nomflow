CREATE TABLE "data_retention_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"sessions_retention_days" integer DEFAULT 30 NOT NULL,
	"verification_codes_retention_days" integer DEFAULT 30 NOT NULL,
	"import_staging_retention_days" integer DEFAULT 90 NOT NULL,
	"auto_enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"last_run_summary" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_retention_settings" ADD CONSTRAINT "data_retention_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;