CREATE TABLE "holiday_api_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"url" text NOT NULL,
	"api_key_enc" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_year" integer,
	"last_sync_status" text
);
--> statement-breakpoint
ALTER TABLE "holiday_api_settings" ADD CONSTRAINT "holiday_api_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;