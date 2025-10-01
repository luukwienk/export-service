FROM node:20-alpine

WORKDIR /usr/src/app

# Install OpenSSL and other dependencies
RUN apk add --no-cache openssl openssl-dev wget

# Install libssl1.1 which Prisma needs
RUN wget -q -O /etc/apk/keys/sgerrand.rsa.pub https://alpine-pkgs.sgerrand.com/sgerrand.rsa.pub && \
    wget https://github.com/sgerrand/alpine-pkg-glibc/releases/download/2.33-r0/glibc-2.33-r0.apk && \
    apk add --no-cache glibc-2.33-r0.apk && \
    ln -s /lib/libc.musl-x86_64.so.1 /lib/ld-linux-x86-64.so.2

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Generate Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build the application
RUN npm run build

# Expose the port
EXPOSE 3001

# Run the server
CMD ["npm", "start"]
