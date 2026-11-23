#!/bin/sh
# make dev: Go server in the background, Vite in the foreground.
"$1" -http "$2" -https "$3" &
SERVER=$!
trap 'kill $SERVER' EXIT INT TERM
echo "page (Vite): http://localhost:5173   game server: http://$2"
cd client && npm run dev
