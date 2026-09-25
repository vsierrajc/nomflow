CREATE TABLE "certificate_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"c_emp" text NOT NULL,
	"account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"tier" text DEFAULT 'PRINCIPAL' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"signature" "bytea",
	"signature_content_type" text,
	"signature_sha256" text,
	"consent_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificate_requests" ADD COLUMN "signer_account_id" uuid;--> statement-breakpoint
ALTER TABLE "certificate_requests" ADD COLUMN "signer_name" text;--> statement-breakpoint
ALTER TABLE "certificate_requests" ADD COLUMN "signer_title" text;--> statement-breakpoint
ALTER TABLE "certificate_requests" ADD COLUMN "signature_sha256" text;--> statement-breakpoint
ALTER TABLE "certificate_signers" ADD CONSTRAINT "certificate_signers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_signers" ADD CONSTRAINT "certificate_signers_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_signers_uq" ON "certificate_signers" USING btree ("c_emp","account_id");--> statement-breakpoint
ALTER TABLE "certificate_requests" ADD CONSTRAINT "certificate_requests_signer_account_id_accounts_id_fk" FOREIGN KEY ("signer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;