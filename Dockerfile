FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py index.html sw.js manifest.webmanifest icon-192.png icon-512.png ./
RUN mkdir -p /app/data
ENV DATA_FILE=/app/data/latest.json
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
