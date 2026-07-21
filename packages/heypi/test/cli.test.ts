import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CliDependencies, runCli } from "../src/cli-run.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "heypi-cli-"));
	temporaryDirectories.push(directory);
	return directory;
}

function response(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json", ...init.headers },
		...init,
	});
}

function harness(dependencies: CliDependencies = {}) {
	let stdout = "";
	let stderr = "";
	return {
		dependencies: {
			environment: {},
			...dependencies,
			io: {
				stdout: (value: string) => {
					stdout += value;
				},
				stderr: (value: string) => {
					stderr += value;
				},
			},
		} satisfies CliDependencies,
		stdout: () => stdout,
		stderr: () => stderr,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("CLI", () => {
	it("loads default env files with exported environment taking precedence", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, ".env"), "DISCORD_CLIENT_ID=default-client\n");
		await writeFile(join(cwd, ".env.local"), "DISCORD_CLIENT_ID=local-client\n");
		const cli = harness({ cwd, environment: { DISCORD_CLIENT_ID: "exported-client" } });

		expect(await runCli(["discord", "invite"], cli.dependencies)).toBe(0);
		expect(cli.stdout()).toContain("client_id=exported-client");
		expect(cli.stdout()).toContain("permissions=274878024704");
		expect(cli.stdout()).not.toContain("local-client");
	});

	it("redacts configured secrets from failed checks", async () => {
		const token = "test-discord-secret";
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ id: "1", username: "heypi" }));
		const cli = harness({
			environment: { DISCORD_TOKEN: token },
			fetch,
			discordGateway: async () => {
				throw new Error(`gateway rejected ${token}`);
			},
		});

		expect(await runCli(["discord", "check"], cli.dependencies)).toBe(1);
		expect(cli.stdout()).toContain("gateway rejected [redacted]");
		expect(cli.stdout()).not.toContain(token);
	});

	it("paginates and filters Slack channel discovery", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			const body = new URLSearchParams(String(init?.body));
			if (!body.get("cursor")) {
				return response({
					ok: true,
					channels: [{ id: "C1", name: "general", is_private: false }],
					response_metadata: { next_cursor: "next" },
				});
			}
			return response({
				ok: true,
				channels: [{ id: "C2", name: "project-private", is_private: true }],
				response_metadata: { next_cursor: "" },
			});
		});
		const cli = harness({ environment: { SLACK_BOT_TOKEN: "xoxb-test-secret" }, fetch });

		expect(await runCli(["slack", "channels", "--private", "--query", "project"], cli.dependencies)).toBe(0);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(cli.stdout()).toContain("C2  #project-private  private");
		expect(cli.stdout()).not.toContain("xoxb-test-secret");
	});

	it("generates only the supported Slack Socket Mode manifest", async () => {
		const cli = harness();

		expect(await runCli(["slack", "manifest", "--json"], cli.dependencies)).toBe(0);
		expect(JSON.parse(cli.stdout())).toMatchObject({ settings: { socket_mode_enabled: true } });
		expect(cli.stdout()).not.toContain("request_url");
	});

	it("checks Discord REST authentication and gateway intents", async () => {
		const gateway = vi.fn(async () => undefined);
		const cli = harness({
			environment: { DISCORD_TOKEN: "discord-test-secret" },
			fetch: vi.fn<typeof globalThis.fetch>(async () => response({ id: "1", username: "heypi" })),
			discordGateway: gateway,
		});

		expect(await runCli(["discord", "check", "--json"], cli.dependencies)).toBe(0);
		const output = JSON.parse(cli.stdout());
		expect(output).toMatchObject({ platform: "discord", ok: true, identity: { username: "heypi" } });
		expect(gateway).toHaveBeenCalledOnce();
	});

	it("reports Telegram setup as JSON without exposing its token", async () => {
		const token = "123456:test-telegram-secret";
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			const url = String(input);
			if (url.endsWith("/getMe")) return response({ ok: true, result: { id: 1, username: "heypi_bot" } });
			if (url.endsWith("/getWebhookInfo")) {
				return response({ ok: true, result: { url: "", pending_update_count: 0 } });
			}
			throw new Error("Unexpected Telegram request");
		});
		const cli = harness({ environment: { TELEGRAM_BOT_TOKEN: token }, fetch });

		expect(await runCli(["telegram", "check", "--json"], cli.dependencies)).toBe(0);
		expect(JSON.parse(cli.stdout())).toMatchObject({ platform: "telegram", ok: true });
		expect(cli.stdout()).not.toContain(token);
	});

	it("refuses Telegram polling by default and never prints message content", async () => {
		const token = "123456:test-telegram-secret";
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			const url = String(input);
			if (url.endsWith("/getWebhookInfo")) return response({ ok: true, result: { url: "" } });
			if (url.endsWith("/getUpdates")) {
				return response({
					ok: true,
					result: [
						{
							update_id: 1,
							message: { text: "private message", chat: { id: -12, type: "group", title: "Ops" } },
						},
					],
				});
			}
			throw new Error("Unexpected Telegram request");
		});
		const refused = harness({ environment: { TELEGRAM_BOT_TOKEN: token }, fetch });
		expect(await runCli(["telegram", "listen"], refused.dependencies)).toBe(1);
		expect(refused.stderr()).toContain("pass --force");
		expect(fetch).not.toHaveBeenCalled();

		const forced = harness({ environment: { TELEGRAM_BOT_TOKEN: token }, fetch });
		expect(await runCli(["telegram", "listen", "--force", "--timeout", "0"], forced.dependencies)).toBe(0);
		expect(forced.stdout()).toContain("-12  Ops");
		expect(forced.stdout()).not.toContain("private message");
	});
});
