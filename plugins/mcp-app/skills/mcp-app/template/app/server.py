"""The example app of the kit: replace it with your own.

It shows that the pieces work together. It lists the files in the data folder (the volume
that the MCP server writes to), shows one of them as text, and has one small form that writes
a note file, so that a form goes through the checks of the gateway.

What a replacement must keep (the contract with the gateway):
  - it listens on 127.0.0.1:8080 and has NO login of its own: the gateway lets only the
    logged-in owner through, and nothing else can reach this address;
  - a form arrives only when the gateway found that it comes from this site;
  - the paths that anybody may read are the setting OPEN_PATHS (here: /static/);
  - the files that the MCP server sees are in DATA_DIR (/data).

Python standard library only.
"""
import html
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

DATA = Path(os.environ.get("DATA_DIR", "/data"))
PORT = int(os.environ.get("PORT", "8080"))
BIND = os.environ.get("APP_BIND", "127.0.0.1")
STATIC = Path(__file__).resolve().parent / "static"

MAX_BODY = 64 * 1024            # bytes of a form
MAX_NOTE = 20_000               # characters of a note
MAX_SHOWN = 256 * 1024          # bytes of a file that is shown as text
MAX_LISTED = 200                # files in the list
NOTE_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,59}")
# One part of a path to a file: no "..", no dot at its start, nothing odd.
SAFE_PART = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._ -]{0,120}")
E = html.escape

HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; "
                               "base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


def page(title, body):
    return ("<!doctype html><html lang=en><head><meta charset=utf-8>"
            "<meta name=viewport content='width=device-width,initial-scale=1'>"
            "<title>%s</title><link rel=stylesheet href='/static/app.css'></head>"
            "<body><main>%s</main></body></html>" % (E(title), body))


def safe_file(rest):
    """The file under DATA that a path names, or None. Every part must be a plain name, and
    the file must really be inside DATA (a link that leads out of it is not shown)."""
    parts = rest.split("/")
    if not parts or not all(SAFE_PART.fullmatch(part) for part in parts):
        return None
    found = DATA.joinpath(*parts)
    try:
        if not found.is_file() or found.is_symlink():
            return None
        found.resolve().relative_to(DATA.resolve())
    except (OSError, ValueError):
        return None
    return found


def listed():
    """The files in DATA as paths from DATA, sorted. Hidden files and links are left out."""
    found = []
    for folder, folders, files in os.walk(DATA):
        folders[:] = sorted(name for name in folders if SAFE_PART.fullmatch(name))
        for name in sorted(files):
            file = Path(folder) / name
            if SAFE_PART.fullmatch(name) and not file.is_symlink():
                found.append(file.relative_to(DATA).as_posix())
            if len(found) >= MAX_LISTED:
                return found
    return found


def home():
    rows = "".join('<li><a href="/f/%s">%s</a></li>' % (quote(name), E(name)) for name in listed())
    return page("Example app", "<h1>You are logged in</h1>"
                "<p>This is the example app of the kit. The gateway let you in; this page has no login "
                "of its own.</p>"
                "<h2>Files</h2>"
                "<p>These are the files in the data folder. The MCP server sees the same folder: ask "
                "your MCP client to write a file, and it shows up here.</p>"
                + ("<ul>%s</ul>" % rows if rows else "<p class=quiet>No files yet.</p>")
                + "<h2>Write a note</h2>"
                "<form method=post action=/notes>"
                "<label for=name>Name</label>"
                "<input id=name name=name required maxlength=60 pattern='[a-z0-9][a-z0-9-]*' "
                "autocapitalize=off autocomplete=off>"
                "<p class=quiet>Small letters, digits and -. The note is saved as notes/&lt;name&gt;.md</p>"
                "<label for=text>Text</label>"
                "<textarea id=text name=text rows=5 required maxlength=%d></textarea>"
                "<button>Save the note</button></form>" % MAX_NOTE)


def file_page(rest, file):
    data = file.read_bytes()[:MAX_SHOWN + 1]
    text = data[:MAX_SHOWN].decode("utf-8", "replace")
    more = "<p class=quiet>Only the start of the file is shown.</p>" if len(data) > MAX_SHOWN else ""
    return page(rest, '<p><a href="/">All files</a></p><h1>%s</h1><pre>%s</pre>%s' % (E(rest), E(text), more))


def message(title, text):
    return page(title, '<p><a href="/">All files</a></p><h1>%s</h1><p>%s</p>' % (E(title), E(text)))


class Handler(BaseHTTPRequestHandler):
    server_version = "app"
    sys_version = ""
    timeout = 15

    def log_message(self, *args):
        pass        # the gateway writes the log of the requests

    def _send(self, status, body, kind="text/html; charset=utf-8", location=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        for name, value in HEADERS.items():
            self.send_header(name, value)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        if location:
            self.send_header("Location", location)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/":
            self._send(200, home())
        elif path == "/static/app.css":
            self._send(200, (STATIC / "app.css").read_bytes(), kind="text/css; charset=utf-8")
        elif path.startswith("/f/"):
            rest = unquote(path[3:])
            file = safe_file(rest)
            if file is None:
                self._send(404, message("Not found", "There is no such file."))
            else:
                self._send(200, file_page(rest, file))
        else:
            self._send(404, message("Not found", "There is no such page."))

    do_HEAD = do_GET

    def do_POST(self):
        if urlsplit(self.path).path != "/notes":
            self._send(404, message("Not found", "There is no such page."))
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            self._send(413, message("Too large", "That is too much text to save."))
            return
        fields = parse_qs(self.rfile.read(length).decode("utf-8", "replace"), keep_blank_values=True)
        name = (fields.get("name") or [""])[0].strip()
        text = (fields.get("text") or [""])[0].replace("\r\n", "\n")
        if not NOTE_NAME.fullmatch(name):
            self._send(400, message("Not saved", "The name may hold small letters, digits and - only."))
            return
        if not text.strip() or len(text) > MAX_NOTE:
            self._send(400, message("Not saved", "The note is empty or too long."))
            return
        folder = DATA / "notes"
        if folder.is_symlink():
            self._send(400, message("Not saved", "The notes folder is not a plain folder."))
            return
        folder.mkdir(exist_ok=True)
        target = folder / (name + ".md")
        if target.is_symlink():
            self._send(400, message("Not saved", "A note of this name cannot be written."))
            return
        target.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
        self._send(303, "", location="/f/notes/%s.md" % name)


def main():
    # There is no login here: only the gateway, in the same pod, may reach this address.
    if BIND != "127.0.0.1":
        sys.exit("The example app has no login of its own: it listens on 127.0.0.1 only (APP_BIND=%s)." % BIND)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
