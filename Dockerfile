FROM node:22-bookworm-slim
# Bash, GNU tar and coreutils are already part of this Debian base image.
RUN bash --version && tar --version && md5sum --version
WORKDIR /opt/ctf-author
COPY package.json ./
COPY app ./app
ENV NODE_ENV=production PORT=8080 CTF_WORKSPACE=/workspace TZ=Europe/Bucharest
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "app/server.mjs"]
