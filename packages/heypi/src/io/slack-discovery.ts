export type SlackChannel = {
	id: string;
	name: string;
	private: boolean;
};

export type SlackUser = {
	id: string;
	name: string;
	realName?: string;
	bot: boolean;
};

type SlackApiResponse<T> = { ok?: boolean; error?: string } & T;

type SlackConversation = {
	id?: string;
	name?: string;
	is_private?: boolean;
	is_archived?: boolean;
};

type SlackConversationsListResponse = {
	channels?: SlackConversation[];
	response_metadata?: { next_cursor?: string };
};

type SlackMember = {
	id?: string;
	name?: string;
	real_name?: string;
	deleted?: boolean;
	is_bot?: boolean;
};

type SlackUsersListResponse = {
	members?: SlackMember[];
	response_metadata?: { next_cursor?: string };
};

/** Lists Slack channels visible to the bot token. */
export async function slackChannels(token: string, input?: { includePrivate?: boolean }): Promise<SlackChannel[]> {
	const channels: SlackChannel[] = [];
	let cursor: string | undefined;
	do {
		const page = await slackCall<SlackConversationsListResponse>(token, "conversations.list", {
			cursor,
			exclude_archived: true,
			limit: 200,
			types: input?.includePrivate ? "public_channel,private_channel" : "public_channel",
		});
		for (const channel of page.channels ?? []) {
			if (!channel.id || !channel.name || channel.is_archived) continue;
			channels.push({ id: channel.id, name: channel.name, private: channel.is_private === true });
		}
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return channels.sort((a, b) => a.name.localeCompare(b.name));
}

/** Lists Slack users visible to the bot token. */
export async function slackUsers(token: string, input?: { includeBots?: boolean }): Promise<SlackUser[]> {
	const users: SlackUser[] = [];
	let cursor: string | undefined;
	do {
		const page = await slackCall<SlackUsersListResponse>(token, "users.list", {
			cursor,
			limit: 200,
		});
		for (const member of page.members ?? []) {
			if (!member.id || !member.name || member.deleted) continue;
			const bot = member.is_bot === true;
			if (bot && !input?.includeBots) continue;
			users.push({ id: member.id, name: member.name, realName: member.real_name, bot });
		}
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return users.sort((a, b) => (a.realName ?? a.name).localeCompare(b.realName ?? b.name));
}

async function slackCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
	const response = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const parsed = (await response.json()) as SlackApiResponse<T>;
	if (!response.ok || !parsed.ok) throw new Error(parsed.error ?? `Slack API failed: ${response.status}`);
	return parsed;
}
