FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p .data

EXPOSE 3000
CMD ["node", "--import", "tsx", "src/index.ts"]
