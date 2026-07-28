FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    SOURCE_ROOTS=/home/node/app/public-sources

WORKDIR /home/node/app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
RUN mkdir -p public-sources && chown node:node public-sources

USER node

EXPOSE 7860

CMD ["node", "src/cli.js", "--http"]
