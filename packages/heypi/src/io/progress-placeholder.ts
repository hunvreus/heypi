export type DelayedProgressPlaceholder<T> = {
	setText(text: string): T | undefined;
	take(): Promise<T | undefined>;
	clear(): Promise<T | undefined>;
};

export function delayedProgressPlaceholder<T>(input: {
	message: string | false;
	delayMs: number;
	send(text: string): Promise<T>;
	onError(error: unknown): void;
}): DelayedProgressPlaceholder<T> {
	let active = true;
	let placeholder: T | undefined;
	let task: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveTask: (() => void) | undefined;
	let message = input.message;

	const finishTask = () => {
		const resolve = resolveTask;
		resolveTask = undefined;
		task = undefined;
		resolve?.();
	};
	const cancelTimer = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
		finishTask();
	};

	if (message !== false) {
		task = new Promise((resolve) => {
			resolveTask = resolve;
			timer = setTimeout(() => {
				timer = undefined;
				if (!active || message === false) {
					finishTask();
					return;
				}
				void input
					.send(message)
					.then((out) => {
						placeholder = out;
					})
					.catch(input.onError)
					.finally(finishTask);
			}, input.delayMs);
		});
	}

	const take = async (): Promise<T | undefined> => {
		active = false;
		cancelTimer();
		await task;
		const out = placeholder;
		placeholder = undefined;
		return out;
	};

	return {
		setText(text: string): T | undefined {
			if (message === false) return undefined;
			message = text;
			return placeholder;
		},
		async take(): Promise<T | undefined> {
			return await take();
		},
		async clear(): Promise<T | undefined> {
			return await take();
		},
	};
}
