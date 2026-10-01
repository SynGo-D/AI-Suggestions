# Runtime for the AI suggestions service.
#
# Two binaries beyond Node, both shelled out to rather than bound as
# libraries: `git`, to apply and verify the generated patch, and `docker`,
# to run the validation image. Only the CLIENT is installed here — the
# daemon it talks to is the host's, reached through a mounted socket, and
# the implications of that are in deploy/docker-compose.yml where the
# mounting is decided rather than here where it is merely possible.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PIP_NO_CACHE_DIR=1

# docker-cli only: no containerd, no daemon, nothing that could start one.
# A few megabytes rather than the several hundred of docker.io, and it
# cannot accidentally become a second daemon on this host.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && apt-get purge -y gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so this layer survives a source-only change.
# `npm ci --omit=dev` because the service runs TypeScript directly through
# Node's type stripping — tsc and eslint are for CI, not for runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src/ ./src/
COPY tsconfig.json ./

# The job directory holds source snapshots, findings and patches. It is a
# mounted volume in the deployment; this exists so the service can start
# without one, and so the directory is owned by the user that writes it.
RUN mkdir -p /app/data/jobs && chown -R node:node /app/data

# node:22-bookworm-slim ships an unprivileged `node` user. The Docker
# socket is root-owned, so compose adds the host's docker group rather
# than running this as root — see the deployment for that decision.
USER node

EXPOSE 8010

# 0.0.0.0 inside the container, which is private to the compose network.
# The default is loopback, and a container's loopback reaches nothing.
ENV HOST=0.0.0.0 \
    PORT=8010 \
    JOB_DIRECTORY=/app/data/jobs

CMD ["node", "--experimental-strip-types", "src/server.ts"]
