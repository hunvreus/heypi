import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function normalizeHttpUrl(input: string): string {
	const value = input.trim();
	const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs are supported");
	return url.href;
}

export async function assertPublicUrl(input: string): Promise<string> {
	const href = normalizeHttpUrl(input);
	if (!(await publicUrl(href))) throw new Error("Private, localhost, and internal IP targets are blocked by default");
	return href;
}

export async function publicUrl(input: string): Promise<boolean> {
	if (allowPrivateWebTargets()) return true;
	const url = new URL(input);
	if (!["http:", "https:"].includes(url.protocol)) return false;
	const host = cleanHostname(url.hostname);
	if (privateHostname(host)) return false;
	const literal = isIP(host);
	if (literal) return publicIp(host);
	const records = await lookup(host, { all: true, verbatim: true });
	if (!records.length) return false;
	return records.every((record) => publicIp(record.address));
}

function allowPrivateWebTargets(): boolean {
	return process.env.HEYPI_ALLOW_PRIVATE_WEB === "1";
}

function cleanHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function privateHostname(host: string): boolean {
	return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

function publicIp(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return publicIpv4(address);
	if (version === 6) return publicIpv6(address);
	return false;
}

function publicIpv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && (b === 0 || b === 168)) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	if (a >= 224) return false;
	return true;
}

function publicIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized === "::" || normalized === "::1") return false;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
	if (
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	) {
		return false;
	}
	if (normalized.startsWith("ff")) return false;
	return true;
}
