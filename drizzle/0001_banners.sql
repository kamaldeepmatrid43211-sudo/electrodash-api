CREATE TYPE "public"."banner_link" AS ENUM('none', 'category', 'product', 'offers');--> statement-breakpoint
CREATE TABLE "banners" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"image_url" text NOT NULL,
	"link_type" "banner_link" DEFAULT 'none' NOT NULL,
	"link_target" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "banners_sort_idx" ON "banners" USING btree ("sort");