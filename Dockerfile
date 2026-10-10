FROM node:22-alpine
WORKDIR /app
COPY index.html sw.js manifest.webmanifest LICENSE ./
COPY css ./css
COPY js ./js
COPY vendor ./vendor
COPY icons ./icons
COPY server ./server
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server/server.js"]
