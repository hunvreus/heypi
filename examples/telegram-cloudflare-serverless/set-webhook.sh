#!/usr/bin/env bash
# Register (or re-register) the Telegram webhook to point at your public Worker URL.
#
# Usage:
#   TELEGRAM_BOT_TOKEN=123:abc TUNNEL_URL=https://xxxx.trycloudflare.com ./set-webhook.sh
#   # optionally also: TELEGRAM_WEBHOOK_SECRET=some-secret
#
# Run with no TUNNEL_URL to just print the current webhook info.
set -euo pipefail

# Load TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET from .dev.vars if present.
if [[ -f .dev.vars ]]; then
	set -a
	# shellcheck disable=SC1091
	. ./.dev.vars
	set +a
fi

: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN (in .dev.vars or env)}"
api="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

if [[ -z "${TUNNEL_URL:-}" ]]; then
	echo "Current webhook:"
	curl -s "${api}/getWebhookInfo"
	echo
	exit 0
fi

echo "Setting webhook -> ${TUNNEL_URL}/telegram"
curl -s "${api}/setWebhook" \
	-d "url=${TUNNEL_URL}/telegram" \
	-d "drop_pending_updates=true" \
	${TELEGRAM_WEBHOOK_SECRET:+-d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"}
echo
