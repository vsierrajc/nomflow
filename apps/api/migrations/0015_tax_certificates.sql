CREATE TABLE "tax_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"n_ide" text NOT NULL,
	"year" integer NOT NULL,
	"version" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"file_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tax_certificates" ADD CONSTRAINT "tax_certificates_uploaded_by_accounts_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_certificates_version_uq" ON "tax_certificates" USING btree ("n_ide","year","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_certificates_one_active_uq" ON "tax_certificates" USING btree ("n_ide","year") WHERE "tax_certificates"."active" = true;