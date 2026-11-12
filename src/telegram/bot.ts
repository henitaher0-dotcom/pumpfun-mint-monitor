
import { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { PumpPortalClient } from "../websocket/pumpPortal.js";
import type { TokenService } from "../services/tokenService.js";
import type { WatchlistService } from "../services/watchlistService.js";
import { logger } from "../utils/logger.js";
import { escapeHtmlForTelegram } from "./messages.js";
import type { TelegramNotificationQueue } from "./outboundQueue.js";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatIsoTimestamp(timestamp: number | null): string {
  return timestamp === null ? "N/A" : new Date(timestamp).toISOString();
}

export interface TelegramBotContext {
  config: AppConfig;
  pumpPortalClient: PumpPortalClient;
  tokenService: TokenService;
  notificationQueue: TelegramNotificationQueue;
  watchlistService: WatchlistService;
}

export function registerTelegramCommands(
  bot: Bot,
  context: TelegramBotContext,
): void {
  const {
    config,
    pumpPortalClient,
    tokenService,
    notificationQueue,
    watchlistService,
  } = context;

  const isAuthorized = (chatId: number | undefined): boolean =>
    chatId !== undefined && String(chatId) === config.telegramChatId;

  bot.command("add", async (ctx) => {
    if (!isAuthorized(ctx.chat?.id)) return;

    const name = ctx.match.trim();

    if (!name) {
      await ctx.reply("اكتب الاسم بعد الأمر، مثال:\n/add GTA6TRUMP");
      return;
    }

    const added = await watchlistService.add(name);

    await ctx.reply(
      added
        ? `✅ تمت إضافة الاسم للمراقبة:\n${name}`
        : `⚠️ الاسم موجود بالفعل أو غير صالح:\n${name}`,
    );
  });

  bot.command("list", async (ctx) => {
    if (!isAuthorized(ctx.chat?.id)) return;

    const names = watchlistService.getNames();

    if (names.length === 0) {
      await ctx.reply("قائمة المراقبة فارغة.\nأضف اسمًا باستعمال /add");
      return;
    }

    await ctx.reply(
      "📋 أسماء العملات التي تراقبها:\n\n" +
        names.map((name, index) => `${index + 1}. ${name}`).join("\n"),
    );
  });

  bot.command("remove", async (ctx) => {
    if (!isAuthorized(ctx.chat?.id)) return;

    const name = ctx.match.trim();

    if (!name) {
      await ctx.reply("اكتب الاسم الذي تريد حذفه، مثال:\n/remove GTA6TRUMP");
      return;
    }

    const removed = await watchlistService.remove(name);

    await ctx.reply(
      removed
        ? `🗑 تم حذف الاسم:\n${name}`
        : `لم أجد هذا الاسم في القائمة:\n${name}`,
    );
  });

  bot.command("start", async (ctx) => {
    if (!isAuthorized(ctx.chat?.id)) {
      logger.telegramWarn(`Ignored /start from unauthorized chat ${ctx.chat?.id ?? "unknown"}`);
      return;
    }

    notificationQueue.enable();
    pumpPortalClient.start();
    tokenService.startSession();

    await ctx.reply(
      "✅ Pump.fun mint monitor started.\n\nListening for new token creation events via PumpPortal.\nTrading: DISABLED",
    );
  });

  bot.command("stop", async (ctx) => {
    if (!isAuthorized(ctx.chat?.id)) {
      logger.telegramWarn(`Ignored /stop from unauthorized chat ${ctx.chat?.id ?? "unknown"}`);
      return;
    }

    notificationQueue.stopAndClear();
    pumpPortalClient.stopByUser();
    tokenService.stopSession();

    await ctx.reply(
      "⏹ Pump.fun mint monitor stopped.\n\nNo further notifications will be sent until /start.",
    );
  });

  bot.command("status", async (ctx) => {
    if (!isAuthorized(ctx.chat?.id)) return;

    const stats = tokenService.getStats();
    const wsState = pumpPortalClient.getConnectionState();
    const monitoring = pumpPortalClient.isMonitoringEnabled();

    const message = [
      "<b>Monitor Status</b>",
      "",
      `<b>WebSocket:</b> ${escapeHtmlForTelegram(wsState)}`,
      `<b>Monitoring:</b> ${monitoring ? "ACTIVE" : "STOPPED"}`,
      `<b>Tokens received:</b> ${stats.totalTokensReceived}`,
      `<b>Unique mints tracked:</b> ${stats.seenMintCount}`,
      `<b>Names in watchlist:</b> ${watchlistService.getNames().length}`,
      `<b>Runtime:</b> ${formatDuration(stats.sessionRuntimeMs)}`,
      `<b>Tokens/min:</b> ${stats.tokensPerMinute.toFixed(2)}`,
      `<b>Last event received:</b> ${formatIsoTimestamp(stats.lastEventReceivedAt)}`,
      `<b>Last blockchain timestamp:</b> ${formatIsoTimestamp(stats.lastBlockchainCreatedAt)}`,
      `<b>Trading:</b> DISABLED`,
    ].join("\n");

    await ctx.reply(message, { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    if (!isAuthorized(ctx.chat?.id)) return;

    await ctx.reply(
      [
        "<b>Pump.fun Mint Monitor</b>",
        "",
        "<b>Commands</b>",
        "/start — Start monitoring",
        "/stop — Stop monitoring",
        "/status — Show monitor status",
        "/add NAME — Add a name to watch",
        "/list — Show watched names",
        "/remove NAME — Remove a watched name",
        "/help — Show this message",
        "",
        "Alerts are sent only when a new token name contains a watched name.",
        "Matching ignores uppercase/lowercase and spaces.",
        "<b>Trading:</b> DISABLED",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });
}
