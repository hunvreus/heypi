import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createHeypi, defaultTools, defineTool, loadAgent, runHeypi, webhook, workspace } from "@hunvreus/heypi";
import { dockerRuntime } from "@hunvreus/heypi-runtime-docker";
import { Type } from "@sinclair/typebox";

loadEnv(".env");

function loadEnv(path: string): void {
	if (existsSync(path)) loadEnvFile(path);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var: ${name}`);
	return value;
}

function optional(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

const repo = parseRepo(required("HEYPI_GITHUB_REPO"));

const githubIssueGet = defineTool<{ issue: number }>({
	name: "github_issue_get",
	description: "Fetch the configured GitHub issue, including recent comments.",
	input: Type.Object({
		issue: Type.Number({ minimum: 1 }),
	}),
	run: async ({ issue }) => {
		const item = await githubRequest<Record<string, unknown>>(`/repos/${repo.owner}/${repo.name}/issues/${issue}`);
		const comments = await githubRequest<Array<Record<string, unknown>>>(
			`/repos/${repo.owner}/${repo.name}/issues/${issue}/comments?per_page=20`,
		);
		return JSON.stringify({
			repo: repo.full,
			number: item.number,
			title: item.title,
			state: item.state,
			author: login(item.user),
			labels: Array.isArray(item.labels) ? item.labels.map((label) => labelName(label)).filter(Boolean) : [],
			body: item.body,
			comments: comments.map((comment) => ({
				author: login(comment.user),
				body: comment.body,
				createdAt: comment.created_at,
			})),
		});
	},
});

const githubIssueSearch = defineTool<{ query: string }>({
	name: "github_issue_search",
	description: "Search existing issues in the configured GitHub repository for duplicate candidates.",
	input: Type.Object({
		query: Type.String({ minLength: 1 }),
	}),
	run: async ({ query }) => {
		const q = new URLSearchParams({
			q: `repo:${repo.full} is:issue ${query}`,
			per_page: "10",
		});
		const result = await githubRequest<{ items?: Array<Record<string, unknown>> }>(`/search/issues?${q}`);
		return JSON.stringify({
			repo: repo.full,
			items: (result.items ?? []).map((item) => ({
				number: item.number,
				title: item.title,
				state: item.state,
				url: item.html_url,
				labels: Array.isArray(item.labels) ? item.labels.map((label) => labelName(label)).filter(Boolean) : [],
			})),
		});
	},
});

const githubIssueComment = defineTool<{ issue: number; body: string }>({
	name: "github_issue_comment",
	description: "Post a comment to the configured GitHub issue with the final diagnosis or test result.",
	input: Type.Object({
		issue: Type.Number({ minimum: 1 }),
		body: Type.String({ minLength: 1 }),
	}),
	run: async ({ issue, body }) => {
		const result = await githubRequest<Record<string, unknown>>(
			`/repos/${repo.owner}/${repo.name}/issues/${issue}/comments`,
			{
				method: "POST",
				body: { body },
				tokenRequired: true,
			},
		);
		return JSON.stringify({
			repo: repo.full,
			issue,
			commentUrl: result.html_url,
		});
	},
});

const githubIssueCloseDuplicate = defineTool<{ issue: number; duplicateOf: number; body?: string }>({
	name: "github_issue_close_duplicate",
	description: "Comment on the configured GitHub issue and close it as a duplicate.",
	input: Type.Object({
		issue: Type.Number({ minimum: 1 }),
		duplicateOf: Type.Number({ minimum: 1 }),
		body: Type.Optional(Type.String({ minLength: 1 })),
	}),
	run: async ({ issue, duplicateOf, body }) => {
		const comment = body || `Duplicate of #${duplicateOf}.`;
		const posted = await githubRequest<Record<string, unknown>>(
			`/repos/${repo.owner}/${repo.name}/issues/${issue}/comments`,
			{
				method: "POST",
				body: { body: comment },
				tokenRequired: true,
			},
		);
		const closed = await githubRequest<Record<string, unknown>>(`/repos/${repo.owner}/${repo.name}/issues/${issue}`, {
			method: "PATCH",
			body: { state: "closed", state_reason: "not_planned" },
			tokenRequired: true,
		});
		return JSON.stringify({
			repo: repo.full,
			issue,
			duplicateOf,
			state: closed.state,
			commentUrl: posted.html_url,
		});
	},
});

const app = createHeypi({
	state: { root: "./state" },
	http: {
		host: "127.0.0.1",
		port: Number(process.env.HEYPI_WEBHOOK_PORT ?? 3000),
	},
	scope: "channel",
	adapters: [
		webhook({
			name: "github",
			secret: required("HEYPI_WEBHOOK_SECRET"),
		}),
	],
	agent: loadAgent("./agent", {
		model: "openai/gpt-5-mini",
		tools: [
			...defaultTools({
				bash: true,
				write: false,
				edit: false,
				attach: false,
			}),
			githubIssueGet,
			githubIssueSearch,
			githubIssueComment,
			githubIssueCloseDuplicate,
		],
	}),
	runtime: {
		root: workspace("./workspace"),
		scope: "channel",
		provider: dockerRuntime({
			image: "node:22-bookworm",
			network: "bridge",
			env: {
				NPM_CONFIG_CACHE: "/cache/npm",
				npm_config_store_dir: "/cache/pnpm",
			},
			extraRunArgs: [
				"-v",
				`${resolve("./workspace/cache/npm")}:/cache/npm:rw`,
				"-v",
				`${resolve("./workspace/cache/pnpm")}:/cache/pnpm:rw`,
			],
			idleMs: 10 * 60 * 1000,
		}),
	},
});

await runHeypi(app);

function parseRepo(input: string): { owner: string; name: string; full: string } {
	const [owner, name] = input.split("/");
	if (!owner || !name || input.split("/").length !== 2) throw new Error("HEYPI_GITHUB_REPO must be owner/repo");
	return { owner, name, full: `${owner}/${name}` };
}

async function githubRequest<T>(
	path: string,
	options: {
		method?: "GET" | "POST" | "PATCH";
		body?: unknown;
		tokenRequired?: boolean;
	} = {},
): Promise<T> {
	const token = optional("GITHUB_TOKEN");
	if (options.tokenRequired && !token) throw new Error("GITHUB_TOKEN is required for GitHub write actions");
	const response = await fetch(`https://api.github.com${path}`, {
		method: options.method ?? "GET",
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "heypi-webhook-github-docker",
			...(options.body ? { "content-type": "application/json" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
	return (await response.json()) as T;
}

function login(input: unknown): string | undefined {
	return input && typeof input === "object" && "login" in input ? String(input.login) : undefined;
}

function labelName(input: unknown): string | undefined {
	return input && typeof input === "object" && "name" in input ? String(input.name) : undefined;
}
