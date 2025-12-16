# Dockerfile - runs your Node app inside the official Puppeteer image
FROM ghcr.io/puppeteer/puppeteer:19.7.2

# Create app dir
WORKDIR /usr/src/app

# Avoid puppeteer attempting to download chrome at npm install time
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy package files first for better caching
COPY package*.json ./

# Install production deps (use npm ci for reproducible installs)
RUN npm ci --production

# Copy app source
COPY . .

# Ensure node uses production mode unless overridden
ENV NODE_ENV=production

# Expose port your app binds to (adjust if different)
EXPOSE 9000

# Default start command
CMD ["node", "server.js"]
