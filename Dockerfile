# Gebruik de officiële Puppeteer image — Chrome al voor-geïnstalleerd
# Kleiner en betrouwbaarder dan handmatig dependencies installeren
FROM ghcr.io/puppeteer/puppeteer:23.11.1

USER root
WORKDIR /app

# Tell Puppeteer to use the pre-installed Chrome
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Dependencies eerst (cache layer)
COPY package*.json ./
RUN npm install --omit=dev

# Source code
COPY . .

# Persistent data dir (Coolify volume mount)
RUN mkdir -p /data && chown -R pptruser:pptruser /data /app

USER pptruser

ENV DB_PATH=/data/leads.db
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
