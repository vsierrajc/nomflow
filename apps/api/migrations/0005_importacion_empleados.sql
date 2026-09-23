CREATE TYPE "public"."import_status" AS ENUM('RECIBIDO', 'VALIDANDO', 'OBSERVADO', 'LISTO', 'APLICANDO', 'APLICADO', 'FALLIDO');--> statement-breakpoint
CREATE TABLE "import_batch_rows" (
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "import_batch_rows_batch_id_row_number_pk" PRIMARY KEY("batch_id","row_number")
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" "import_status" DEFAULT 'RECIBIDO' NOT NULL,
	"file_hash" text NOT NULL,
	"file_name" text,
	"sheet_name" text,
	"source_system" text NOT NULL,
	"responsible" text NOT NULL,
	"created_by" uuid NOT NULL,
	"confirmed_by" uuid,
	"row_count" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "c_emp" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "nombre" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "c_cos" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "c_costo" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "s_act" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "c_car" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "c_area" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "fec_nac" date;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "cargo" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "hliq" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "sexo" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "f_ini" date;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "turno" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "nombres" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "apellidos" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "celular" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "profesion" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "nivel_educativo" text;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "tipo_contrato" text;--> statement-breakpoint
ALTER TABLE "import_batch_rows" ADD CONSTRAINT "import_batch_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_confirmed_by_accounts_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batches_type_hash_idx" ON "import_batches" USING btree ("type","file_hash");