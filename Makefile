.PHONY: build web run dev-api dev-web clean docker

BIN ?= bin/fuguruma

build: web
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BIN) ./cmd/fuguruma

web:
	cd web && npm ci && npm run build

# Cross-compile for another machine, e.g. `make build GOOS=linux GOARCH=arm64`
run: build
	./$(BIN) -config $${FUGURUMA_CONFIG:-./config.toml}

# Development: run both, then open http://localhost:5173
dev-api:
	go run ./cmd/fuguruma -config $${FUGURUMA_CONFIG:-./config.toml}
dev-web:
	cd web && npm run dev

docker:
	docker build -t fuguruma .

clean:
	rm -rf bin web/dist/assets web/public/pdfjs
