FROM node:24-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
CMD ["npm", "run", "start"]
