# syntax=docker/dockerfile:1

# ---- build the static bundle ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# With the single-origin proxy the SPA calls its OWN origin at /api, so
# VITE_API_BASE is empty and api.ts uses relative paths (see nginx.conf.template).
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# ---- serve the SPA + reverse-proxy /api ----
FROM nginx:1.27-alpine AS serve
# Template is rendered to /etc/nginx/conf.d/default.conf by the image's envsubst
# entrypoint, which substitutes $PORT and $BACKEND_URL from the environment.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# nginx:alpine's default entrypoint runs envsubst then starts nginx — no CMD needed.
