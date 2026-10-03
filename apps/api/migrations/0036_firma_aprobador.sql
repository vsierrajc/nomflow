CREATE TABLE "approver_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"signature" "bytea" NOT NULL,
	"content_type" text NOT NULL,
	"sha256" text NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approver_signatures_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "approver_signatures" ADD CONSTRAINT "approver_signatures_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;