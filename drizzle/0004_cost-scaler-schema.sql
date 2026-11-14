CREATE TABLE "advice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"question" text NOT NULL,
	"app_name" text,
	"scenario_id" uuid,
	"output" jsonb NOT NULL,
	"trace" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"provider" text NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advice_question_chk" CHECK (char_length("advice"."question") <= 500)
);
--> statement-breakpoint
CREATE TABLE "footprint_app" (
	"name" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"clouds" text[] NOT NULL,
	"domain" text,
	"storage" boolean DEFAULT false NOT NULL,
	"secret_count" integer DEFAULT 0 NOT NULL,
	"ai" text NOT NULL,
	"source_commit" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_point" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud" text NOT NULL,
	"component" text NOT NULL,
	"sku_key" text NOT NULL,
	"region" text NOT NULL,
	"unit" text NOT NULL,
	"usd_micros" bigint NOT NULL,
	"tier_start" double precision DEFAULT 0 NOT NULL,
	"tier_end" double precision,
	"vendor_sku" text,
	"description" text DEFAULT '' NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_version" text,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "price_point_cloud_chk" CHECK ("price_point"."cloud" in ('aws', 'azure', 'gcp', 'oci')),
	CONSTRAINT "price_point_component_chk" CHECK ("price_point"."component" in ('vm', 'serverless', 'postgres', 'object_storage', 'egress', 'identity', 'load_balancer')),
	CONSTRAINT "price_point_unit_chk" CHECK ("price_point"."unit" in ('hour', 'vcpu_hour', 'gb_hour', 'gb_month', 'gb', 'mau', 'million_requests', 'vcpu_second', 'gib_second')),
	CONSTRAINT "price_point_status_chk" CHECK ("price_point"."status" in ('active', 'quarantined')),
	CONSTRAINT "price_point_usd_chk" CHECK ("price_point"."usd_micros" >= 0),
	CONSTRAINT "price_point_description_chk" CHECK (char_length("price_point"."description") <= 200)
);
--> statement-breakpoint
CREATE TABLE "price_refresh" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text DEFAULT 'running' NOT NULL,
	"rows_upserted" integer DEFAULT 0 NOT NULL,
	"rows_missing" integer DEFAULT 0 NOT NULL,
	"rows_quarantined" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"error_code" text,
	"detail" jsonb,
	CONSTRAINT "price_refresh_source_chk" CHECK ("price_refresh"."source" in ('aws_ec2', 'aws_other', 'azure', 'gcp', 'oci', 'footprint')),
	CONSTRAINT "price_refresh_trigger_chk" CHECK ("price_refresh"."trigger" in ('scheduler', 'admin')),
	CONSTRAINT "price_refresh_outcome_chk" CHECK ("price_refresh"."outcome" in ('running', 'ok', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "scenario" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"base_app" text,
	"spec" jsonb NOT NULL,
	"client_op_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenario_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "scenario_name_chk" CHECK (char_length("scenario"."name") between 1 and 80),
	CONSTRAINT "scenario_version_chk" CHECK ("scenario"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "scenario_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"prices_as_of" timestamp with time zone NOT NULL,
	"result" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
ALTER TABLE "advice" ADD CONSTRAINT "advice_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advice" ADD CONSTRAINT "advice_scenario_owner_fk" FOREIGN KEY ("scenario_id","owner_id") REFERENCES "public"."scenario"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario" ADD CONSTRAINT "scenario_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_result" ADD CONSTRAINT "scenario_result_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_result" ADD CONSTRAINT "scenario_result_scenario_owner_fk" FOREIGN KEY ("scenario_id","owner_id") REFERENCES "public"."scenario"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advice_owner_created_idx" ON "advice" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_point_sku_uidx" ON "price_point" USING btree ("cloud","sku_key","region","tier_start");--> statement-breakpoint
CREATE INDEX "price_point_cloud_component_idx" ON "price_point" USING btree ("cloud","component");--> statement-breakpoint
CREATE INDEX "price_refresh_source_started_idx" ON "price_refresh" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "scenario_owner_id_idx" ON "scenario" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scenario_owner_client_op_uidx" ON "scenario" USING btree ("owner_id","client_op_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scenario_result_scenario_uidx" ON "scenario_result" USING btree ("scenario_id");--> statement-breakpoint
-- Rows from the template's old kinds can't satisfy the new check; they are only a sliding-window counter.
DELETE FROM "rate_event" WHERE "kind" NOT IN ('scenario_write', 'price_run', 'advice', 'refresh');--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('scenario_write', 'price_run', 'advice', 'refresh'));