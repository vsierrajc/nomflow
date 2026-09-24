CREATE TABLE "holiday_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region" text DEFAULT 'CO' NOT NULL,
	"year" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'BORRADOR' NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prog_vac" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"n_ide" text NOT NULL,
	"n_cont" text NOT NULL,
	"per_ini" date NOT NULL,
	"per_fin" date NOT NULL,
	"dias" integer NOT NULL,
	"disp" integer NOT NULL,
	"est_origen" text,
	"estado" text DEFAULT 'ACTIVA' NOT NULL,
	"fecha_corte" date,
	"version" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prog_vac_range_ck" CHECK ("prog_vac"."disp" >= 0 and "prog_vac"."disp" <= "prog_vac"."dias" and "prog_vac"."dias" <= 15)
);
--> statement-breakpoint
CREATE TABLE "prog_vac_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prog_vac_id" uuid NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"old_dias" integer NOT NULL,
	"new_dias" integer NOT NULL,
	"old_disp" integer NOT NULL,
	"new_disp" integer NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "holiday_calendars_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "holiday_calendars_published_by_accounts_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_calendar_id_holiday_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."holiday_calendars"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prog_vac" ADD CONSTRAINT "prog_vac_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prog_vac_adjustments" ADD CONSTRAINT "prog_vac_adjustments_prog_vac_id_prog_vac_id_fk" FOREIGN KEY ("prog_vac_id") REFERENCES "public"."prog_vac"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prog_vac_adjustments" ADD CONSTRAINT "prog_vac_adjustments_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_calendars_version_uq" ON "holiday_calendars" USING btree ("region","year","version");--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_calendars_one_published_uq" ON "holiday_calendars" USING btree ("region","year") WHERE "holiday_calendars"."status" = 'PUBLICADO';--> statement-breakpoint
CREATE UNIQUE INDEX "holidays_calendar_date_uq" ON "holidays" USING btree ("calendar_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "prog_vac_period_uq" ON "prog_vac" USING btree ("n_ide","n_cont","per_ini","per_fin") WHERE "prog_vac"."active" = true;--> statement-breakpoint
CREATE INDEX "prog_vac_person_idx" ON "prog_vac" USING btree ("n_ide","n_cont");--> statement-breakpoint
CREATE INDEX "prog_vac_adjustments_idx" ON "prog_vac_adjustments" USING btree ("prog_vac_id","at");