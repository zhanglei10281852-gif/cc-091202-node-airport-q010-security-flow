FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY fixtures ./fixtures

ENV NODE_ENV=production
ENV STATE_FILE=/data/state.json
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "src/server.js"]
