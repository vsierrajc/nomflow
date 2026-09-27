ALTER TYPE "public"."role_code" ADD VALUE 'AREA_DIRECTOR' BEFORE 'VACATION_FINAL_APPROVER';--> statement-breakpoint
ALTER TYPE "public"."role_code" ADD VALUE 'GENERAL_MANAGER' BEFORE 'VACATION_FINAL_APPROVER';--> statement-breakpoint
ALTER TABLE "vacation_requests" ADD COLUMN "first_approver_role" text DEFAULT 'AREA_MANAGER' NOT NULL;