# Netcode Lab: game server + infra (regions, beacons, matchmaker, duel relay, /metrics) and the built client.
# Context: games/netcode-lab (see deploy/docker-compose.yml).
FROM golang:1.26-alpine AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN mkdir -p /out/public && \
    GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o /out/public/sim.wasm ./wasm && \
    GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o /out/public/duel.wasm ./wasm/duel && \
    cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/public/ && \
    CGO_ENABLED=0 go build -o /out/server ./cmd/server && \
    CGO_ENABLED=0 go build -o /out/infra ./cmd/infra

FROM node:24-alpine AS web
WORKDIR /src
COPY docs ./docs
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci --no-audit --no-fund
COPY client ./client
COPY --from=go /out/public/ ./client/public/
RUN cd client && npm run build && npx vite build --config vite.duel.config.ts && \
    cp public/duel.wasm public/wasm_exec.js ../bin/duel-www/ && \
    mkdir -p ../bin/duel-www/duel && cp public/duel/* ../bin/duel-www/duel/

FROM alpine:3.22
WORKDIR /app
COPY --from=go /out/server /out/infra ./bin/
COPY --from=web /src/client/dist ./client/dist
COPY --from=web /src/bin/duel-www ./bin/duel-www
EXPOSE 8080 8443/tcp 8443/udp 8091 8454/tcp 8454/udp
