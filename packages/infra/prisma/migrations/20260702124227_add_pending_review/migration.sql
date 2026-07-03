-- CreateTable
CREATE TABLE "PendingReview" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "decision" TEXT,
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "PendingReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingReview_executionId_idx" ON "PendingReview"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingReview_executionId_nodeKey_key" ON "PendingReview"("executionId", "nodeKey");

-- AddForeignKey
ALTER TABLE "PendingReview" ADD CONSTRAINT "PendingReview_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
