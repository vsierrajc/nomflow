CREATE TABLE "vacation_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tax_certificates" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_certificates" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "vacation_documents" ADD CONSTRAINT "vacation_documents_request_id_vacation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."vacation_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vacation_documents_request_uq" ON "vacation_documents" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "tax_certificates" ADD CONSTRAINT "tax_certificates_stored_ck" CHECK ("tax_certificates"."data" is not null or "tax_certificates"."object_key" is not null);