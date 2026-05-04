FROM node:20-alpine

RUN apk add --no-cache wireguard-tools iproute2

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 4000 51820/udp

CMD ["node", "index.js"]
