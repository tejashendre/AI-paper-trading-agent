#!/bin/bash
# Description: Starts cloudflared quick tunnel and sends URL via Telegram

LOG_FILE="/home/ubuntu/cloudflare-quick.log"

# Remove old log
rm -f "$LOG_FILE"

echo "Starting cloudflared quick tunnel..."
# Start cloudflared in the background
/usr/local/bin/cloudflared tunnel --url http://localhost:3000 > "$LOG_FILE" 2>&1 &
CLOUDFLARED_PID=$!

# Wait for tunnel to establish and log the URL
echo "Waiting for tunnel URL to be generated..."
sleep 10

# Extract URL from log
TUNNEL_URL=$(grep -oE "https://[a-zA-Z0-9.-]+\.trycloudflare\.com" "$LOG_FILE" | head -n 1)

if [ -n "$TUNNEL_URL" ]; then
    echo "Found Tunnel URL: $TUNNEL_URL"
    
    # Source .env file to get Telegram bot details
    ENV_FILE="/home/ubuntu/version-6/.env"
    if [ -f "$ENV_FILE" ]; then
        # Export env variables ignoring comments
        export $(grep -v '^#' "$ENV_FILE" | xargs)
    fi
    
    if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
        MSG="🚀 *Trading Bot Dashboard Online*\n\nSecure URL:\n$TUNNEL_URL\n\n_Bypasses corporate Wi-Fi blocks_"
        
        # Use python3 to post JSON securely to Telegram API
        python3 -c "
import urllib.request, json, os
url = f'https://api.telegram.org/bot{os.environ[\"TELEGRAM_BOT_TOKEN\"]}/sendMessage'
data = json.dumps({
    'chat_id': os.environ[\"TELEGRAM_CHAT_ID\"],
    'text': \"$MSG\",
    'parse_mode': 'Markdown'
}).encode('utf-8')
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
try:
    urllib.request.urlopen(req)
    print('Telegram notification sent successfully.')
except Exception as e:
    print('Failed to send Telegram notification:', e)
"
    else
        echo "Telegram credentials missing in $ENV_FILE"
    fi
else
    echo "Error: Could not retrieve dynamic trycloudflare.com URL."
fi

# Wait for the background cloudflared process to keep the script running
wait $CLOUDFLARED_PID
