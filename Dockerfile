# FROM ubuntu:20.04
FROM node:16-alpine

# RUN curl -sL https://deb.nodesource.com/setup_16.x | bash
# RUN apt install nodejs && npm install -g npm
# RUN node -v; npm -v;

# RUN useradd -m -u 1000 -U -s /bin/sh forker && \
#     mkdir -p /data && \
#     chown -R forker:forker /data

COPY . .
RUN npm install && npm prune --omit=dev

# USER forker

ENV HTTP_RPC_ENDPOINT=http://localhost::9933
ENV FORK_CHUNKS_LEVEL=1
ENV QUICK_MODE=false

VOLUME [ "/data" ]

ENTRYPOINT [ "./scripts/docker-start.sh" ]
