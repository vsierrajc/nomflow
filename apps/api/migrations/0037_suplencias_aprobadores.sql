CREATE TABLE "approval_substitutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"titular_account_id" uuid NOT NULL,
	"substitute_account_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"status" text DEFAULT 'ACTIVA' NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_substitutions_range_ck" CHECK ("approval_substitutions"."valid_to" >= "approval_substitutions"."valid_from"),
	CONSTRAINT "approval_substitutions_max_ck" CHECK ("approval_substitutions"."valid_to" - "approval_substitutions"."valid_from" <= 89),
	CONSTRAINT "approval_substitutions_distinct_ck" CHECK ("approval_substitutions"."titular_account_id" <> "approval_substitutions"."substitute_account_id")
);
--> statement-breakpoint
ALTER TABLE "vacation_actions" ADD COLUMN "on_behalf_of_account_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_substitutions" ADD CONSTRAINT "approval_substitutions_titular_account_id_accounts_id_fk" FOREIGN KEY ("titular_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_substitutions" ADD CONSTRAINT "approval_substitutions_substitute_account_id_accounts_id_fk" FOREIGN KEY ("substitute_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_substitutions" ADD CONSTRAINT "approval_substitutions_ended_by_accounts_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_substitutions_titular_idx" ON "approval_substitutions" USING btree ("titular_account_id","valid_from");--> statement-breakpoint
CREATE INDEX "approval_substitutions_substitute_idx" ON "approval_substitutions" USING btree ("substitute_account_id","valid_from");--> statement-breakpoint
ALTER TABLE "vacation_actions" ADD CONSTRAINT "vacation_actions_on_behalf_of_account_id_accounts_id_fk" FOREIGN KEY ("on_behalf_of_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;