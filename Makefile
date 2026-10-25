.PHONY: build web run dev-api dev-web test lint notices clean docker

BIN ?= bin/fuguruma
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

# Cross-compile for another machine, e.g. `make build GOOS=linux GOARCH=arm64`
build: web
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o $(BIN) ./cmd/fuguruma

web:
	cd web && npm ci && npm run build

run: build
	./$(BIN) -config $${FUGURUMA_CONFIG:-./config.toml}

# Development: run both, then open http://localhost:5173
dev-api:
	go run ./cmd/fuguruma -config $${FUGURUMA_CONFIG:-./config.toml}
dev-web:
	cd web && npm run dev

test:
	go test ./...

lint:
	test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)
	go vet ./...
	cd web && npx tsc -b

# Regenerate THIRD_PARTY_NOTICES.md after changing dependencies (needs `npm ci` in web/).
notices:
	node scripts/gen-notices.mjs

docker:
	docker build -t fuguruma .

clean:
	rm -rf bin dist web/dist/assets web/dist/index.html web/dist/favicon.svg web/dist/pdfjs web/public/pdfjs
