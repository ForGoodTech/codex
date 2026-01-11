FROM node:20-slim

WORKDIR /examples

COPY --chown=node:node ext/examples/*.js /examples/
COPY --chown=node:node ext/examples/slash-commands /examples/slash-commands
RUN chown -R node:node /examples

USER node

CMD ["node", "/examples/hello-app-server.js"]
