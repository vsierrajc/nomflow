CREATE TABLE "document_export_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"export_id" uuid NOT NULL,
	"downloaded_by" uuid NOT NULL,
	"downloaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "document_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" uuid,
	"request_kind" text NOT NULL,
	"reason" text,
	"n_ide" text NOT NULL,
	"employee_id" uuid,
	"exit_schedule_id" uuid,
	"status" text DEFAULT 'PENDIENTE' NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_report" jsonb,
	"object_key" text,
	"sha256" text,
	"size_bytes" integer,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error_detail" text
);
--> statement-breakpoint
CREATE TABLE "employee_exit_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"n_ide" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"planned_date" date NOT NULL,
	"reason" text NOT NULL,
	"scheduled_by" uuid NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'PENDIENTE' NOT NULL,
	"notice_sent_at" timestamp with time zone,
	"notice_channel" text,
	"param_version" text,
	"export_id" uuid,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exit_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"pre_baja_aviso_dias" integer DEFAULT 15 NOT NULL,
	"zip_expiry_days" integer DEFAULT 7 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_export_downloads" ADD CONSTRAINT "document_export_downloads_export_id_document_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."document_exports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export_downloads" ADD CONSTRAINT "document_export_downloads_downloaded_by_accounts_id_fk" FOREIGN KEY ("downloaded_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_exports" ADD CONSTRAINT "document_exports_requested_by_accounts_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_exports" ADD CONSTRAINT "document_exports_employee_id_employee_snapshots_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_exports" ADD CONSTRAINT "document_exports_exit_schedule_id_employee_exit_schedules_id_fk" FOREIGN KEY ("exit_schedule_id") REFERENCES "public"."employee_exit_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_exit_schedules" ADD CONSTRAINT "employee_exit_schedules_employee_id_employee_snapshots_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_exit_schedules" ADD CONSTRAINT "employee_exit_schedules_scheduled_by_accounts_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_settings" ADD CONSTRAINT "exit_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_export_downloads_export_idx" ON "document_export_downloads" USING btree ("export_id");--> statement-breakpoint
CREATE INDEX "document_exports_nide_idx" ON "document_exports" USING btree ("n_ide","requested_at");--> statement-breakpoint
CREATE INDEX "document_exports_status_idx" ON "document_exports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "employee_exit_schedules_nide_idx" ON "employee_exit_schedules" USING btree ("n_ide");--> statement-breakpoint
CREATE INDEX "employee_exit_schedules_status_idx" ON "employee_exit_schedules" USING btree ("status","planned_date");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_exit_schedules_one_active_uq" ON "employee_exit_schedules" USING btree ("n_ide") WHERE "employee_exit_schedules"."status" in ('PENDIENTE','AVISADO');