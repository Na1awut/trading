-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('EQUITY', 'ETF', 'INDEX', 'CRYPTO', 'FOREX', 'COMMODITY');

-- CreateEnum
CREATE TYPE "SignalCategory" AS ENUM ('PRICE', 'MOVING_AVERAGE', 'MOMENTUM', 'VOLUME');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('PRICE_ABOVE', 'PRICE_BELOW', 'PCT_MOVE_UP', 'PCT_MOVE_DOWN', 'EMA_BULLISH_CROSS', 'EMA_BEARISH_CROSS', 'PRICE_CROSS_ABOVE_EMA', 'PRICE_CROSS_BELOW_EMA', 'RSI_OVERBOUGHT', 'RSI_OVERSOLD', 'RSI_CROSS_UP', 'RSI_CROSS_DOWN', 'MACD_BULLISH_CROSS', 'MACD_BEARISH_CROSS', 'VOLUME_SPIKE', 'VOLUME_ANOMALY');

-- CreateEnum
CREATE TYPE "PushProvider" AS ENUM ('FCM', 'APNS', 'EXPO');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'SUPPRESSED', 'NO_DEVICES', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationFrequency" AS ENUM ('REALTIME', 'HOURLY_DIGEST', 'DAILY_DIGEST');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "firebaseUid" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSettings" (
    "userId" TEXT NOT NULL,
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledCategories" "SignalCategory"[] DEFAULT ARRAY[]::"SignalCategory"[],
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "notificationFrequency" "NotificationFrequency" NOT NULL DEFAULT 'REALTIME',
    "minimumSignalStrength" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "provider" "PushProvider" NOT NULL DEFAULT 'FCM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetClass" "AssetClass" NOT NULL,
    "exchange" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Watchlist',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalDefinition" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "presetKey" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "SignalCategory" NOT NULL,
    "signalType" "SignalType" NOT NULL,
    "ticker" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signalDefinitionId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalState" (
    "signalDefinitionId" TEXT NOT NULL,
    "lastCandleTime" TIMESTAMP(3) NOT NULL,
    "lastActive" BOOLEAN,
    "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTriggeredAt" TIMESTAMP(3),

    CONSTRAINT "SignalState_pkey" PRIMARY KEY ("signalDefinitionId")
);

-- CreateTable
CREATE TABLE "SignalEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signalDefinitionId" TEXT,
    "ticker" TEXT NOT NULL,
    "signalType" "SignalType" NOT NULL,
    "category" "SignalCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "candleTime" TIMESTAMP(3) NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DOUBLE PRECISION NOT NULL,
    "values" JSONB NOT NULL,
    "message" TEXT NOT NULL,
    "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "deliveredAt" TIMESTAMP(3),
    "deliveryError" TEXT,

    CONSTRAINT "SignalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketCandle" (
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketCandle_pkey" PRIMARY KEY ("symbol","timeframe","time")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");

-- CreateIndex
CREATE UNIQUE INDEX "Device_token_key" ON "Device"("token");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- CreateIndex
CREATE INDEX "Watchlist_userId_idx" ON "Watchlist"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_userId_name_key" ON "Watchlist"("userId", "name");

-- CreateIndex
CREATE INDEX "WatchlistItem_symbol_idx" ON "WatchlistItem"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_watchlistId_symbol_key" ON "WatchlistItem"("watchlistId", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "SignalDefinition_presetKey_key" ON "SignalDefinition"("presetKey");

-- CreateIndex
CREATE INDEX "SignalDefinition_ticker_timeframe_enabled_idx" ON "SignalDefinition"("ticker", "timeframe", "enabled");

-- CreateIndex
CREATE INDEX "SignalDefinition_ownerId_idx" ON "SignalDefinition"("ownerId");

-- CreateIndex
CREATE INDEX "SignalSubscription_signalDefinitionId_enabled_idx" ON "SignalSubscription"("signalDefinitionId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "SignalSubscription_userId_signalDefinitionId_key" ON "SignalSubscription"("userId", "signalDefinitionId");

-- CreateIndex
CREATE INDEX "SignalEvent_userId_triggeredAt_idx" ON "SignalEvent"("userId", "triggeredAt" DESC);

-- CreateIndex
CREATE INDEX "SignalEvent_userId_ticker_triggeredAt_idx" ON "SignalEvent"("userId", "ticker", "triggeredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SignalEvent_userId_ticker_signalDefinitionId_timeframe_cand_key" ON "SignalEvent"("userId", "ticker", "signalDefinitionId", "timeframe", "candleTime");

-- AddForeignKey
ALTER TABLE "NotificationSettings" ADD CONSTRAINT "NotificationSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "Watchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Asset"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalDefinition" ADD CONSTRAINT "SignalDefinition_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalDefinition" ADD CONSTRAINT "SignalDefinition_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "Asset"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalSubscription" ADD CONSTRAINT "SignalSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalSubscription" ADD CONSTRAINT "SignalSubscription_signalDefinitionId_fkey" FOREIGN KEY ("signalDefinitionId") REFERENCES "SignalDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalState" ADD CONSTRAINT "SignalState_signalDefinitionId_fkey" FOREIGN KEY ("signalDefinitionId") REFERENCES "SignalDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvent" ADD CONSTRAINT "SignalEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalEvent" ADD CONSTRAINT "SignalEvent_signalDefinitionId_fkey" FOREIGN KEY ("signalDefinitionId") REFERENCES "SignalDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
