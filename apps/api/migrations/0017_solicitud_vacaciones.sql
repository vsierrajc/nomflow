CREATE TABLE "vacaciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"n_ide" text NOT NULL,
	"n_cont" text NOT NULL,
	"fec_ini_dis" date NOT NULL,
	"fec_fin_dis" date NOT NULL,
	"dias_dis" integer NOT NULL,
	"dias_habiles" integer NOT NULL,
	"fecha_retorno" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vacation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"action" text NOT NULL,
	"comment" text,
	"content_hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vacation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"n_ide" text NOT NULL,
	"n_cont" text NOT NULL,
	"c_emp" text NOT NULL,
	"c_area" text NOT NULL,
	"manager_account_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDIENTE_JEFE' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vacation_revision_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"prog_vac_id" uuid NOT NULL,
	"days" integer NOT NULL,
	CONSTRAINT "vacation_alloc_days_ck" CHECK ("vacation_revision_allocations"."days" > 0)
);
--> statement-breakpoint
CREATE TABLE "vacation_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"calendar_diff" integer NOT NULL,
	"business_days" integer NOT NULL,
	"return_date" date NOT NULL,
	"counted_days" jsonb NOT NULL,
	"calendar_ids" jsonb NOT NULL,
	"proposed_by" uuid NOT NULL,
	"reason" text,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vacaciones" ADD CONSTRAINT "vacaciones_request_id_vacation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."vacation_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacaciones" ADD CONSTRAINT "vacaciones_revision_id_vacation_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."vacation_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_actions" ADD CONSTRAINT "vacation_actions_request_id_vacation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."vacation_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_actions" ADD CONSTRAINT "vacation_actions_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vacation_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vacation_requests_manager_account_id_accounts_id_fk" FOREIGN KEY ("manager_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_revision_allocations" ADD CONSTRAINT "vacation_revision_allocations_revision_id_vacation_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."vacation_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_revision_allocations" ADD CONSTRAINT "vacation_revision_allocations_prog_vac_id_prog_vac_id_fk" FOREIGN KEY ("prog_vac_id") REFERENCES "public"."prog_vac"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_revisions" ADD CONSTRAINT "vacation_revisions_request_id_vacation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."vacation_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacation_revisions" ADD CONSTRAINT "vacation_revisions_proposed_by_accounts_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vacaciones_request_uq" ON "vacaciones" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "vacaciones_person_idx" ON "vacaciones" USING btree ("n_ide","n_cont","fec_ini_dis");--> statement-breakpoint
CREATE INDEX "vacation_actions_request_idx" ON "vacation_actions" USING btree ("request_id","at");--> statement-breakpoint
CREATE INDEX "vacation_requests_account_idx" ON "vacation_requests" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "vacation_requests_manager_idx" ON "vacation_requests" USING btree ("manager_account_id","status");--> statement-breakpoint
CREATE INDEX "vacation_requests_status_idx" ON "vacation_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "vacation_alloc_uq" ON "vacation_revision_allocations" USING btree ("revision_id","prog_vac_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vacation_revisions_uq" ON "vacation_revisions" USING btree ("request_id","number");