FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
