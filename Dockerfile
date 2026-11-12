
FROM node:20-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./

# Install all dependencies, including TypeScript
RUN npm ci --ignore-scripts

# Copy source files
COPY src ./src
COPY tsconfig.json ./
COPY index.js ./

# Build the latest TypeScript source
RUN npm run build

# Keep production dependencies only
RUN npm prune --omit=dev --ignore-scripts

USER node

CMD ["node", "index.js"]
