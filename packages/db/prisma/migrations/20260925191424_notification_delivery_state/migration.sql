-- Phase 2: notification delivery state machine.
-- Hand-written so existing rows are preserved (renames instead of drop/add).

-- Enum: DeliveryStatus -> NotificationStatus, plus the in-flight SENDING state.
ALTER TYPE "DeliveryStatus" RENAME TO "NotificationStatus";
ALTER TYPE "NotificationStatus" ADD VALUE 'SENDING' AFTER 'PENDING';

-- Columns: rename (data kept) and add attempt tracking.
ALTER TABLE "SignalEvent" RENAME COLUMN "deliveryStatus" TO "notificationStatus";
ALTER TABLE "SignalEvent" RENAME COLUMN "deliveredAt" TO "notificationSentAt";
ALTER TABLE "SignalEvent" RENAME COLUMN "deliveryError" TO "notificationError";
ALTER TABLE "SignalEvent"
  ADD COLUMN "notificationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastNotificationAttemptAt" TIMESTAMP(3),
  ADD COLUMN "nextNotificationAttemptAt" TIMESTAMP(3);

-- Backfill: Phase 1 made exactly one attempt for SENT/FAILED events.
UPDATE "SignalEvent"
  SET "notificationAttempts" = 1, "lastNotificationAttemptAt" = COALESCE("notificationSentAt", "triggeredAt")
  WHERE "notificationStatus" IN ('SENT', 'FAILED');
-- Phase 1 PENDING rows were orphaned by a crash between insert and send: make them due so
-- the retry sweep handles them (it expires anything older than NOTIFICATION_MAX_AGE_MS).
UPDATE "SignalEvent" SET "nextNotificationAttemptAt" = "triggeredAt" WHERE "notificationStatus" = 'PENDING';

-- Retry sweep lookup: due PENDING/FAILED events and stale SENDING claims.
CREATE INDEX "SignalEvent_notificationStatus_nextNotificationAttemptAt_idx"
  ON "SignalEvent"("notificationStatus", "nextNotificationAttemptAt");
