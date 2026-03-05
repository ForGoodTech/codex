FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  curl \
  git \
  less \
  procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /examples

COPY --chown=node:node ext/examples/*.js /examples/
COPY --chown=node:node ext/examples/slash-commands /examples/slash-commands
RUN chown -R node:node /examples

USER node

CMD ["node", "/examples/hello-app-server.js"]
