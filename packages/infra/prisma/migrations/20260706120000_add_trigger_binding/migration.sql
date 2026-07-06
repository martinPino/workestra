-- CreateTable
CREATE TABLE "TriggerBinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "remoteId" TEXT,
    "params" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriggerBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriggerBinding_workspaceId_idx" ON "TriggerBinding"("workspaceId");

-- CreateIndex
CREATE INDEX "TriggerBinding_workflowId_idx" ON "TriggerBinding"("workflowId");

-- AddForeignKey
ALTER TABLE "TriggerBinding" ADD CONSTRAINT "TriggerBinding_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
