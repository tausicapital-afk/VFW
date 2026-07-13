# syntax=docker/dockerfile:1

# VFW API — NestJS + Prisma.
#
# Single stage on purpose: the Prisma CLI (a devDependency) is needed at boot to
# run `migrate deploy`, so a slimmed runtime that dropped devDeps couldn't apply
# migrations. We keep the full install instead.
FROM node:20-slim

# Prisma's query engine needs OpenSSL present at generate- and run-time.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so the layer caches across source-only changes.
# --include=dev keeps the Nest CLI, TypeScript and Prisma CLI available even if
# Railway sets NODE_ENV=production during the build.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Generate the Prisma client against the schema before compiling.
COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# `release` = `prisma migrate deploy && node dist/main.js`: migrations apply on
# every boot, then the server starts. Railway injects PORT and DATABASE_URL.
CMD ["npm", "run", "release"]
