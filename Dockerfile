FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Create exports directory for temporary ZIP files
RUN mkdir -p exports && chown -R node:node exports
USER node

EXPOSE 3000
CMD ["node", "dist/server/index.js"]
