#!/bin/bash
# docker-entrypoint.sh
# Draait als root: fix /data permissies, drop dan naar pptruser (UID 1000)
set -e

echo "🔧 Entrypoint gestart als $(whoami)"

# Maak /data en subdirs als ze nog niet bestaan
mkdir -p /data /data/screenshots

# Fix eigenaar - belangrijkste regel
# pptruser heeft UID 1000 in de puppeteer base image
chown -R 1000:1000 /data
chmod 755 /data
chmod 755 /data/screenshots

echo "✓ /data permissies gefixt voor UID 1000 (pptruser)"
ls -la /data

# Ensure /home/pptruser bestaat met juiste owner — nieuwere puppeteer base image
# gebruikt user 'node' (UID 1000) met /home/node als home, maar oude code verwacht
# /home/pptruser. Chrome heeft een schrijfbare HOME nodig voor crashpad/cache.
mkdir -p /home/pptruser/.cache /home/pptruser/.config
chown -R 1000:1000 /home/pptruser

# Drop naar UID 1000 en start de app
# setpriv zit standaard in Ubuntu (puppeteer base image is Ubuntu-based)
cd /app
exec setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/pptruser PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$@"
