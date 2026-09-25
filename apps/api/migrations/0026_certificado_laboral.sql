CREATE TABLE "certificate_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"n_ide" text NOT NULL,
	"n_cont" text NOT NULL,
	"c_emp" text NOT NULL,
	"kind" text NOT NULL,
	"addressee" text,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"doc_code" text NOT NULL,
	"doc_version" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificate_settings" (
	"c_emp" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'AMBOS' NOT NULL,
	"doc_code" text DEFAULT 'GH-FO-001' NOT NULL,
	"doc_version" text DEFAULT '01' NOT NULL,
	"doc_date" text DEFAULT '' NOT NULL,
	"city" text DEFAULT 'Barranquilla' NOT NULL,
	"signer_name" text DEFAULT '' NOT NULL,
	"signer_title" text DEFAULT '' NOT NULL,
	"footer_text" text DEFAULT '' NOT NULL,
	"max_per_day" integer DEFAULT 10 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificate_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"c_emp" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body_template" text NOT NULL,
	"status" text DEFAULT 'VIGENTE' NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificate_requests" ADD CONSTRAINT "certificate_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_requests" ADD CONSTRAINT "certificate_requests_template_id_certificate_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."certificate_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_settings" ADD CONSTRAINT "certificate_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "certificate_requests_account_idx" ON "certificate_requests" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "certificate_requests_created_idx" ON "certificate_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "certificate_requests_nide_idx" ON "certificate_requests" USING btree ("n_ide");--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_templates_version_uq" ON "certificate_templates" USING btree ("c_emp","kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_templates_current_uq" ON "certificate_templates" USING btree ("c_emp","kind") WHERE "certificate_templates"."status" = 'VIGENTE';