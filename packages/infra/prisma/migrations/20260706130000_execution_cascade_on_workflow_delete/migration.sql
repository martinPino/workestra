-- Execution.version -> WorkflowVersion pasa de ON DELETE RESTRICT a ON DELETE CASCADE.
-- Así, borrar un Workflow (que cascada a sus WorkflowVersion) arrastra también sus Execution y su
-- historial (ExecutionLog/NodeRun/ExecutionEventRecord/PendingReview, ya en cascada desde Execution)
-- en UNA sola operación atómica, sin borrar ejecuciones aparte ni carreras de FK.

-- DropForeignKey
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_workflowVersionId_fkey";

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
