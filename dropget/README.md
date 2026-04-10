# DropGet

Simple peer-to-peer file transfer in the browser using WebRTC.

## Overview

DropGet uses:
- A small WebSocket signaling server to exchange signaling messages.
- A browser WebRTC data channel to transfer files directly between peers.

## Tech Stack

- Backend: Node.js, ws
- Frontend: React, TypeScript, Create React App

## Project Structure

```text
dropget/
├── backend/
│   ├── package.json
│   ├── server.js
│   └── README.md
├── frontend/
│   ├── public/
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
└── README.md
```

## Run Locally

### 1) Start backend

```bash
cd backend
npm install
npm start
```

Default signaling URL: `ws://localhost:3001`

### 2) Start frontend

```bash
cd frontend
npm install
npm start
```

Frontend URL: `http://localhost:3000`

### Frontend Environment Variables

For deployed frontend builds (for example Vercel), configure these variables:

```bash
REACT_APP_API=https://getdrop-3.onrender.com
REACT_APP_WS=wss://getdrop-3.onrender.com
```

You can copy `frontend/.env.example` for local setup.

## Notes

- Files are transferred peer-to-peer after connection setup.
- The signaling server does not store transferred files.
- This project currently uses public sessions and has no authentication.
