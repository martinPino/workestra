-- M52: config de sondeo (poll) en el trigger programado — para el trigger «Google Drive: nuevo fichero».
ALTER TABLE "ScheduledTrigger" ADD COLUMN "poll" JSONB;
