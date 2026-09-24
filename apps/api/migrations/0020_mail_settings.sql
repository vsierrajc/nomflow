CREATE TABLE "mail_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"secure" boolean DEFAULT false NOT NULL,
	"require_tls" boolean DEFAULT true NOT NULL,
	"username" text,
	"password_enc" text,
	"from_email" text NOT NULL,
	"from_name" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_status" text
);
--> statement-breakpoint
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;