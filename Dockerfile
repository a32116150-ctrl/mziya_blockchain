FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy source
COPY bootstrap-node/ bootstrap-node/

EXPOSE 4001

CMD ["node", "bootstrap-node/index.js"]
