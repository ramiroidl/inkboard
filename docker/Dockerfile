ARG NODE_VERSION=24.22.1

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/controller/package.json apps/controller/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/epaper-image/package.json packages/epaper-image/package.json
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV INKBOARD_DATA_DIR=/data \
    INKBOARD_HOST=0.0.0.0 \
    INKBOARD_PORT=8099 \
    NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core fonts-symbola \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/controller/package.json ./apps/controller/package.json
COPY --from=build /app/apps/controller/dist ./apps/controller/dist
COPY --from=build /app/apps/controller/migrations ./apps/controller/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/epaper-image/package.json ./packages/epaper-image/package.json
COPY --from=build /app/packages/epaper-image/dist ./packages/epaper-image/dist

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8099/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/controller/dist/server.js"]

# Home Assistant App image. The Supervisor mounts /data owned by root, so this target runs
# as root like other Apps; isolation comes from the App container's restricted profile.
FROM runtime AS homeassistant
ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=dev
LABEL io.hass.type="addon" \
      io.hass.name="Inkboard" \
      io.hass.description="Local e-paper dashboards for the Seeed TRMNL 7.5-inch display" \
      io.hass.arch="${BUILD_ARCH}" \
      io.hass.version="${BUILD_VERSION}" \
      org.opencontainers.image.source="https://github.com/ramiroidl/inkboard" \
      org.opencontainers.image.licenses="MIT"
EXPOSE 8100

# Default standalone image; keep last so `docker build` without --target builds it.
FROM runtime AS standalone
USER node
