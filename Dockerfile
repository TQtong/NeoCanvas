# syntax=docker/dockerfile:1

FROM node:20-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3100
ARG NEXT_PUBLIC_IMAGE_EDITING_ENABLED=false
ARG SUPABASE_INTERNAL_URL

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_IMAGE_EDITING_ENABLED=${NEXT_PUBLIC_IMAGE_EDITING_ENABLED} \
    SUPABASE_INTERNAL_URL=${SUPABASE_INTERNAL_URL}

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN node -e "for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) { if (!process.env[name]) { throw new Error('Missing build argument: ' + name); } }" \
    && npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3100

CMD ["node", "server.js"]
