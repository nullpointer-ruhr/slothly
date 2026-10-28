# Slothly: API + Oberfläche in einem Image, ohne Build-Schritt (Node führt TypeScript direkt aus).
# Bauen:  docker build -t slothly .
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
COPY web web
COPY seed seed
USER 65532:65532
EXPOSE 8080
CMD ["node", "src/main.ts"]
