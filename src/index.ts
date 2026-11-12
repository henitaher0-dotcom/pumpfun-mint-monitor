
import { Bot } from "grammy";
import { loadConfig, type AppConfig } from "./config.js";
import { HealthServer } from "./health/healthServer.js";
import { MonitorWatchdog } from "./health/watchdog.js";
import { TokenService } from "./services/tokenService.js";
import { WatchlistService } from "./services/watchlistService.js";
import { registerTelegramCommands } from "./telegram/bot.js";
import { TelegramNotificationQueue } from "./telegram/outboundQueue.js";
import { logger } from "./utils/logger.js";
import { PumpPortalClient } from "./websocket/pumpPortal.js";

async function main(): Promise<void> {
  let config: AppConfig;

  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.appError(message);
    process.exit(1);
    return;
  }

  const watchlistService = new WatchlistService();

  try {
    await watchlistService.load();
    logger.app(
      `Loaded ${watchlistService.getNames().length} watched name(s)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.appError(`Could not load watchlist: ${message}`);
    process.exit(1);
    return;
  }

  const tokenService = new TokenService();
  const processStartedAt = Date.now();

  const notificationQueueRef: {
    instance: TelegramNotificationQueue | null;
  } = {
    instance: null,
  };

  const pumpPortalClient = new PumpPortalClient({
    wsUrl: config.pumpPortalWsUrl,
    onToken: (event) => {
      if (tokenService.isDuplicate(event.mint)) {
        logger.token(`Duplicate mint=${event.mint} — skipping`);
        return;
      }

      const isNew = tokenService.recordToken(event);
      if (!isNew) return;

      logger.token(`NEW mint=${event.mint}`);

      if (!watchlistService.matches(event.name)) {
        logger.token(
          `Name does not match watchlist — skipping notification (name=${event.name ?? "unknown"})`,
        );
        return;
      }

      logger.token(`Watchlist match — name=${event.name}`);

      const queue = notificationQueueRef.instance;

      if (
        queue &&
        pumpPortalClient.isMonitoringEnabled() &&
        queue.isEnabled()
      ) {
        queue.enqueue(event);
      }
    },
  });

  const bot = new Bot(config.telegramBotToken);

  const notificationQueue = new TelegramNotificationQueue(
    bot,
    config.telegramChatId,
  );

  notificationQueueRef.instance = notificationQueue;

  registerTelegramCommands(bot, {
    config,
    pumpPortalClient,
    tokenService,
    notificationQueue,
    watchlistService,
  });

  bot.catch((error) => {
    logger.telegramError(`Unhandled bot error: ${error.message}`);
  });

  logger.app("Trading: DISABLED");

  const healthServer =
    config.healthPort === null
      ? null
      : new HealthServer({
          port: config.healthPort,
          thresholds: {
            startupGraceMs: config.healthStartupGraceSeconds * 1_000,
            maxIdleMs: config.healthMaxIdleSeconds * 1_000,
          },
          readSnapshot: () => ({
            processStartedAt,
            monitoringEnabled: pumpPortalClient.isMonitoringEnabled(),
            connectionState: pumpPortalClient.getConnectionState(),
            lastActivityAt: pumpPortalClient.getLastActivityAt(),
            connectedAt: pumpPortalClient.getConnectedAt(),
            connectionStateSince: pumpPortalClient.getConnectionStateSince(),
            stoppedByUser: pumpPortalClient.isStoppedByUser(),
            stats: tokenService.getStats(),
            notificationsEnabled: notificationQueue.isEnabled(),
            pendingNotifications: notificationQueue.getPendingCount(),
            sentNotifications: notificationQueue.getSentCount(),
            failedNotifications: notificationQueue.getFailedCount(),
          }),
        });

  if (config.autostartMonitoring) {
    notificationQueue.enable();
    pumpPortalClient.start();
    tokenService.startSession();
    logger.app("Autostart enabled — monitoring starts without waiting for /start");
  } else {
    logger.app("Starting Telegram bot — send /start to begin monitoring");
  }

  const watchdog =
    config.autostartMonitoring
      ? new MonitorWatchdog({
          startupGraceMs: config.healthStartupGraceSeconds * 1_000,
          maxIdleMs: config.healthMaxIdleSeconds * 1_000,
          readSnapshot: () => ({
            processStartedAt,
            monitoringEnabled: pumpPortalClient.isMonitoringEnabled(),
            connectionState: pumpPortalClient.getConnectionState(),
            connectionStateSince: pumpPortalClient.getConnectionStateSince(),
            lastActivityAt: pumpPortalClient.getLastActivityAt(),
            connectedAt: pumpPortalClient.getConnectedAt(),
          }),
          isStoppedByUser: () => pumpPortalClient.isStoppedByUser(),
          enableMonitoring: () => {
            notificationQueue.enable();
            pumpPortalClient.start();
            tokenService.startSession();
          },
          restartStream: () => {
            pumpPortalClient.restart();
          },
        })
      : null;

  watchdog?.start();

  if (healthServer !== null) {
    await healthServer.start();
  } else {
    logger.app(
      "No PORT or HEALTH_PORT set — running without an HTTP health endpoint",
    );
  }

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;

    shuttingDown = true;
    logger.app(`${signal} received — shutting down`);

    try {
      watchdog?.stop();
      pumpPortalClient.stop();

      if (healthServer !== null) {
        await healthServer.stop();
      }

      await bot.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.appWarn(`Error while shutting down: ${message}`);
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await bot.start({
    onStart: () => {
      logger.telegram("Bot is listening for commands");
    },
  }).catch((error: unknown) => {
    if (!shuttingDown) {
      throw error;
    }
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.appError(`Fatal error: ${message}`);
  process.exit(1);
});
