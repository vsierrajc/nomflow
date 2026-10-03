CREATE TABLE "holiday_year_loads" (
	"year" integer PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status" text NOT NULL,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vacaciones" ADD COLUMN "annulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vacaciones" ADD COLUMN "annulled_by" uuid;--> statement-breakpoint
ALTER TABLE "vacaciones" ADD COLUMN "annul_reason" text;--> statement-breakpoint
ALTER TABLE "vacaciones" ADD CONSTRAINT "vacaciones_annulled_by_accounts_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;