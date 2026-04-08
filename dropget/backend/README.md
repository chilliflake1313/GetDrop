# DropGet Backend

WebSocket signaling server for DropGet.

## What It Does

- Accepts WebSocket client connections.
- Assigns each client a unique ID.
- Relays signaling messages between peers.
- Sends peer join/leave events.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Default address: `ws://localhost:3001`

## Message Notes

- Incoming messages must be valid JSON.
- If `targetId` is present and valid, the message is sent to that peer.
- Otherwise, the message is broadcast to all other connected peers.

## Error Behavior

- Invalid JSON results in:

```json
{ "type": "error", "message": "Invalid JSON payload" }
```
