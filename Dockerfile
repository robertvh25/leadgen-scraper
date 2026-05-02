FROM ghcr.io/puppeteer/puppeteer:23.11.1

# Belangrijke change: blijf root tot we de entrypoint hebben gedaan
USER root
WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true

# Build deps voor sharp + bcrypt + better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Copy entrypoint en maak executable
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Maak /data klaar (entrypoint fixt later eigenaar bij elke start)
RUN mkdir -p /data /data/screenshots

ENV DB_PATH=/data/leads.db
ENV SCREENSHOT_DIR=/data/screenshots
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Container start als root → entrypoint fixt /data permissies → dropt naar pptruser
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
