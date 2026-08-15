FROM node:20-slim

# ffmpeg (com libass pra queimar legenda) + python/pip pro yt-dlp
RUN apt-get update && \
    apt-get install -y ffmpeg python3-pip curl && \
    pip3 install --break-system-packages -U yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install

COPY index.js .

EXPOSE 8080
CMD ["npm", "start"]
