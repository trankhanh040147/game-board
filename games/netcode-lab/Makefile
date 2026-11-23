# Netcode Lab. Run from games/netcode-lab.
GOROOT_WASM := $(shell go env GOROOT)/lib/wasm
BIN := bin
PUBLIC := client/public
HTTP ?= 0.0.0.0:8080
HTTPS ?= 0.0.0.0:8443
N ?= 3
D ?= 30s

.PHONY: all wasm server bot client run dev test determinism bots duel duel-www duel-run duel-determinism

all: wasm server bot

## wasm: build the shared sim + codec for the browser (client/public/sim.wasm + wasm_exec.js)
wasm:
	mkdir -p $(PUBLIC)
	GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o $(PUBLIC)/sim.wasm ./wasm
	GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o $(PUBLIC)/duel.wasm ./wasm/duel
	cp $(GOROOT_WASM)/wasm_exec.js $(PUBLIC)/wasm_exec.js

server:
	go build -o $(BIN)/server ./cmd/server

bot:
	go build -o $(BIN)/bot ./cmd/bot

## client: production build of the browser client into client/dist (needs npm)
client: wasm
	cd client && npm install --no-audit --no-fund && npm run build

## run: serve the built client + game: HTTP :8080 (WebSocket), HTTPS + WebTransport :8443
run: server client
	$(BIN)/server -http $(HTTP) -https $(HTTPS)

## dev: Go server in the background + Vite dev server (proxies /ws and /api to :8080)
dev: wasm server
	sh wasm/test/dev.sh $(BIN)/server $(HTTP) $(HTTPS)

## bots: N walker bots for D against a local server
bots: bot
	$(BIN)/bot -url ws://127.0.0.1:8080/ws -n $(N) -d $(D)

test:
	go test ./...

## determinism: B.9 check 1, native arm64 vs amd64 (Rosetta) vs WASM in Node
determinism: wasm
	go build -o $(BIN)/simtrace ./cmd/simtrace
	GOARCH=amd64 go build -o $(BIN)/simtrace-amd64 ./cmd/simtrace
	sh wasm/test/determinism.sh $(BIN) $(PUBLIC)
	$(MAKE) duel-determinism

## duel: M8 duel mini-mode: relay (WS + WebTransport), headless bot peer, and the duel page
duel: duel-www
	go build -o $(BIN)/duelrelay ./cmd/duelrelay
	go build -o $(BIN)/duelbot ./cmd/duelbot

## duel-www: build the duel page into bin/duel-www (served by bin/duelrelay)
duel-www:
	mkdir -p $(PUBLIC)
	GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o $(PUBLIC)/duel.wasm ./wasm/duel
	cp $(GOROOT_WASM)/wasm_exec.js $(PUBLIC)/wasm_exec.js
	cd client && npx vite build --config vite.duel.config.ts
	cp $(PUBLIC)/duel.wasm $(PUBLIC)/wasm_exec.js $(BIN)/duel-www/
	mkdir -p $(BIN)/duel-www/duel && cp $(PUBLIC)/duel/* $(BIN)/duel-www/duel/

## duel-run: relay on :8090 (page + WebSocket) and :8453 (HTTPS + WebTransport)
duel-run: duel
	$(BIN)/duelrelay

## duel-determinism: B.9 check 1 for the duel sim and its rollback/lockstep sessions
duel-determinism:
	mkdir -p $(PUBLIC)
	GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o $(PUBLIC)/duel.wasm ./wasm/duel
	cp $(GOROOT_WASM)/wasm_exec.js $(PUBLIC)/wasm_exec.js
	go build -o $(BIN)/dueltrace ./cmd/dueltrace
	GOARCH=amd64 go build -o $(BIN)/dueltrace-amd64 ./cmd/dueltrace
	sh wasm/duel/test/determinism.sh $(BIN) $(PUBLIC)
