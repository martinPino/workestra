-- CreateTable
CREATE TABLE "ScheduledTrigger" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "cron" TEXT,
    "everyMs" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledTrigger_workspaceId_idx" ON "ScheduledTrigger"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledTrigger_workflowId_idx" ON "ScheduledTrigger"("workflowId");

-- AddForeignKey
ALTER TABLE "ScheduledTrigger" ADD CONSTRAINT "ScheduledTrigger_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
