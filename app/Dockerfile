FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
# run as the unprivileged "node" user, not root
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
