# Ask Sylabus AGH — produkcyjny obraz aplikacji (Node SSR).

FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash
ENV PATH=/root/.bun/bin:$PATH

COPY package.json bun.lock* bunfig.toml ./
RUN bun install --frozen-lockfile || bun install

COPY . .
RUN bun run build

# --- Runtime ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server-node.mjs ./server-node.mjs
COPY --from=builder /app/kierunki.json ./kierunki.json

EXPOSE 8080
CMD ["node", "server-node.mjs"]
