FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY app/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY app/src ./src
COPY app/public ./public

# Render provides PORT at runtime; the application reads it from the environment.
EXPOSE 3000
USER node

CMD ["node", "src/server.js"]
