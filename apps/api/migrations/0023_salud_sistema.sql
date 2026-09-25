CREATE TABLE "health_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_key" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "health_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"storage_warn_free_pct" integer DEFAULT 20 NOT NULL,
	"storage_crit_free_pct" integer DEFAULT 10 NOT NULL,
	"db_warn_ms" integer DEFAULT 500 NOT NULL,
	"db_crit_ms" integer DEFAULT 2000 NOT NULL,
	"object_errors_warn" integer DEFAULT 3 NOT NULL,
	"object_errors_crit" integer DEFAULT 10 NOT NULL,
	"error_window_min" integer DEFAULT 60 NOT NULL,
	"check_interval_min" integer DEFAULT 5 NOT NULL,
	"renotify_min" integer DEFAULT 360 NOT NULL,
	"extra_recipients" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "health_settings" ADD CONSTRAINT "health_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "health_alerts_open_uq" ON "health_alerts" USING btree ("check_key") WHERE "health_alerts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "health_alerts_opened_idx" ON "health_alerts" USING btree ("opened_at");