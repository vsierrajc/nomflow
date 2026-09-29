CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"monday" boolean DEFAULT false NOT NULL,
	"tuesday" boolean DEFAULT false NOT NULL,
	"wednesday" boolean DEFAULT false NOT NULL,
	"thursday" boolean DEFAULT false NOT NULL,
	"friday" boolean DEFAULT false NOT NULL,
	"saturday" boolean DEFAULT false NOT NULL,
	"sunday" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_code_uq" ON "shifts" USING btree ("code");
--> statement-breakpoint
INSERT INTO "shifts" ("code", "name", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
VALUES
	('01', 'Turno 01', true, true, true, true, true, false, false),
	('02', 'Turno 02', true, true, true, true, true, true, false),
	('03', 'Turno 03', false, true, true, true, true, false, false)
ON CONFLICT ("code") DO NOTHING;