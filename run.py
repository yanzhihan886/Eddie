from app import app


if __name__ == "__main__":
    import os

    host = os.environ.get("SELLER_MVP_HOST", "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
    port = int(os.environ.get("PORT", os.environ.get("SELLER_MVP_PORT", "8765")))
    app.run(host=host, port=port, debug=False)
