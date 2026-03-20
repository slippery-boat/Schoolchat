# SchoolChat

A private, self-hosted real-time chat app with end-to-end encryption.

## Features
- Real-time messaging (DMs + group chats)
- End-to-end encryption (AES-GCM 256-bit)
- Discord-style channels in groups
- Voice calls (WebRTC)
- Image sending
- Reply to messages
- Reactions
- Profiles with avatar, bio, status, mood
- Tab disguise modes
- Auto-update system (does not work on any school laptops) 

---

## Setup

### Requirements
- Node.js 18+
- npm
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for tunneling

### Install dependencies
```bash
npm install
```

### Configure
Before running, edit these placeholders:

**In `index.html`:**
- `YOUR_SERVER_LINK_DOC_URL_HERE` → your Google Doc URL where you post the server link
- `CHANGE_THIS_ENCRYPTION_KEY` → a secret key only your group knows (make it long and random)
- `YOUR_ADMIN_PHONE_HERE` → your account phone number (shown after first registration)

**In `server.js`:**
- `YOUR_ADMIN_PHONE_HERE` → same admin phone as above

---

## Installing Cloudflare Tunnel

Cloudflare Tunnel lets you expose your local server to the internet without port forwarding — completely free.

**Linux:**
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/
```

**Verify:**
```bash
cloudflared --version
```

---

## Starting the Server

Create a file called `start.sh` in your project folder:

```bash
#!/bin/bash
echo "Starting SchoolChat..."
cd "$(dirname "$0")"

fuser -k 3000/tcp 2>/dev/null
sleep 1

node server.js &
NODE_PID=$!
sleep 1

cloudflared tunnel --url http://localhost:3000 > cloudflared.log 2>&1 &
CF_PID=$!

echo "Waiting for tunnel URL..."
for i in $(seq 1 30); do
  sleep 1
  URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' cloudflared.log 2>/dev/null | head -1)
  if [ -n "$URL" ]; then
    echo ""
    echo "SchoolChat is live at: $URL"
    echo "Use the wss:// version in your server link doc"
    break
  fi
done

wait $NODE_PID
kill $CF_PID 2>/dev/null
echo "Server stopped."
```

Make it executable and run:
```bash
chmod +x start.sh
bash start.sh
```

---

## Auto Message Cleanup (Cron Job)

Messages older than 2 days are automatically deleted. Create `cleanup.js`:

```javascript
const Database = require('better-sqlite3');
const db = new Database('./chat.db');
const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
const result = db.prepare('DELETE FROM messages WHERE ts < ? AND deleted = 0').run(twoDaysAgo);
console.log(`Cleaned up ${result.changes} old messages at ${new Date().toISOString()}`);
db.close();
```

Then set up a cron job to run it every day at 3am:
```bash
crontab -e
```

Add this line (replace the path with your actual project path):
```
0 3 * * * node /path/to/schoolchat/cleanup.js >> /path/to/schoolchat/cleanup.log 2>&1
```

Find your path with:
```bash
pwd
```

---

## Notes
- All data stored locally in `chat.db` (SQLite) — never uploaded anywhere
- Sessions reset on server restart
- Cloudflare tunnel URL changes every restart — post the new one in your server link doc
- For a permanent URL, set up a [named Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/)
