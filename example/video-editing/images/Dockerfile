# Offline renderer profiles. AI guidance and model gateways remain in the caller application.
FROM node:22-trixie-slim AS common
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ffmpeg chromium fonts-liberation fonts-noto-color-emoji \
    e2fsprogs util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Workers are offline; telemetry is turned off as well, so nothing tries to send it.
ENV HOME=/workspace/user TMPDIR=/workspace/tmp HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium \
    IMAGEIO_FFMPEG_EXE=/usr/bin/ffmpeg PYTHONDONTWRITEBYTECODE=1 HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1
WORKDIR /workspace

FROM common AS hyperframes
RUN npm install --global hyperframes@0.8.181 && npm cache clean --force

FROM common AS remotion
RUN npm install --prefix /opt/remotion --save-exact \
    remotion@4.0.542 @remotion/cli@4.0.542 @remotion/bundler@4.0.542 \
    @remotion/renderer@4.0.542 @remotion/captions@4.0.542 react@19.2.0 react-dom@19.2.0 \
 && npm cache clean --force && chmod -R a+rX /opt/remotion
ENV NODE_PATH=/opt/remotion/node_modules PATH=/opt/remotion/node_modules/.bin:$PATH

FROM common AS moviepy
RUN python3 -m venv /opt/moviepy && /opt/moviepy/bin/pip install --no-cache-dir moviepy==2.2.1
ENV PATH=/opt/moviepy/bin:$PATH
