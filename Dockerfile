FROM node:20-slim

WORKDIR /app

# Install only what's needed for bcrypt's native bindings.
# slim has glibc but no compilers — install temporarily, then prune.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Remove build deps to shrink the final image.
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY . .

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "src/server.js"]
