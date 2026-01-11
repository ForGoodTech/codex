FROM node:20-slim

WORKDIR /examples

COPY ext/examples/*.js /examples/
COPY ext/examples/slash-commands /examples/slash-commands

CMD ["node", "/examples/hello-app-server.js"]
