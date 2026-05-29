import type { Outbound } from "./handler.js";
import type { ReplyStream } from "./reply-stream.js";

export type OutputPlacement = "fresh" | "streamed" | "progress";

export type PlacementHandlers<T> = {
	fresh(): Promise<T> | T;
	streamed(): Promise<T> | T;
	progress(): Promise<T> | T;
};

export function outputPlacement(
	out: Pick<Outbound, "approval" | "finalPlacement">,
	stream?: ReplyStream,
): OutputPlacement {
	if (out.finalPlacement === "thread") return "fresh";
	if (stream?.complete?.() && !out.approval) return "streamed";
	return "progress";
}

export async function dispatchPlacement<T>(
	out: Pick<Outbound, "approval" | "finalPlacement">,
	stream: ReplyStream | undefined,
	handlers: PlacementHandlers<T>,
): Promise<T> {
	const placement = outputPlacement(out, stream);
	if (placement === "fresh") return await handlers.fresh();
	if (placement === "streamed") return await handlers.streamed();
	return await handlers.progress();
}
