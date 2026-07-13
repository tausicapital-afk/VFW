# syntax=docker/dockerfile:1

# ---- build the static bundle ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Vite inlines VITE_* at build time, so the API URL has to be present HERE, not
# at runtime. Railway exposes service variables to Dockerfile builds as ARGs.
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# ---- serve it ----
FROM node:20-slim AS serve
WORKDIR /app
RUN npm i -g serve@14
COPY --from=build /app/dist ./dist
ENV PORT=4173
# -s = single-page-app fallback, so client-side routes resolve to index.html.
CMD ["sh", "-c", "serve -s dist -l tcp://0.0.0.0:${PORT}"]
