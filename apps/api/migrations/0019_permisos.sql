CREATE TABLE "permit_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"action" text NOT NULL,
	"comment" text,
	"content_hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permit_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"n_ide" text NOT NULL,
	"n_cont" text NOT NULL,
	"c_emp" text NOT NULL,
	"c_area" text NOT NULL,
	"manager_account_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"type_name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_time" text,
	"end_time" text,
	"justification" text NOT NULL,
	"status" text DEFAULT 'PENDIENTE_JEFE' NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permit_requests_dates_ck" CHECK ("permit_requests"."end_date" >= "permit_requests"."start_date")
);
--> statement-breakpoint
CREATE TABLE "permit_supports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permit_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"support_required" boolean DEFAULT false NOT NULL,
	"allows_hours" boolean DEFAULT false NOT NULL,
	"max_days" integer,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "permit_actions" ADD CONSTRAINT "permit_actions_request_id_permit_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."permit_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_actions" ADD CONSTRAINT "permit_actions_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_requests" ADD CONSTRAINT "permit_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_requests" ADD CONSTRAINT "permit_requests_manager_account_id_accounts_id_fk" FOREIGN KEY ("manager_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_requests" ADD CONSTRAINT "permit_requests_type_id_permit_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."permit_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_supports" ADD CONSTRAINT "permit_supports_request_id_permit_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."permit_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permit_actions_request_idx" ON "permit_actions" USING btree ("request_id","at");--> statement-breakpoint
CREATE INDEX "permit_requests_account_idx" ON "permit_requests" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "permit_requests_manager_idx" ON "permit_requests" USING btree ("manager_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_supports_request_uq" ON "permit_supports" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permit_types_code_uq" ON "permit_types" USING btree ("code");