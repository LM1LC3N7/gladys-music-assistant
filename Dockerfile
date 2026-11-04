# -----------------------------------------------------------------------------
# Integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
# -----------------------------------------------------------------------------

FROM node:24-alpine

# dumb-init: handles signals (SIGTERM) correctly for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./

# The only writable location allowed at runtime. Docker creates a new volume
# with the owner of the image's /data, so it must belong to `node`, and before
# VOLUME: changes made to /data after it are discarded. Without this, /data is
# root-owned and the integration cannot write to it.
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

# The manifest as an image label (`io.gladysassistant.manifest`), so that the
# Gladys developer mode can install the image by its name alone. Passed by the
# build workflow (`--build-arg GLADYS_MANIFEST="$(jq -c . gladys-assistant-integration.json)"`);
# empty otherwise, and Gladys then asks for the manifest.
ARG GLADYS_MANIFEST=""
LABEL io.gladysassistant.manifest=$GLADYS_MANIFEST
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/LM1LC3N7/gladys-music-assistant"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
