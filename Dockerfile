# Node 22.14 is the Node this repo is tested with. package.json does not
# pin a version. The export pipeline is Node, not bun.
FROM node:22.14.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# The published packages already include their wasm. Skipping scripts
# avoids rebuilding laz-perf, which needs a toolchain this image does not have.
RUN npm ci --omit=dev --ignore-scripts

COPY netlify ./netlify
COPY public ./public
COPY fly ./fly

ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "fly/server.js"]
