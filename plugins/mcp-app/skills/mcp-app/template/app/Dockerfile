# The example app. Replace this folder with your own app: see "Replace the example app" in
# README.md for what the gateway expects of it.
FROM python:3.13-alpine
WORKDIR /app
COPY server.py ./
COPY static ./static
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
ENTRYPOINT ["python", "/app/server.py"]
