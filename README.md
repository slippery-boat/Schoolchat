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
- Auto-update system

## Setup

### Requirements
- Node.js 18+
- npm

### Install
```bash
npm install
```

### Configure
Before running, edit these placeholders:

**In `index.html`:**
- `YOUR_SERVER_LINK_DOC_URL_HERE` → your Google Doc URL with the server link
- `CHANGE_THIS_ENCRYPTION_KEY` → a secret key only your group knows
- `YOUR_ADMIN_PHONE_HERE` → your account phone number (shown after registration)

**In `server.js`:**
- `YOUR_ADMIN_PHONE_HERE` → same admin phone as above

### Run
```bash
bash start_schoolchat.sh
```

## Notes
- All data stored locally in `chat.db` (SQLite)
- Uses Cloudflare Tunnel for external access (free, no port forwarding needed)
- Messages older than 2 days are auto-deleted
