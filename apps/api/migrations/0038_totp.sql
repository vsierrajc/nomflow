CREATE TABLE "account_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_totp" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"secret_sealed" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "two_factor_challenges" ALTER COLUMN "code_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "two_factor_method" text DEFAULT 'EMAIL' NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor_challenges" ADD COLUMN "method" text DEFAULT 'EMAIL' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_recovery_codes" ADD CONSTRAINT "account_recovery_codes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_totp" ADD CONSTRAINT "account_totp_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_recovery_codes_account_idx" ON "account_recovery_codes" USING btree ("account_id");