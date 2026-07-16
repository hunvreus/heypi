import { requiredEnvironment } from "./cli-env.js";
import { booleanFlag, type CliContext, type CliFlags, type CliResult, flag } from "./cli-types.js";

type JsonObject = Record<string, unknown>;

const SLACK_RUNTIME_SCOPES = [
	"app_mentions:read",
	"assistant:write",
	"channels:history",
	"chat:write",
	"files:write",
	"groups:history",
	"im:history",
	"mpim:history",
	"reactions:write",
];
const SLACK_DISCOVERY_SCOPES = ["channels:read", "groups:read", "users:read"];
// View/send/read history, embeds, attachments, and thread replies.
const DISCORD_PERMISSIONS = "274878024704";
const DISCORD_INTENTS = 1 | 512 | 4096 | 32768;

function object(value: unknown): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Service returned an invalid response.");
	return value as JsonObject;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

async function responseJson(response: Response, service: string): Promise<JsonObject> {
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new Error(`${service} returned a non-JSON response (${response.status}).`);
	}
	if (response.status === 429) {
		const retry = response.headers.get("retry-after");
		throw new Error(`${service} rate limited the request${retry ? `; retry after ${retry}s` : ""}.`);
	}
	if (!response.ok) throw new Error(`${service} request failed (${response.status}).`);
	return object(value);
}

async function slackRequest(
	context: CliContext,
	method: string,
	token: string,
	params: Record<string, string> = {},
): Promise<{ data: JsonObject; headers: Headers }> {
	const response = await context.fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
	});
	const data = await responseJson(response, "Slack");
	if (data.ok !== true) throw new Error(`Slack ${method} failed: ${string(data.error) ?? "unknown_error"}.`);
	return { data, headers: response.headers };
}

function slackScopes(headers: Headers): Set<string> | undefined {
	const value = headers.get("x-oauth-scopes");
	return value ? new Set(value.split(",").map((scope) => scope.trim())) : undefined;
}

function slackItem(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export async function slackCheck(context: CliContext): Promise<CliResult> {
	const bot = requiredEnvironment(context.environment, "SLACK_BOT_TOKEN");
	const app = requiredEnvironment(context.environment, "SLACK_APP_TOKEN");
	const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
	checks.push({ check: "bot_token_prefix", ok: bot.startsWith("xoxb-"), detail: "expected xoxb- token" });
	checks.push({ check: "app_token_prefix", ok: app.startsWith("xapp-"), detail: "expected xapp- token" });

	let auth: JsonObject | undefined;
	let scopes: Set<string> | undefined;
	try {
		const response = await slackRequest(context, "auth.test", bot);
		auth = response.data;
		scopes = slackScopes(response.headers);
		checks.push({
			check: "bot_auth",
			ok: true,
			detail: string(auth.team) ?? string(auth.team_id) ?? "authenticated",
		});
	} catch (error) {
		checks.push({ check: "bot_auth", ok: false, detail: error instanceof Error ? error.message : String(error) });
	}

	if (scopes) {
		const missing = SLACK_RUNTIME_SCOPES.filter((scope) => !scopes?.has(scope));
		checks.push({
			check: "runtime_scopes",
			ok: missing.length === 0,
			detail: missing.length === 0 ? "runtime scopes available" : `missing ${missing.join(", ")}`,
		});
		const discovery = SLACK_DISCOVERY_SCOPES.filter((scope) => !scopes?.has(scope));
		checks.push({
			check: "discovery_scopes",
			ok: true,
			detail:
				discovery.length === 0
					? "discovery scopes available"
					: `optional discovery scopes missing: ${discovery.join(", ")}`,
		});
	} else {
		checks.push({ check: "runtime_scopes", ok: true, detail: "Slack did not report installed scopes" });
	}

	try {
		await slackRequest(context, "apps.connections.open", app);
		checks.push({ check: "socket_mode", ok: true, detail: "Socket Mode connection authorized" });
	} catch (error) {
		checks.push({ check: "socket_mode", ok: false, detail: error instanceof Error ? error.message : String(error) });
	}

	const ok = checks.every((check) => check.ok);
	return {
		ok,
		data: {
			platform: "slack",
			ok,
			identity: auth ? { team: auth.team, user: auth.user, userId: auth.user_id } : undefined,
			checks,
		},
		lines: [
			`Slack: ${ok ? "ok" : "failed"}`,
			...checks.map((check) => `  ${check.ok ? "ok" : "fail"} ${check.check}: ${check.detail}`),
		],
	};
}

async function slackPages(
	context: CliContext,
	method: string,
	field: string,
	params: Record<string, string>,
): Promise<JsonObject[]> {
	const token = requiredEnvironment(context.environment, "SLACK_BOT_TOKEN");
	const values: JsonObject[] = [];
	let cursor = "";
	do {
		const response = await slackRequest(context, method, token, {
			...params,
			limit: "200",
			...(cursor ? { cursor } : {}),
		});
		for (const value of array(response.data[field])) {
			const item = slackItem(value);
			if (item) values.push(item);
		}
		const metadata = slackItem(response.data.response_metadata);
		cursor = string(metadata?.next_cursor) ?? "";
	} while (cursor);
	return values;
}

export async function slackChannels(context: CliContext, flags: CliFlags): Promise<CliResult> {
	const includePrivate = booleanFlag(flags, "private");
	const query = flag(flags, "query")?.toLowerCase();
	const channels = (
		await slackPages(context, "conversations.list", "channels", {
			exclude_archived: "true",
			types: includePrivate ? "public_channel,private_channel" : "public_channel",
		})
	)
		.filter((channel) => !query || string(channel.name)?.toLowerCase().includes(query))
		.map((channel) => ({
			id: string(channel.id),
			name: string(channel.name),
			private: channel.is_private === true,
			member: channel.is_member === true,
		}));
	return {
		data: { platform: "slack", channels },
		lines: channels.length
			? channels.map(
					(channel) => `${channel.id ?? "?"}  #${channel.name ?? "unknown"}${channel.private ? "  private" : ""}`,
				)
			: ["No Slack channels found."],
	};
}

export async function slackUsers(context: CliContext, flags: CliFlags): Promise<CliResult> {
	const includeBots = booleanFlag(flags, "bots");
	const query = flag(flags, "query")?.toLowerCase();
	const users = (await slackPages(context, "users.list", "members", {}))
		.filter((user) => includeBots || user.is_bot !== true)
		.map((user) => {
			const profile = slackItem(user.profile);
			return {
				id: string(user.id),
				name: string(profile?.display_name) || string(profile?.real_name) || string(user.name),
				bot: user.is_bot === true,
				deleted: user.deleted === true,
			};
		})
		.filter(
			(user) =>
				!user.deleted &&
				(!query || user.name?.toLowerCase().includes(query) || user.id?.toLowerCase().includes(query)),
		);
	return {
		data: { platform: "slack", users },
		lines: users.length
			? users.map((user) => `${user.id ?? "?"}  ${user.name ?? "unknown"}${user.bot ? "  bot" : ""}`)
			: ["No Slack users found."],
	};
}

export function slackManifest(flags: CliFlags): CliResult {
	const mode = flag(flags, "mode") ?? "socket";
	if (mode !== "socket" && mode !== "http") throw new Error("--mode must be socket or http.");
	const url = flag(flags, "url");
	if (mode === "http" && !url) throw new Error("Slack HTTP mode requires --url.");
	const manifest = {
		_metadata: { major_version: 1 },
		display_information: { name: "HeyPi" },
		features: { bot_user: { display_name: "HeyPi", always_online: false } },
		oauth_config: { scopes: { bot: [...SLACK_RUNTIME_SCOPES, ...SLACK_DISCOVERY_SCOPES] } },
		settings: {
			event_subscriptions: {
				...(mode === "http" ? { request_url: url } : {}),
				bot_events: ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"],
			},
			interactivity: { is_enabled: true, ...(mode === "http" ? { request_url: url } : {}) },
			org_deploy_enabled: false,
			socket_mode_enabled: mode === "socket",
		},
	};
	return { data: manifest, lines: [JSON.stringify(manifest, null, 2)] };
}

export function slackEnvExample(): CliResult {
	const data = {
		environment: ["SLACK_BOT_TOKEN=xoxb-...", "SLACK_APP_TOKEN=xapp-..."],
		typescript: "slack({ token: process.env.SLACK_BOT_TOKEN!, appToken: process.env.SLACK_APP_TOKEN! })",
	};
	return { data, lines: [...data.environment, "", data.typescript] };
}

async function discordRequest(context: CliContext, path: string): Promise<unknown> {
	const token = requiredEnvironment(context.environment, "DISCORD_TOKEN");
	const response = await context.fetch(`https://discord.com/api/v10${path}`, {
		headers: { authorization: `Bot ${token}` },
	});
	if (response.status === 429) {
		const retry = response.headers.get("retry-after");
		throw new Error(`Discord rate limited the request${retry ? `; retry after ${retry}s` : ""}.`);
	}
	if (!response.ok) throw new Error(`Discord request failed (${response.status}).`);
	try {
		return await response.json();
	} catch {
		throw new Error("Discord returned a non-JSON response.");
	}
}

export async function probeDiscordGateway(token: string, fetcher: typeof fetch): Promise<void> {
	const response = await fetcher("https://discord.com/api/v10/gateway/bot", {
		headers: { authorization: `Bot ${token}` },
	});
	const gateway = await responseJson(response, "Discord");
	const url = string(gateway.url);
	if (!url) throw new Error("Discord gateway response did not include a URL.");
	if (typeof WebSocket === "undefined") throw new Error("This Node runtime does not provide WebSocket support.");

	await new Promise<void>((resolvePromise, reject) => {
		const socket = new WebSocket(`${url}?v=10&encoding=json`);
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const timeout = setTimeout(() => finish(new Error("Discord gateway probe timed out.")), 10_000);
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (heartbeat) clearInterval(heartbeat);
			socket.close();
			if (error) reject(error);
			else resolvePromise();
		};
		socket.addEventListener("message", (message) => {
			let payload: JsonObject;
			try {
				payload = object(JSON.parse(String(message.data)));
			} catch {
				finish(new Error("Discord gateway returned an invalid payload."));
				return;
			}
			if (payload.op === 10) {
				const interval = object(payload.d).heartbeat_interval;
				if (typeof interval === "number") {
					heartbeat = setInterval(() => socket.send(JSON.stringify({ op: 1, d: null })), interval);
				}
				socket.send(
					JSON.stringify({
						op: 2,
						d: {
							token,
							intents: DISCORD_INTENTS,
							properties: { os: process.platform, browser: "heypi", device: "heypi" },
						},
					}),
				);
			}
			if (payload.op === 0 && payload.t === "READY") finish();
			if (payload.op === 9) finish(new Error("Discord gateway rejected the identify payload."));
		});
		socket.addEventListener("error", () => finish(new Error("Discord gateway connection failed.")));
		socket.addEventListener("close", (event) => {
			if (settled) return;
			if (event.code === 4014)
				finish(new Error("Discord rejected a privileged gateway intent; enable Message Content Intent."));
			else finish(new Error(`Discord gateway closed during the probe (${event.code}).`));
		});
	});
}

export async function discordCheck(context: CliContext): Promise<CliResult> {
	const token = requiredEnvironment(context.environment, "DISCORD_TOKEN");
	const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
	let identity: JsonObject | undefined;
	try {
		identity = object(await discordRequest(context, "/users/@me"));
		checks.push({
			check: "bot_auth",
			ok: true,
			detail: string(identity.username) ?? string(identity.id) ?? "authenticated",
		});
	} catch (error) {
		checks.push({ check: "bot_auth", ok: false, detail: error instanceof Error ? error.message : String(error) });
	}
	try {
		await context.discordGateway(token, context.fetch);
		checks.push({ check: "gateway", ok: true, detail: "Message Content Intent accepted" });
	} catch (error) {
		checks.push({ check: "gateway", ok: false, detail: error instanceof Error ? error.message : String(error) });
	}
	const ok = checks.every((check) => check.ok);
	return {
		ok,
		data: {
			platform: "discord",
			ok,
			identity: identity ? { id: identity.id, username: identity.username } : undefined,
			checks,
		},
		lines: [
			`Discord: ${ok ? "ok" : "failed"}`,
			...checks.map((check) => `  ${check.ok ? "ok" : "fail"} ${check.check}: ${check.detail}`),
		],
	};
}

export async function discordGuilds(context: CliContext): Promise<CliResult> {
	const guilds = array(await discordRequest(context, "/users/@me/guilds")).map((value) => {
		const guild = object(value);
		return { id: string(guild.id), name: string(guild.name), owner: guild.owner === true };
	});
	return {
		data: { platform: "discord", guilds },
		lines: guilds.length
			? guilds.map((guild) => `${guild.id ?? "?"}  ${guild.name ?? "unknown"}`)
			: ["No Discord guilds found."],
	};
}

export async function discordChannels(context: CliContext, flags: CliFlags): Promise<CliResult> {
	const guildId = flag(flags, "guild");
	if (!guildId) throw new Error("Discord channels requires --guild id.");
	const query = flag(flags, "query")?.toLowerCase();
	const channels = array(await discordRequest(context, `/guilds/${encodeURIComponent(guildId)}/channels`))
		.map((value) => {
			const channel = object(value);
			return {
				id: string(channel.id),
				name: string(channel.name),
				type: channel.type,
				parentId: string(channel.parent_id),
			};
		})
		.filter((channel) => !query || channel.name?.toLowerCase().includes(query));
	return {
		data: { platform: "discord", guild: guildId, channels },
		lines: channels.length
			? channels.map((channel) => `${channel.id ?? "?"}  ${channel.name ?? "unknown"}  type=${String(channel.type)}`)
			: ["No Discord channels found."],
	};
}

export function discordInvite(context: CliContext): CliResult {
	const clientId = requiredEnvironment(context.environment, "DISCORD_CLIENT_ID");
	const url = new URL("https://discord.com/oauth2/authorize");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("scope", "bot applications.commands");
	url.searchParams.set("permissions", DISCORD_PERMISSIONS);
	return { data: { platform: "discord", url: url.toString() }, lines: [url.toString()] };
}

export function discordEnvExample(): CliResult {
	const data = {
		environment: ["DISCORD_TOKEN=...", "DISCORD_CLIENT_ID=..."],
		typescript: "discord({ token: process.env.DISCORD_TOKEN!, clientId: process.env.DISCORD_CLIENT_ID })",
	};
	return { data, lines: [...data.environment, "", data.typescript] };
}

async function telegramRequest(context: CliContext, method: string, params?: JsonObject): Promise<JsonObject> {
	const token = requiredEnvironment(context.environment, "TELEGRAM_BOT_TOKEN");
	const response = await context.fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params ?? {}),
	});
	const data = await responseJson(response, "Telegram");
	if (data.ok !== true) throw new Error(`Telegram ${method} failed: ${string(data.description) ?? "unknown error"}.`);
	return data;
}

export async function telegramCheck(context: CliContext): Promise<CliResult> {
	const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
	let identity: JsonObject | undefined;
	let webhook: JsonObject | undefined;
	try {
		identity = object((await telegramRequest(context, "getMe")).result);
		checks.push({
			check: "bot_auth",
			ok: true,
			detail: `@${string(identity.username) ?? string(identity.id) ?? "unknown"}`,
		});
	} catch (error) {
		checks.push({ check: "bot_auth", ok: false, detail: error instanceof Error ? error.message : String(error) });
	}
	try {
		webhook = object((await telegramRequest(context, "getWebhookInfo")).result);
		const configured = Boolean(string(webhook.url));
		checks.push({
			check: "long_polling",
			ok: !configured,
			detail: configured
				? "webhook is configured; HeyPi long polling cannot receive updates"
				: "no webhook configured",
		});
	} catch (error) {
		checks.push({ check: "long_polling", ok: false, detail: error instanceof Error ? error.message : String(error) });
	}
	const ok = checks.every((check) => check.ok);
	return {
		ok,
		data: {
			platform: "telegram",
			ok,
			identity,
			webhook: webhook ? { url: webhook.url, pendingUpdates: webhook.pending_update_count } : undefined,
			checks,
		},
		lines: [
			`Telegram: ${ok ? "ok" : "failed"}`,
			...checks.map((check) => `  ${check.ok ? "ok" : "fail"} ${check.check}: ${check.detail}`),
		],
	};
}

export async function telegramWebhookInfo(context: CliContext): Promise<CliResult> {
	const webhook = object((await telegramRequest(context, "getWebhookInfo")).result);
	const data = {
		url: string(webhook.url) ?? "",
		pendingUpdates: webhook.pending_update_count,
		lastError: webhook.last_error_message,
		maxConnections: webhook.max_connections,
		allowedUpdates: webhook.allowed_updates,
	};
	return {
		data: { platform: "telegram", webhook: data },
		lines: [
			`Webhook: ${data.url || "not configured"}`,
			`Pending updates: ${String(data.pendingUpdates ?? 0)}`,
			...(data.lastError ? [`Last error: ${String(data.lastError)}`] : []),
		],
	};
}

export async function telegramListen(context: CliContext, flags: CliFlags): Promise<CliResult> {
	if (!booleanFlag(flags, "force")) {
		throw new Error(
			"telegram listen competes with the running bot and may consume updates; pass --force to continue.",
		);
	}
	const timeoutText = flag(flags, "timeout") ?? "20";
	const timeout = Number(timeoutText);
	if (!Number.isInteger(timeout) || timeout < 0 || timeout > 50)
		throw new Error("--timeout must be an integer from 0 to 50.");
	const webhook = object((await telegramRequest(context, "getWebhookInfo")).result);
	if (string(webhook.url)) throw new Error("Telegram getUpdates is unavailable while a webhook is configured.");
	const updates = array((await telegramRequest(context, "getUpdates", { timeout, limit: 100 })).result);
	const chats = new Map<string, { id: string; type?: string; title?: string; username?: string }>();
	for (const value of updates) {
		const update = object(value);
		const message = slackItem(update.message) ?? slackItem(update.edited_message) ?? slackItem(update.channel_post);
		const chat = slackItem(message?.chat) ?? slackItem(slackItem(update.callback_query)?.message)?.chat;
		const item = slackItem(chat);
		const id = item ? String(item.id) : undefined;
		if (!id || !item) continue;
		chats.set(id, {
			id,
			type: string(item.type),
			title:
				string(item.title) ||
				[string(item.first_name), string(item.last_name)].filter(Boolean).join(" ") ||
				undefined,
			username: string(item.username),
		});
	}
	const values = [...chats.values()];
	return {
		data: { platform: "telegram", warning: "getUpdates competes with the running HeyPi adapter", chats: values },
		lines: [
			"Warning: this command queried the bot's getUpdates queue.",
			...(values.length
				? values.map((chat) => `${chat.id}  ${chat.title ?? chat.username ?? chat.type ?? "chat"}`)
				: ["No Telegram chats observed."]),
		],
	};
}

export function telegramEnvExample(): CliResult {
	const data = {
		environment: ["TELEGRAM_BOT_TOKEN=..."],
		typescript: "telegram({ token: process.env.TELEGRAM_BOT_TOKEN! })",
	};
	return { data, lines: [...data.environment, "", data.typescript] };
}
