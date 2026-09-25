CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"request_type" text NOT NULL,
	"request_id" uuid NOT NULL,
	"step" text NOT NULL,
	"recipient_account_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"notify_approver" boolean DEFAULT true NOT NULL,
	"notify_employee" boolean DEFAULT true NOT NULL,
	"reminder_days" integer DEFAULT 3 NOT NULL,
	"app_url" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_recipient_account_id_accounts_id_fk" FOREIGN KEY ("recipient_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_log_request_idx" ON "notification_log" USING btree ("request_id","recipient_account_id","step");--> statement-breakpoint
CREATE INDEX "notification_log_sent_idx" ON "notification_log" USING btree ("sent_at");