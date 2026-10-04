FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json index.js runner.mjs ./
RUN mkdir -p /app/data
ENV NODE_ENV=production BOT_STATE_FILE=/app/data/state.json
CMD ["node", "index.js"]
