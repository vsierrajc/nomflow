CREATE TYPE "public"."employment_status" AS ENUM('V', 'C');--> statement-breakpoint
CREATE TABLE "employee_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_batch_id" text,
	"n_ide" text NOT NULL,
	"n_cont" text NOT NULL,
	"email" text NOT NULL,
	"est" "employment_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "employee_snapshots_contract_uq" ON "employee_snapshots" USING btree ("n_ide","n_cont");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_snapshots_one_active_uq" ON "employee_snapshots" USING btree ("n_ide") WHERE "employee_snapshots"."est" = 'V';