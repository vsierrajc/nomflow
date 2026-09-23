CREATE TYPE "public"."catalog_type" AS ENUM('AREA', 'CCOSTO', 'CARGO', 'TIPO_CONTRATO');--> statement-breakpoint
CREATE TABLE "catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "catalog_type" NOT NULL,
	"c_emp" text DEFAULT '' NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_entry_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"old_name" text NOT NULL,
	"new_name" text NOT NULL,
	"batch_id" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"c_emp" text NOT NULL,
	"nombre" text NOT NULL,
	"sigla" text NOT NULL,
	"direccion" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_entry_history" ADD CONSTRAINT "catalog_entry_history_entry_id_catalog_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."catalog_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_entries_key_uq" ON "catalog_entries" USING btree ("type","c_emp","code");--> statement-breakpoint
CREATE INDEX "catalog_entry_history_entry_idx" ON "catalog_entry_history" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_c_emp_uq" ON "companies" USING btree ("c_emp");