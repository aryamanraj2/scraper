-- CreateEnum
CREATE TYPE "llm_task_status" AS ENUM ('pending', 'claimed', 'fulfilled', 'rejected', 'abandoned');

-- CreateTable
CREATE TABLE "llm_task" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "response_schema" JSONB NOT NULL,
    "input" JSONB NOT NULL,
    "allowed_evidence_ids" TEXT[],
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "status" "llm_task_status" NOT NULL DEFAULT 'pending',
    "status_reason" "reason_code",
    "output" JSONB,
    "fulfilled_by" TEXT,
    "cost_usd" DECIMAL(12,6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "fulfilled_at" TIMESTAMP(3),

    CONSTRAINT "llm_task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_task_status_kind_idx" ON "llm_task"("status", "kind");

-- CreateIndex
CREATE INDEX "llm_task_subject_type_subject_id_idx" ON "llm_task"("subject_type", "subject_id");
