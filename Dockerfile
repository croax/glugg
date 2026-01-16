FROM node:23-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server ./server
COPY web ./web
COPY README.md ./README.md

RUN mkdir -p /app/data

EXPOSE 8787
CMD ["node", "server/index.js"]
