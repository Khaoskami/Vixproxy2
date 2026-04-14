FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++ gcc
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:20-alpine
RUN apk add --no-cache tini
WORKDIR /app
RUN addgroup -S vixproxy && adduser -S vixproxy -G vixproxy
COPY --from=builder /app /app
RUN mkdir -p /app/data && chown -R vixproxy:vixproxy /app/data
USER vixproxy
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/vixproxy.db
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
