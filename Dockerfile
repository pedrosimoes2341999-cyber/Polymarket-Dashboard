FROM node:22-slim

WORKDIR /app

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]
