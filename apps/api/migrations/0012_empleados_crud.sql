CREATE TABLE "employee_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"changed_by" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "source" text DEFAULT 'IMPORT' NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_snapshots" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_employee_id_employee_snapshots_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_changes" ADD CONSTRAINT "employee_changes_changed_by_accounts_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_changes_employee_idx" ON "employee_changes" USING btree ("employee_id","at");