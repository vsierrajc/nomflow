ALTER TABLE "certificate_requests" ADD COLUMN "signature_mode" text;--> statement-breakpoint
ALTER TABLE "certificate_requests" ADD COLUMN "signer_cert_fingerprint" text;--> statement-breakpoint
ALTER TABLE "certificate_settings" ADD COLUMN "require_digital" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "certificate_signers" ADD COLUMN "digital_enc" text;--> statement-breakpoint
ALTER TABLE "certificate_signers" ADD COLUMN "digital_subject" text;--> statement-breakpoint
ALTER TABLE "certificate_signers" ADD COLUMN "digital_fingerprint" text;--> statement-breakpoint
ALTER TABLE "certificate_signers" ADD COLUMN "digital_not_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "certificate_signers" ADD COLUMN "digital_origin" text;--> statement-breakpoint
ALTER TABLE "certificate_signers" ADD COLUMN "digital_consent_at" timestamp with time zone;