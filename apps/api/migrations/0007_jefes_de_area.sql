CREATE TABLE "area_manager_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"c_emp" text NOT NULL,
	"c_area" text NOT NULL,
	"manager_account_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "area_manager_assignments" ADD CONSTRAINT "area_manager_assignments_manager_account_id_accounts_id_fk" FOREIGN KEY ("manager_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_manager_assignments" ADD CONSTRAINT "area_manager_assignments_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "area_manager_area_idx" ON "area_manager_assignments" USING btree ("c_emp","c_area");