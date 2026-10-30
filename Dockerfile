# Playwright image ships the exact Chromium that playwright-core 1.63.0 expects.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DB_PATH=/data/docforge.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
