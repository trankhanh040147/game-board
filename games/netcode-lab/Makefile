# Netcode Lab. Run from games/netcode-lab.
GOROOT_WASM := $(shell go env GOROOT)/lib/wasm
BIN := bin
PUBLIC := client/public
HTTP ?= 0.0.0.0:8080
HTTPS ?= 0.0.0.0:8443
N ?= 3
D ?= 30s

.PHONY: all wasm server bot client run dev test determinism bots

all: wasm server bot

## wasm: build the shared sim + codec for the browser (client/public/sim.wasm + wasm_exec.js)
wasm:
	mkdir -p $(PUBLIC)
	GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o $(PUBLIC)/sim.wasm ./wasm
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
