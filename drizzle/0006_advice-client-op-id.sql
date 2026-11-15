ALTER TABLE "advice" ADD COLUMN "client_op_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "advice_owner_client_op_uidx" ON "advice" USING btree ("owner_id","client_op_id");