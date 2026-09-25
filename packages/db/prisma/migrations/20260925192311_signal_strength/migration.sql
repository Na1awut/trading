-- Phase 2: informational signal strength and minimum-strength notification preference.
CREATE TYPE "SignalStrength" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- Phase 1 stored minimumSignalStrength as an (unenforced) 0-100 integer. Map it onto the
-- enum instead of dropping it: 0-33 -> LOW, 34-66 -> MEDIUM, 67+ -> HIGH.
ALTER TABLE "NotificationSettings" ALTER COLUMN "minimumSignalStrength" DROP DEFAULT;
ALTER TABLE "NotificationSettings" ALTER COLUMN "minimumSignalStrength" TYPE "SignalStrength"
  USING (CASE
    WHEN "minimumSignalStrength" >= 67 THEN 'HIGH'
    WHEN "minimumSignalStrength" >= 34 THEN 'MEDIUM'
    ELSE 'LOW'
  END)::"SignalStrength";
ALTER TABLE "NotificationSettings" ALTER COLUMN "minimumSignalStrength" SET DEFAULT 'LOW';

ALTER TABLE "SignalEvent"
  ADD COLUMN "signalScore" INTEGER,
  ADD COLUMN "maxSignalScore" INTEGER,
  ADD COLUMN "signalStrength" "SignalStrength";
