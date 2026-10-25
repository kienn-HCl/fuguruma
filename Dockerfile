# ---- frontend ----
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- backend (frontend embedded) ----
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /fuguruma ./cmd/fuguruma

# ---- runtime ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /fuguruma /fuguruma
# Paths inside the container are fixed via env; everything else lives in
# /config/config.toml (created on first start, editable from the web UI).
ENV FUGURUMA_BOOKS_DIR=/books \
    FUGURUMA_DATA_DIR=/data \
    FUGURUMA_ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["/fuguruma", "-config", "/config/config.toml"]
