# Scriptorium home server. Build from the repo root:
#   docker build -f server/Dockerfile -t scriptorium .
FROM node:22-alpine
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY app ./app
COPY worker/src/ai.js worker/src/meta.js ./worker/src/
COPY server/server.js ./server/server.js
ENV PORT=8787 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server/server.js"]
