FROM ghcr.io/puppeteer/puppeteer:23.11.1

USER root
WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data && chown -R pptruser:pptruser /data /app

USER pptruser

ENV DB_PATH=/data/leads.db
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
