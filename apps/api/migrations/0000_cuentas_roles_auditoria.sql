CREATE TYPE "public"."account_status" AS ENUM('PENDIENTE_VERIFICACION', 'ACTIVA', 'BLOQUEADA');--> statement-breakpoint
CREATE TYPE "public"."role_code" AS ENUM('EMPLOYEE', 'AREA_MANAGER', 'VACATION_FINAL_APPROVER', 'CERTIFICATE_APPROVER', 'HR_ADMIN', 'SYSTEM_ADMIN');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"n_ide" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"status" "account_status" DEFAULT 'PENDIENTE_VERIFICACION' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_account_id" uuid,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"resource_id" text,
	"result" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "role_code" NOT NULL,
	"company_code" text,
	"area_code" text,
	"valid_from" date NOT NULL,
	"valid_to" date
);
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_active_uq" ON "accounts" USING btree ("email") WHERE "accounts"."status" <> 'BLOQUEADA';--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_n_ide_active_uq" ON "accounts" USING btree ("n_ide") WHERE "accounts"."status" <> 'BLOQUEADA';--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "role_assignments_account_idx" ON "role_assignments" USING btree ("account_id");