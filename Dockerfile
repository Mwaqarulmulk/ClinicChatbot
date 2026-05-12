FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Create data directory for persistent storage
RUN mkdir -p .data

# Expose the port from fly.toml
EXPOSE 8080

# Start the app
CMD ["node", "--import", "tsx", "src/index.ts"]