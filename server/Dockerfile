# The exact Bun that CI tests. .dockerignore keeps kek.secret and data out of the image.
FROM oven/bun:1.2.21
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown bun:bun /data
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
# The server runs as the unprivileged user of the image, not as root.
USER bun
ENV HMN_DATA_DIR=/data
ENV HMN_HOST=0.0.0.0
ENV HMN_PORT=8787
EXPOSE 8787
VOLUME ["/data"]
CMD ["bun", "src/index.ts"]
