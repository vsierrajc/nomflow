CREATE TABLE "payroll_download_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"version_id" uuid,
	"per" text NOT NULL,
	"n_liq" integer NOT NULL,
	"contrato" text NOT NULL,
	"mode" text NOT NULL,
	"result" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"n_ide" text NOT NULL,
	"contrato" text NOT NULL,
	"c_con" text NOT NULL,
	"concepto" text,
	"slrio" numeric(18, 6),
	"cant" numeric(18, 6),
	"ded" numeric(18, 6),
	"dev" numeric(18, 6),
	"tercero" text,
	"nombre_origen" text
);
--> statement-breakpoint
CREATE TABLE "payroll_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"per" text NOT NULL,
	"n_liq" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"content_hash" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_count" integer NOT NULL,
	"total_dev" numeric(18, 6) NOT NULL,
	"total_ded" numeric(18, 6) NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "payroll_default_mode" text DEFAULT 'ENTERO_SUPERIOR' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_download_audit" ADD CONSTRAINT "payroll_download_audit_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_version_id_payroll_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."payroll_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_versions" ADD CONSTRAINT "payroll_versions_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_download_audit_account_idx" ON "payroll_download_audit" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "payroll_lines_voucher_idx" ON "payroll_lines" USING btree ("n_ide","contrato","version_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_version_idx" ON "payroll_lines" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_versions_scope_version_uq" ON "payroll_versions" USING btree ("per","n_liq","version");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_versions_one_published_uq" ON "payroll_versions" USING btree ("per","n_liq") WHERE "payroll_versions"."status" = 'PUBLICADA';