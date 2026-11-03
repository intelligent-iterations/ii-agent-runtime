FROM node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7 AS node
FROM ubuntu@sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d
COPY --from=node /usr/local/ /usr/local/
RUN apt-get update && apt-get install --yes --no-install-recommends python3 util-linux apparmor ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --no-audit --no-fund @openai/codex@0.164.0 \
    && test "$(codex --version)" = 'codex-cli 0.164.0' \
    && python3 --version && command -v runuser
COPY codex-executor.py codex-executor-fixture.py /opt/executor-proof/
ENTRYPOINT ["python3", "/opt/executor-proof/codex-executor.py", "/usr/local/bin/codex", "0.164.0"]
