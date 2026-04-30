# Officiële Puppeteer image — Chrome al voor-geïnstalleerd
FROM ghcr.io/puppeteer/puppeteer:23.11.1

USER root
WORKDIR /app

# Tell Puppeteer to use the pre-installed Chrome
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Build deps voor Sharp (image processing) en better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Dependencies eerst (cache layer)
COPY package*.json ./
RUN npm install --omit=dev

# Source code
COPY . .

# Persistent data dirs
RUN mkdir -p /data /data/screenshots && chown -R pptruser:pptruser /data /app

USER pptruser

ENV DB_PATH=/data/leads.db
ENV SCREENSHOT_DIR=/data/screenshots
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
