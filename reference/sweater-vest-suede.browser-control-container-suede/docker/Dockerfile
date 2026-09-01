FROM node:22-bookworm-slim

ARG BROWSER=chrome
ENV BROWSER=$BROWSER

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

ENV PATH="/app/node_modules/.bin:$PATH"

RUN npx playwright install --with-deps "$BROWSER"
RUN playwright-cli install-browser "$BROWSER"

# What trust.mjs needs to add a certificate to the stores the browsers read:
# ca-certificates for the system store, libnss3-tools for Chromium's database,
# and p11-kit-modules for the roots module roots.mjs gives Firefox.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates libnss3-tools p11-kit-modules \
    && rm -rf /var/lib/apt/lists/*

COPY forward.mjs /forward.mjs
COPY roots.mjs /roots.mjs
COPY trust.mjs /trust.mjs

# Decided once, at build time, so the container resolves roots the same way
# whether or not a certificate is ever added. A no-op without Firefox.
RUN node /roots.mjs

# The same command `defaults.command` runs: it idles so the container stays up
# to be exec'd into, and serves whatever `FORWARD` asks for. `bash` here would
# exit immediately under `docker run -d`, taking the container with it.
CMD ["node", "/forward.mjs"]
