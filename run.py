import sys
import os
import webbrowser
import threading
import time

def main():
    print("=" * 70)
    print("   Schedulr — University Timetable Clash Resolver")
    print("   Powered by Google OR-Tools CP-SAT & FastAPI")
    print("=" * 70)

    try:
        import ortools
        import fastapi
        import uvicorn
        print(f"[OK] Google OR-Tools CP-SAT version: {ortools.__version__}")
        print(f"[OK] FastAPI version: {fastapi.__version__}")
    except ImportError as e:
        print(f"[ERROR] Missing required library: {e}")
        print("Please install via: pip install fastapi uvicorn pydantic ortools")
        sys.exit(1)

    port = 8000
    host = "127.0.0.1"
    url = f"http://{host}:{port}"

    def open_browser():
        time.sleep(1.5)
        print(f"\n[LAUNCH] Opening Schedulr in browser: {url}")
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=open_browser, daemon=True).start()

    print(f"\n[SERVER] Starting web application server at: {url}")
    print(f"[API] Interactive OpenAPI Swagger docs available at: {url}/docs\n")

    # Run uvicorn
    import uvicorn
    uvicorn.run("backend.main:app", host=host, port=port, reload=False)

if __name__ == "__main__":
    main()
