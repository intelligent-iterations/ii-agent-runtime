# Trusted infrastructure tools only. No consumer application or agent credentials.
FROM docker:29.2.1-cli AS docker-tools
FROM node:22.22.0-bookworm-slim
ARG TARGETARCH
ARG TOFU_VERSION=1.12.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip git sudo iptables iproute2 \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) checksum=1f5416ea08f32fdc621f20a2cc0324298e60aba8bbe996459d9e3b44195f23df ;; \
      arm64) checksum=14838b811b54148060da99fd2aabe78f05c777002c0a8fc39b106e0de0ddd796 ;; \
      *) exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/openshell.deb "https://github.com/NVIDIA/OpenShell/releases/download/v0.1.2/openshell_0.1.2-1_${arch}.deb"; \
    echo "$checksum  /tmp/openshell.deb" | sha256sum -c -; \
    dpkg-deb -x /tmp/openshell.deb /tmp/openshell; \
    cp /tmp/openshell/usr/bin/openshell /tmp/openshell/usr/bin/openshell-gateway /usr/local/bin/; \
    rm -rf /tmp/openshell /tmp/openshell.deb
RUN set -eu; arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    curl -fsSLo /tmp/tofu.zip "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${arch}.zip"; \
    curl -fsSLo /tmp/checksums "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_SHA256SUMS"; \
    expected="$(awk -v f="tofu_${TOFU_VERSION}_linux_${arch}.zip" '$2==f {print $1}' /tmp/checksums)"; \
    test -n "$expected"; echo "$expected  /tmp/tofu.zip" | sha256sum -c -; \
    unzip /tmp/tofu.zip -d /usr/local/bin; rm /tmp/tofu.zip /tmp/checksums
COPY --from=docker-tools /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY schemas ./schemas
COPY modules ./modules
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
ENTRYPOINT ["node", "/app/dist/providers/execution/remote/stdio.js"]
CMD ["docker"]
