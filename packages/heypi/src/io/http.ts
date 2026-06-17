import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../core/log.js";
import type { HttpRegistrar, HttpRoute } from "./handler.js";

export type HttpListen = {
	host?: string;
	port?: number | string;
};

type RegisteredHttpRoute = HttpRoute & HttpListen;

type RegisteredHttpRouteInfo = {
	method: string;
	path: string;
	host: string;
	port: number | string;
	reserved: boolean;
};

export type HttpServerRegistry = HttpRegistrar & {
	listen(): Promise<void>;
	close(): Promise<void>;
	routes(): RegisteredHttpRouteInfo[];
	address(): { host: string; port: number | string } | undefined;
};

type Route = Required<Pick<HttpRoute, "method" | "path">> & {
	handler: HttpRoute["handler"];
	host: string;
	port: number | string;
	reserved: boolean;
	pathShape: string;
};

const RESERVED_PREFIXES = ["/admin"] as const;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export function createHttpServerRegistry(input: { logger: Logger; listen?: HttpListen }): HttpServerRegistry {
	const defaults = normalizeListen(input.listen);
	const routes = new Map<string, Route>();
	let listen: { host: string; port: number | string } | undefined;
	let address: { host: string; port: number | string } | undefined;
	let server: Server | undefined;

	return {
		register(route: RegisteredHttpRoute): void {
			const method = normalizeMethod(route.method);
			const path = normalizePath(route.path);
			const key = `${method} ${path}`;
			if (routes.has(key)) throw new Error(`duplicate HTTP route: ${key}`);
			if (!route.reserved && reserved(path)) throw new Error(`HTTP route uses reserved path: ${path}`);
			const host = route.host ?? defaults.host;
			const port = route.port ?? defaults.port;
			if (listen && (listen.host !== host || String(listen.port) !== String(port))) {
				throw new Error(
					`all HTTP adapters in one heypi app must share one host/port; got ${host}:${port}, expected ${listen.host}:${listen.port}`,
				);
			}
			const pathShape = routePathShape(path);
			for (const [existingKey, existing] of routes) {
				if (methodCollides(method, existing.method) && pathShape === existing.pathShape) {
					throw new Error(`conflicting HTTP route: ${key} conflicts with ${existingKey}`);
				}
			}
			listen ??= { host, port };
			routes.set(key, {
				method,
				path,
				handler: route.handler,
				host,
				port,
				reserved: route.reserved === true,
				pathShape,
			});
			input.logger.debug("http.route", { method, path, host, port });
		},
		async listen(): Promise<void> {
			if (!listen || server) return;
			const target = listen;
			const port = typeof target.port === "number" ? target.port : Number(target.port);
			if (!Number.isFinite(port)) throw new Error(`HTTP port must be numeric: ${target.port}`);
			server = createServer((req, res) => void dispatch(routes, req, res));
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					server = undefined;
					address = undefined;
					reject(error);
				};
				server?.once("error", onError);
				server?.listen(port, target.host, () => {
					server?.off("error", onError);
					const bound = server?.address();
					address = {
						host: target.host,
						port: bound && typeof bound !== "string" ? (bound as AddressInfo).port : target.port,
					};
					input.logger.info("http.start", { host: address.host, port: address.port, routes: routes.size });
					resolve();
				});
			});
		},
		async close(): Promise<void> {
			const current = server;
			const wasListening = current?.listening === true;
			server = undefined;
			address = undefined;
			await new Promise<void>((resolve, reject) => {
				if (!current) return resolve();
				current.close((error) => {
					if (error && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING") return resolve();
					return error ? reject(error) : resolve();
				});
			});
			if (wasListening) input.logger.info("http.stop", { routes: routes.size });
			routes.clear();
			listen = undefined;
		},
		routes(): RegisteredHttpRouteInfo[] {
			return [...routes.values()].map((route) => ({
				method: route.method,
				path: route.path,
				host: route.host,
				port: route.port,
				reserved: route.reserved,
			}));
		},
		address(): { host: string; port: number | string } | undefined {
			return address;
		},
	};
}

async function dispatch(routes: Map<string, Route>, req: IncomingMessage, res: ServerResponse): Promise<void> {
	let matched: Route | undefined;
	try {
		const method = normalizeMethod(req.method);
		const path = normalizePath(new URL(req.url ?? "/", "http://localhost").pathname);
		const route = routes.get(`${method} ${path}`) ?? routes.get(`* ${path}`);
		matched =
			route ??
			[...routes.values()].find((candidate) => {
				if (candidate.method !== method && candidate.method !== "*") return false;
				return pathMatches(candidate.path, path);
			});
	} catch {
		if (!res.headersSent) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "bad request" }));
		} else if (!res.writableEnded) {
			res.end();
		}
		return;
	}
	if (!matched) {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "not found" }));
		return;
	}
	try {
		await matched.handler(req, res);
	} catch {
		if (!res.headersSent) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "http route failed" }));
		} else if (!res.writableEnded) {
			res.end();
		}
	}
}

function pathMatches(template: string, path: string): boolean {
	if (template === path) return true;
	const templateParts = template.split("/").filter(Boolean);
	const pathParts = path.split("/").filter(Boolean);
	if (templateParts.at(-1) === "*") {
		const fixedParts = templateParts.slice(0, -1);
		if (pathParts.length < fixedParts.length) return false;
		return fixedParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
	}
	if (templateParts.length !== pathParts.length) return false;
	for (let i = 0; i < templateParts.length; i++) {
		const part = templateParts[i];
		if (part.startsWith(":")) continue;
		if (part !== pathParts[i]) return false;
	}
	return true;
}

function normalizeMethod(method: string | undefined): string {
	return (method ?? "*").trim().toUpperCase();
}

function normalizePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) return "/";
	if (/[\u0000-\u001f\u007f]/u.test(trimmed)) throw new Error(`HTTP path contains control characters: ${path}`);
	if (/[?#]/u.test(trimmed)) throw new Error(`HTTP path must not contain query or fragment: ${path}`);
	if (/%2f|%5c/i.test(trimmed)) throw new Error(`HTTP path must not contain encoded slash: ${path}`);
	const normalized = `/${trimmed.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "")}`;
	const parts = normalized.split("/").filter(Boolean);
	if (parts.some((part) => part === "." || part === ".."))
		throw new Error(`HTTP path must not contain dot segments: ${path}`);
	return normalized;
}

function routePathShape(path: string): string {
	const parts = path
		.split("/")
		.filter(Boolean)
		.map((part) => (part.startsWith(":") ? ":" : part.toLowerCase()));
	return `/${parts.join("/")}`;
}

function methodCollides(a: string, b: string): boolean {
	return a === "*" || b === "*" || a === b;
}

function reserved(path: string): boolean {
	const lower = path.toLowerCase();
	return RESERVED_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

function normalizeListen(input: HttpListen | undefined): Required<HttpListen> {
	return {
		host: input?.host ?? DEFAULT_HOST,
		port: input?.port ?? DEFAULT_PORT,
	};
}
