import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	type AgentContextProvider,
	approval,
	type CommandPolicyConfig,
	classifyCommand,
	defineTool,
} from "@hunvreus/heypi/authoring";
import { Type } from "@sinclair/typebox";

type Host = {
	id: string;
	name: string;
	address: string;
	user: string;
	port: number;
	key: string;
	publicKey?: string;
	cwd?: string;
	aliases: string[];
	tags: string[];
	facts: HostFacts;
	createdAt: string;
	updatedAt: string;
};

type HostFacts = {
	hostname?: string;
	os?: string;
	arch?: string;
	kernel?: string;
	distro?: string;
	pkgManager?: string;
	serviceManager?: string;
	containerRuntime?: string;
	containerVersion?: string;
	runningContainers?: string;
	diskRoot?: string;
	memory?: string;
	ports?: string;
	gitUser?: string;
	hasSudo?: boolean;
};

type HostFile = {
	version: 1;
	hosts: Host[];
};

type HostToolOptions = {
	root: string;
	commandPolicy?: CommandPolicyConfig;
	timeoutMs?: number;
};

type ProcessResult = {
	code: number;
	out: string;
	err: string;
	ms: number;
};

const DEFAULT_KEY = "default";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64 * 1024;

const commandPolicy: CommandPolicyConfig = {
	allow: [
		/^\s*curl\s+-I\b[^;&|]*\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|\b)\s*(?:\|\|\s*true\s*)?$/i,
		/^\s*curl\s+[^;&|]*--head\b[^;&|]*\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|\b)\s*(?:\|\|\s*true\s*)?$/i,
	],
	approve: [
		/\bsystemctl\s+(restart|stop|start|reload|enable|disable|mask|unmask)\b/i,
		/\bdocker\s+(restart|stop|rm|compose\s+up|compose\s+down|prune)\b/i,
		/\bapt(?:-get)?\s+(install|remove|purge|upgrade|dist-upgrade|autoremove)\b/i,
		/\byum\s+(install|remove|update|upgrade)\b/i,
		/\bufw\s+(allow|deny|delete|enable|disable|reload|reset)\b/i,
		/\bfirewall-cmd\b/i,
		/\biptables\b/i,
		/\bnft\s+(add|delete|flush|insert|replace)\b/i,
	],
	block: [/\bcat\s+.*(?:\.env|id_rsa|id_ed25519)\b/i, /\bchmod\s+777\b/i],
};

export function createHostTools(options: HostToolOptions) {
	const store = new HostStore(options.root);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const remoteConfirm = approval.command(options.commandPolicy);
	return [
		defineTool({
			name: "host_key_ensure",
			description:
				"Create a named SSH keypair for remote hosts if missing and return only the public key. Never returns private key material.",
			input: Type.Object({
				name: Type.Optional(Type.String({ description: "Key name. Defaults to default." })),
			}),
			run: async ({ name }) => {
				const key = await store.ensureKey(keyName(name));
				return [`key=${key.name}`, `publicKey:`, key.publicKey].join("\n");
			},
		}),
		defineTool({
			name: "host_key_public",
			description: "Return the public SSH key for a named host key. Does not return private key material.",
			input: Type.Object({
				name: Type.Optional(Type.String({ description: "Key name. Defaults to default." })),
			}),
			run: async ({ name }) => {
				const key = await store.readPublicKey(keyName(name));
				return [`key=${key.name}`, `publicKey:`, key.publicKey].join("\n");
			},
		}),
		defineTool({
			name: "hosts_list",
			description: "List configured remote hosts and tags from the file-backed host inventory.",
			input: Type.Object({}),
			run: async () => {
				const hosts = (await store.read()).hosts;
				if (!hosts.length) return "no hosts configured";
				return hosts
					.map((host) =>
						[
							host.id,
							`${host.user}@${host.address}:${host.port}`,
							`key=${host.key}`,
							host.tags.length ? `tags=${host.tags.join(",")}` : undefined,
							host.aliases.length ? `aliases=${host.aliases.join(",")}` : undefined,
							hasFacts(host.facts) ? `facts=${factsText(host.facts)}` : undefined,
						]
							.filter(Boolean)
							.join(" "),
					)
					.join("\n");
			},
		}),
		defineTool<{ host: string }>({
			name: "hosts_lookup",
			description: "Look up one host by exact id, name, alias, or tag.",
			input: Type.Object({
				host: Type.String({ description: "Host id, name, alias, or tag." }),
			}),
			run: async ({ host }) => {
				const matches = await store.resolve(host);
				if (!matches.length) return `host not found: ${host}`;
				return matches.map((item) => JSON.stringify(publicHost(item), null, 2)).join("\n");
			},
		}),
		defineTool<{ hosts?: string[] }>({
			name: "host_facts_refresh",
			description:
				"Probe configured remote hosts over SSH and persist facts: hostname, OS, architecture, kernel, distro, package manager, service manager, container runtime/version, disk, memory, ports 80/443, git user, and passwordless sudo availability.",
			input: Type.Object({
				hosts: Type.Optional(
					Type.Array(
						Type.String({ description: "Host ids, aliases, or tags. Omit to refresh all configured hosts." }),
						{
							maxItems: 8,
						},
					),
				),
			}),
			run: async ({ hosts }, ctx) => {
				const targets = hosts?.length ? await store.resolveMany(hosts) : (await store.read()).hosts;
				if (!targets.length) return hosts?.length ? `no hosts matched: ${hosts.join(", ")}` : "no hosts configured";
				const out: string[] = [];
				for (const host of targets) {
					const key = store.privateKeyPath(host.key);
					if (!existsSync(key)) {
						out.push(`${host.id}: missing private key: ${host.key}; run host_key_ensure first`);
						continue;
					}
					const result = await ssh(
						host,
						key,
						store.knownHostsPath(),
						factsCommand(),
						Math.min(timeoutMs, 20_000),
						ctx.signal,
					);
					if (result.code !== 0 && !result.out.trim()) {
						out.push(`${host.id}: ${result.err.trim() || `fact probe failed with exit ${result.code}`}`);
						continue;
					}
					const facts = parseFacts(result.out);
					await store.setFacts(host.id, facts);
					out.push(`${host.id}: ${factsText(facts)}`);
				}
				return out.join("\n");
			},
		}),
		defineTool<{
			id: string;
			address: string;
			user?: string;
			port?: number;
			key?: string;
			cwd?: string;
			aliases?: string[];
			tags?: string[];
		}>({
			name: "hosts_upsert",
			description:
				"Add or update a remote host in the file-backed inventory. Ensures the referenced SSH key exists and stores its public key.",
			input: Type.Object({
				id: Type.String({ description: "Stable host id, e.g. web-1." }),
				address: Type.String({ description: "DNS name or IP address." }),
				user: Type.Optional(Type.String({ description: "SSH user. Defaults to deploy." })),
				port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "SSH port. Defaults to 22." })),
				key: Type.Optional(Type.String({ description: "Key name. Defaults to default." })),
				cwd: Type.Optional(Type.String({ description: "Remote working directory for commands." })),
				aliases: Type.Optional(Type.Array(Type.String())),
				tags: Type.Optional(Type.Array(Type.String())),
			}),
			confirm: ({ id, address, user, port }) => ({
				reason: `Add or update host ${String(id)}.`,
				details: [
					{ label: "Host", value: String(id) },
					{ label: "Address", value: String(address) },
					...(typeof user === "string" ? [{ label: "SSH user", value: user }] : []),
					...(typeof port === "number" ? [{ label: "SSH port", value: String(port) }] : []),
				],
			}),
			run: async (input) => {
				const host = await store.upsert(input);
				return [
					`Saved host ${host.id}.`,
					`SSH target: ${host.user}@${host.address}:${host.port}`,
					`Key: ${host.key}`,
					host.tags.length ? `Tags: ${host.tags.join(", ")}` : undefined,
					host.aliases.length ? `Aliases: ${host.aliases.join(", ")}` : undefined,
					"",
					`Add this public key to ~/.ssh/authorized_keys for user ${host.user} on ${host.address}:`,
					host.publicKey ?? "(public key missing)",
					"",
					"After installing it, tell me the key is installed and I can test the connection.",
				]
					.filter(Boolean)
					.join("\n");
			},
		}),
		defineTool<{ host: string }>({
			name: "hosts_remove",
			description: "Remove a host from the file-backed inventory.",
			input: Type.Object({
				host: Type.String({ description: "Exact host id to remove." }),
			}),
			confirm: ({ host }) => ({
				reason: `Remove host ${String(host)}.`,
				details: [{ label: "Host", value: String(host) }],
			}),
			run: async ({ host }) => {
				const removed = await store.remove(hostId(host));
				return removed ? `host removed: ${removed.id}` : `host not found: ${host}`;
			},
		}),
		defineTool<{ hosts: string[]; purpose: string; command: string }>({
			name: "host_exec",
			description:
				"Run a command on one or more configured remote hosts over SSH using the file-backed host inventory. Include a concise human purpose explaining why the command is being run.",
			input: Type.Object({
				hosts: Type.Array(Type.String({ description: "Host ids, aliases, or tags." }), {
					minItems: 1,
					maxItems: 8,
				}),
				purpose: Type.String({ description: "Human-readable reason for this remote command." }),
				command: Type.String({ description: "Remote shell command." }),
			}),
			confirm: ({ hosts, purpose, command }) => {
				const confirmation = remoteConfirm({ command });
				if (!confirmation) return false;
				const target = Array.isArray(hosts) ? hosts.map(String).join(", ") : String(hosts);
				const message =
					typeof purpose === "string" && purpose.trim() ? purpose.trim() : `Run remote command on ${target}.`;
				return {
					...confirmation,
					message,
					details: [
						{ label: "Target", value: target },
						{ label: "Command", value: String(command), format: "code" },
					],
				};
			},
			run: async ({ hosts, command }, ctx) => {
				const risk = classifyCommand(command, options.commandPolicy);
				if (risk.risk === "block") return `blocked: ${risk.reason}`;
				const targets = await store.resolveMany(hosts);
				if (!targets.length) return `no hosts matched: ${hosts.join(", ")}`;
				const out: string[] = [];
				for (const host of targets) {
					const key = store.privateKeyPath(host.key);
					if (!existsSync(key)) {
						out.push(`## ${host.id}\nmissing private key: ${host.key}; run host_key_ensure first`);
						continue;
					}
					const result = await ssh(host, key, store.knownHostsPath(), command, timeoutMs, ctx.signal);
					out.push(renderExec(host, result));
				}
				return out.join("\n\n");
			},
		}),
	];
}

export function createHostContext(options: Pick<HostToolOptions, "root">): AgentContextProvider {
	const store = new HostStore(options.root);
	return async () => {
		const summary = await store.summary();
		if (!summary) return undefined;
		return { title: "Known hosts", text: summary };
	};
}

export class HostStore {
	private readonly root: string;
	private readonly file: string;
	private readonly keyRoot: string;

	constructor(root: string) {
		this.root = resolve(root);
		this.file = join(this.root, "hosts.json");
		this.keyRoot = join(this.root, "keys");
	}

	async read(): Promise<HostFile> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as HostFile;
			return { version: 1, hosts: Array.isArray(parsed.hosts) ? parsed.hosts.map(normalizeHost) : [] };
		} catch (error) {
			if (isNotFound(error)) return { version: 1, hosts: [] };
			throw error;
		}
	}

	async upsert(input: {
		id: string;
		address: string;
		user?: string;
		port?: number;
		key?: string;
		cwd?: string;
		aliases?: string[];
		tags?: string[];
	}): Promise<Host> {
		const now = new Date().toISOString();
		const id = hostId(input.id);
		const key = await this.ensureKey(keyName(input.key));
		const current = await this.read();
		const existing = current.hosts.find((host) => host.id === id);
		const host: Host = {
			id,
			name: id,
			address: address(input.address),
			user: sshUser(input.user ?? existing?.user ?? "deploy"),
			port: port(input.port ?? existing?.port ?? 22),
			key: key.name,
			publicKey: key.publicKey,
			cwd: input.cwd?.trim() || existing?.cwd,
			aliases: cleanList(input.aliases ?? existing?.aliases ?? []).map(hostId),
			tags: cleanList(input.tags ?? existing?.tags ?? []).map(tag),
			facts: existing?.facts ?? {},
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		await this.write({ version: 1, hosts: [...current.hosts.filter((item) => item.id !== id), host] });
		return host;
	}

	async remove(id: string): Promise<Host | undefined> {
		const current = await this.read();
		const removed = current.hosts.find((host) => host.id === id);
		if (!removed) return undefined;
		await this.write({ version: 1, hosts: current.hosts.filter((host) => host.id !== id) });
		return removed;
	}

	async resolve(input: string): Promise<Host[]> {
		const needle = input.trim();
		const hosts = (await this.read()).hosts;
		return hosts.filter(
			(host) =>
				host.id === needle || host.name === needle || host.aliases.includes(needle) || host.tags.includes(needle),
		);
	}

	async resolveMany(input: string[]): Promise<Host[]> {
		const byId = new Map<string, Host>();
		for (const query of input) {
			for (const host of await this.resolve(query)) byId.set(host.id, host);
		}
		return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	async setFacts(input: string, facts: HostFacts): Promise<Host | undefined> {
		const current = await this.read();
		const host = current.hosts.find((item) => item.id === input);
		if (!host) return undefined;
		const next = { ...host, facts, updatedAt: new Date().toISOString() };
		await this.write({ version: 1, hosts: [...current.hosts.filter((item) => item.id !== host.id), next] });
		return next;
	}

	async summary(): Promise<string> {
		const hosts = (await this.read()).hosts;
		if (!hosts.length) return "";
		return hosts
			.map((host) =>
				[
					`- ${host.id}`,
					`${host.user}@${host.address}:${host.port}`,
					host.tags.length ? `tags=${host.tags.join(",")}` : undefined,
					host.aliases.length ? `aliases=${host.aliases.join(",")}` : undefined,
					host.cwd ? `cwd=${host.cwd}` : undefined,
					hasFacts(host.facts) ? `facts=${factsText(host.facts)}` : undefined,
				]
					.filter(Boolean)
					.join(" "),
			)
			.join("\n");
	}

	async ensureKey(name: string): Promise<{ name: string; publicKey: string }> {
		const privateKey = this.privateKeyPath(name);
		const publicKey = this.publicKeyPath(name);
		await mkdir(dirname(privateKey), { recursive: true });
		if (!existsSync(privateKey) || !existsSync(publicKey)) {
			const result = await processRun(
				"ssh-keygen",
				["-t", "ed25519", "-N", "", "-f", privateKey, "-C", `heypi-${name}`],
				{
					cwd: this.root,
					timeoutMs: 30_000,
				},
			);
			if (result.code !== 0) throw new Error(result.err || result.out || "ssh-keygen failed");
			await chmod(privateKey, 0o600);
			await chmod(publicKey, 0o644);
		}
		return await this.readPublicKey(name);
	}

	async readPublicKey(name: string): Promise<{ name: string; publicKey: string }> {
		const publicKey = await readFile(this.publicKeyPath(name), "utf8");
		return { name, publicKey: publicKey.trim() };
	}

	privateKeyPath(name: string): string {
		return join(this.keyRoot, keyName(name));
	}

	publicKeyPath(name: string): string {
		return `${this.privateKeyPath(name)}.pub`;
	}

	knownHostsPath(): string {
		return join(this.root, "known_hosts");
	}

	private async write(input: HostFile): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const sorted = [...input.hosts].sort((a, b) => a.id.localeCompare(b.id));
		const tmp = `${this.file}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify({ version: 1, hosts: sorted }, null, 2)}\n`, "utf8");
		await rename(tmp, this.file);
	}
}

async function ssh(
	host: Host,
	key: string,
	knownHosts: string,
	command: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProcessResult> {
	await mkdir(dirname(knownHosts), { recursive: true });
	const remote = `${host.user}@${host.address}`;
	const remoteCommand = host.cwd ? `cd ${quote(host.cwd)} && ${command}` : command;
	return await processRun(
		"ssh",
		[
			"-i",
			key,
			"-p",
			String(host.port),
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`UserKnownHostsFile=${knownHosts}`,
			"-o",
			"ConnectTimeout=10",
			remote,
			remoteCommand,
		],
		{ cwd: process.cwd(), timeoutMs, signal },
	);
}

async function processRun(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessResult> {
	const start = Date.now();
	return await new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve({ code: 130, out: "", err: "Command cancelled", ms: Date.now() - start });
			return;
		}
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		let done = false;
		const finish = (result: ProcessResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const abort = () => {
			child.kill("SIGKILL");
			finish({ code: 130, out: clip(out), err: clip(`${err}\nCommand cancelled`), ms: Date.now() - start });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ code: 124, out: clip(out), err: clip(`${err}\nCommand timed out`), ms: Date.now() - start });
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
		});
		child.on("error", (error) =>
			finish({ code: 127, out: clip(out), err: clip(`${err}${error.message}`), ms: Date.now() - start }),
		);
		child.on("close", (code) => finish({ code: code ?? 1, out: clip(out), err: clip(err), ms: Date.now() - start }));
	});
}

function renderExec(host: Host, result: ProcessResult): string {
	const status = result.code === 0 ? "succeeded" : `failed with exit code ${result.code}`;
	const lines = [`${host.id}: command ${status} (${result.ms} ms)`];
	if (result.out.trim()) lines.push(result.out.trim());
	if (result.err.trim()) lines.push("Error output:", result.err.trim());
	return lines.join("\n");
}

function publicHost(host: Host): Omit<Host, "publicKey"> & { publicKey: string | undefined } {
	return { ...host, publicKey: host.publicKey };
}

function normalizeHost(input: Host): Host {
	const now = new Date().toISOString();
	return {
		id: hostId(input.id),
		name: hostId(input.name || input.id),
		address: address(input.address),
		user: sshUser(input.user),
		port: port(input.port),
		key: keyName(input.key),
		publicKey: input.publicKey,
		cwd: input.cwd,
		aliases: cleanList(input.aliases).map(hostId),
		tags: cleanList(input.tags).map(tag),
		facts: normalizeFacts(input.facts),
		createdAt: input.createdAt || now,
		updatedAt: input.updatedAt || now,
	};
}

function factsCommand(): string {
	return [
		"set +e",
		"echo hostname=$(hostname 2>/dev/null || true)",
		"echo os=$(uname -s 2>/dev/null || true)",
		"echo arch=$(uname -m 2>/dev/null || true)",
		"echo kernel=$(uname -r 2>/dev/null || true)",
		"if [ -f /etc/os-release ]; then . /etc/os-release; echo distro=$" + "{ID:-$NAME}; fi",
		"if command -v apt-get >/dev/null 2>&1; then echo pkgManager=apt; elif command -v yum >/dev/null 2>&1; then echo pkgManager=yum; elif command -v dnf >/dev/null 2>&1; then echo pkgManager=dnf; elif command -v apk >/dev/null 2>&1; then echo pkgManager=apk; elif command -v zypper >/dev/null 2>&1; then echo pkgManager=zypper; fi",
		"if command -v systemctl >/dev/null 2>&1; then echo serviceManager=systemd; elif command -v service >/dev/null 2>&1; then echo serviceManager=service; fi",
		"if command -v docker >/dev/null 2>&1; then echo containerRuntime=docker; elif command -v podman >/dev/null 2>&1; then echo containerRuntime=podman; elif command -v nerdctl >/dev/null 2>&1; then echo containerRuntime=nerdctl; fi",
		"if command -v docker >/dev/null 2>&1; then echo containerVersion=$(docker --version 2>/dev/null | sed 's/[[:space:]]\\+/ /g'); elif command -v podman >/dev/null 2>&1; then echo containerVersion=$(podman --version 2>/dev/null | sed 's/[[:space:]]\\+/ /g'); elif command -v nerdctl >/dev/null 2>&1; then echo containerVersion=$(nerdctl --version 2>/dev/null | sed 's/[[:space:]]\\+/ /g'); fi",
		"if command -v docker >/dev/null 2>&1; then echo runningContainers=$(docker ps --format '{{.Names}}' 2>/dev/null | paste -sd, -); elif command -v podman >/dev/null 2>&1; then echo runningContainers=$(podman ps --format '{{.Names}}' 2>/dev/null | paste -sd, -); fi",
		'echo diskRoot=$(df -h / 2>/dev/null | awk \'NR==2 {print $4 " free / " $2 " total (" $5 " used)"}\')',
		'echo memory=$(free -m 2>/dev/null | awk \'/^Mem:/ {print $7 "MB available / " $2 "MB total"}\')',
		"if command -v ss >/dev/null 2>&1; then echo ports=$(ss -ltn 2>/dev/null | awk 'NR>1 && ($4 ~ /:80$/ || $4 ~ /:443$/) {print $4}' | paste -sd, -); elif command -v netstat >/dev/null 2>&1; then echo ports=$(netstat -ltn 2>/dev/null | awk 'NR>2 && ($4 ~ /:80$/ || $4 ~ /:443$/) {print $4}' | paste -sd, -); fi",
		"echo gitUser=$(git config --global user.name 2>/dev/null || true)",
		"if sudo -n true >/dev/null 2>&1; then echo hasSudo=true; else echo hasSudo=false; fi",
	].join("; ");
}

function parseFacts(text: string): HostFacts {
	const facts: HostFacts = {};
	for (const line of text.split(/\r?\n/)) {
		const [key, ...rest] = line.trim().split("=");
		const value = rest.join("=").trim();
		if (!key || !value) continue;
		if (key === "hostname") facts.hostname = value;
		if (key === "os") facts.os = value;
		if (key === "arch") facts.arch = value;
		if (key === "kernel") facts.kernel = value;
		if (key === "distro") facts.distro = value;
		if (key === "pkgManager") facts.pkgManager = value;
		if (key === "serviceManager") facts.serviceManager = value;
		if (key === "containerRuntime") facts.containerRuntime = value;
		if (key === "containerVersion") facts.containerVersion = value;
		if (key === "runningContainers") facts.runningContainers = value;
		if (key === "diskRoot") facts.diskRoot = value;
		if (key === "memory") facts.memory = value;
		if (key === "ports") facts.ports = value;
		if (key === "gitUser") facts.gitUser = value;
		if (key === "hasSudo") facts.hasSudo = value === "true";
	}
	return facts;
}

function factsText(facts: HostFacts): string {
	return [
		`hostname=${facts.hostname ?? "unknown"}`,
		`os=${facts.os ?? "unknown"}`,
		`arch=${facts.arch ?? "unknown"}`,
		`kernel=${facts.kernel ?? "unknown"}`,
		`distro=${facts.distro ?? "unknown"}`,
		`pkg=${facts.pkgManager ?? "unknown"}`,
		`service=${facts.serviceManager ?? "unknown"}`,
		`container=${facts.containerRuntime ?? "unknown"}`,
		facts.containerVersion ? `containerVersion=${facts.containerVersion}` : undefined,
		facts.runningContainers ? `containers=${facts.runningContainers}` : undefined,
		facts.diskRoot ? `diskRoot=${facts.diskRoot}` : undefined,
		facts.memory ? `memory=${facts.memory}` : undefined,
		facts.ports ? `ports=${facts.ports}` : undefined,
		facts.gitUser ? `gitUser=${facts.gitUser}` : undefined,
		`sudo=${facts.hasSudo === undefined ? "unknown" : facts.hasSudo ? "yes" : "no"}`,
	]
		.filter((item): item is string => typeof item === "string")
		.join(", ");
}

function hasFacts(facts: HostFacts): boolean {
	return Object.values(facts).some((value) => value !== undefined);
}

function normalizeFacts(input: unknown): HostFacts {
	if (!input || typeof input !== "object" || Array.isArray(input)) return {};
	const raw = input as Record<string, unknown>;
	return {
		hostname: stringFact(raw.hostname),
		os: stringFact(raw.os),
		arch: stringFact(raw.arch),
		kernel: stringFact(raw.kernel),
		distro: stringFact(raw.distro),
		pkgManager: stringFact(raw.pkgManager),
		serviceManager: stringFact(raw.serviceManager),
		containerRuntime: stringFact(raw.containerRuntime),
		containerVersion: stringFact(raw.containerVersion),
		runningContainers: stringFact(raw.runningContainers),
		diskRoot: stringFact(raw.diskRoot),
		memory: stringFact(raw.memory),
		ports: stringFact(raw.ports),
		gitUser: stringFact(raw.gitUser),
		hasSudo: typeof raw.hasSudo === "boolean" ? raw.hasSudo : undefined,
	};
}

function stringFact(input: unknown): string | undefined {
	return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function keyName(input: unknown): string {
	const value = stringValue(input, DEFAULT_KEY);
	if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) throw new Error(`invalid key name: ${value}`);
	if (value.includes("..")) throw new Error(`invalid key name: ${value}`);
	return value;
}

function hostId(input: unknown): string {
	const value = stringValue(input);
	if (!/^[A-Za-z0-9_.-]{1,80}$/.test(value)) throw new Error(`invalid host id: ${value}`);
	return value;
}

function tag(input: unknown): string {
	const value = stringValue(input);
	if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(value)) throw new Error(`invalid tag: ${value}`);
	return value;
}

function address(input: unknown): string {
	const value = stringValue(input);
	if (/\s/.test(value) || value.length > 255) throw new Error(`invalid host address: ${value}`);
	return value;
}

function sshUser(input: unknown): string {
	const value = stringValue(input);
	if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/.test(value)) throw new Error(`invalid ssh user: ${value}`);
	return value;
}

function port(input: unknown): number {
	const value = Number(input);
	if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`invalid ssh port: ${input}`);
	return value;
}

function cleanList(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return input.map((item) => String(item).trim()).filter(Boolean);
}

function stringValue(input: unknown, fallback?: string): string {
	const value = typeof input === "string" ? input.trim() : fallback;
	if (!value) throw new Error("missing value");
	return value;
}

function quote(input: string): string {
	return `'${input.replaceAll("'", "'\\''")}'`;
}

function clip(input: string): string {
	if (input.length <= MAX_OUTPUT) return input;
	return `...[truncated]\n${input.slice(input.length - MAX_OUTPUT)}`;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export default createHostTools({
	root: "./state",
	commandPolicy,
	timeoutMs: DEFAULT_TIMEOUT_MS,
});
