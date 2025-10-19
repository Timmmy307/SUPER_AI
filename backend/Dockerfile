FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates curl fonts-liberation libasound2 libxkbcommon0 \
    libnss3 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxi6 \
    libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && playwright install chromium

COPY . .
ENV PORT=8000
EXPOSE 8000
CMD ["uvicorn","main:app","--host","0.0.0.0","--port","8000"]
