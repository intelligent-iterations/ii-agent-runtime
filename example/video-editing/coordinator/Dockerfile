FROM docker:28.5.1-cli AS docker-tools
FROM node:22-trixie-slim
ARG TOFU_VERSION=1.12.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip python3 \
 && rm -rf /var/lib/apt/lists/* \
 && arch="$(dpkg --print-architecture)" \
 && curl -fsSLo /tmp/tofu.zip "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${arch}.zip" \
 && curl -fsSLo /tmp/tofu.sums "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_SHA256SUMS" \
 && awk -v name="tofu_${TOFU_VERSION}_linux_${arch}.zip" '$2 == name {print $1 "  /tmp/tofu.zip"}' /tmp/tofu.sums > /tmp/checksum \
 && test -s /tmp/checksum && sha256sum -c /tmp/checksum \
 && unzip /tmp/tofu.zip tofu -d /usr/local/bin && rm /tmp/tofu.zip /tmp/tofu.sums /tmp/checksum
COPY --from=docker-tools /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY runtime.tgz /opt/runtime.tgz
COPY example/ ./
RUN npm install --no-audit --no-fund && npm run build
ENTRYPOINT ["node","/app/dist/src/cli.js"]
