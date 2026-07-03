-- CreateTable
CREATE TABLE "ExecutionEventRecord" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "ExecutionEventRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionEventRecord_executionId_seq_idx" ON "ExecutionEventRecord"("executionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionEventRecord_executionId_seq_key" ON "ExecutionEventRecord"("executionId", "seq");

-- AddForeignKey
ALTER TABLE "ExecutionEventRecord" ADD CONSTRAINT "ExecutionEventRecord_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
