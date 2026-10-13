"""Tests for the example app (app/server.py).
Run:  python3 -B -m unittest discover -s tests -p 'test_*.py'
"""
import http.client
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(tempfile.mkdtemp(prefix="example-app-test-"))
os.environ["DATA_DIR"] = str(DATA)
sys.path.insert(0, str(ROOT / "app"))

import server  # noqa: E402

HTTPD = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
PORT = HTTPD.server_address[1]
threading.Thread(target=HTTPD.serve_forever, daemon=True).start()


def ask(method, path, fields=None, headers=None, body=None):
    """(status, headers, text) of one request."""
    connection = http.client.HTTPConnection("127.0.0.1", PORT, timeout=5)
    sent = dict(headers or {})
    if fields is not None:
        body = urlencode(fields)
        sent["Content-Type"] = "application/x-www-form-urlencoded"
    connection.request(method, path, body=body, headers=sent)
    answer = connection.getresponse()
    text = answer.read().decode("utf-8", "replace")
    connection.close()
    return answer.status, dict(answer.getheaders()), text


class Base(unittest.TestCase):
    def setUp(self):
        for entry in DATA.iterdir():
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()


class Pages(Base):
    def test_the_home_page_says_that_the_login_worked_and_lists_the_files(self):
        (DATA / "notes").mkdir()
        (DATA / "notes" / "first.md").write_text("# First\n")
        (DATA / "report <b>.txt").write_text("x")
        (DATA / ".hidden").write_text("x")
        status, headers, page = ask("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("<h1>You are logged in</h1>", page)
        self.assertIn('<li><a href="/f/notes/first.md">notes/first.md</a></li>', page)
        # A name is written as text, and a hidden file is not listed.
        self.assertNotIn("<b>", page)
        self.assertNotIn(".hidden", page)
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")

    def test_without_files_it_says_so(self):
        self.assertIn("<p class=quiet>No files yet.</p>", ask("GET", "/")[2])

    def test_every_answer_has_the_headers_that_keep_a_page_safe(self):
        for path in ("/", "/static/app.css", "/nothing", "/f/nothing"):
            headers = ask("GET", path)[1]
            self.assertEqual(headers["Content-Security-Policy"], "default-src 'none'; style-src 'self'; "
                             "form-action 'self'; base-uri 'none'; frame-ancestors 'none'", path)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff", path)
            self.assertEqual(headers["Cache-Control"], "no-store", path)

    def test_the_pages_have_no_script_and_load_nothing_from_another_site(self):
        (DATA / "a.txt").write_text("text")
        for path in ("/", "/f/a.txt", "/nothing"):
            page = ask("GET", path)[2]
            for word in ("<script", "style=", "http://", "https://", "<img", "onclick"):
                self.assertNotIn(word, page, path)

    def test_the_stylesheet(self):
        status, headers, css = ask("GET", "/static/app.css")
        self.assertEqual((status, headers["Content-Type"]), (200, "text/css; charset=utf-8"))
        self.assertIn("prefers-color-scheme: dark", css)
        self.assertNotIn("url(", css)

    def test_head_answers_without_a_body(self):
        status, headers, body = ask("HEAD", "/")
        self.assertEqual((status, body), (200, ""))
        self.assertGreater(int(headers["Content-Length"]), 100)


class Files(Base):
    def test_a_file_is_shown_as_text(self):
        (DATA / "a.md").write_text("# Title\n<script>alert(1)</script>\n")
        status, _headers, page = ask("GET", "/f/a.md")
        self.assertEqual(status, 200)
        self.assertIn("<pre># Title\n&lt;script&gt;alert(1)&lt;/script&gt;\n</pre>", page)

    def test_a_long_file_shows_its_start(self):
        (DATA / "long.txt").write_text("x" * (server.MAX_SHOWN + 10))
        page = ask("GET", "/f/long.txt")[2]
        self.assertIn("Only the start of the file is shown.", page)
        self.assertLess(len(page), server.MAX_SHOWN + 2000)

    def test_nothing_outside_the_data_folder_is_shown(self):
        outside = Path(tempfile.mkdtemp(prefix="example-app-outside-"))
        (outside / "secret.txt").write_text("SECRET")
        (DATA / "link.txt").symlink_to(outside / "secret.txt")
        (DATA / "folder").symlink_to(outside)
        (DATA / ".env").write_text("SECRET")
        for path in ("/f/../secret.txt", "/f/%2e%2e/secret.txt", "/f/..%2fsecret.txt", "/f/link.txt",
                     "/f/folder/secret.txt", "/f/.env", "/f//etc/passwd", "/f/", "/f/a/../../x", "/f/%00"):
            status, _headers, page = ask("GET", path)
            self.assertEqual(status, 404, path)
            self.assertNotIn("SECRET", page, path)
        self.assertNotIn("link.txt", ask("GET", "/")[2])


class Notes(Base):
    def test_a_note_is_written_into_the_notes_folder(self):
        status, headers, _page = ask("POST", "/notes", {"name": "first-note", "text": "Hello\r\nthere"})
        self.assertEqual((status, headers["Location"]), (303, "/f/notes/first-note.md"))
        self.assertEqual((DATA / "notes" / "first-note.md").read_text(), "Hello\nthere\n")
        self.assertIn("<pre>Hello\nthere\n</pre>", ask("GET", "/f/notes/first-note.md")[2])

    def test_a_name_that_is_not_plain_is_refused_and_nothing_is_written(self):
        for name in ("", "../x", "a/b", "A", "a b", ".a", "-a", "a" * 61, "a.md"):
            status, _headers, page = ask("POST", "/notes", {"name": name, "text": "x"})
            self.assertEqual(status, 400, name)
            self.assertIn("The name may hold small letters, digits and - only.", page)
        self.assertFalse((DATA / "notes").exists())

    def test_an_empty_or_too_long_note_is_refused(self):
        for text in ("", "   \n", "x" * (server.MAX_NOTE + 1)):
            self.assertEqual(ask("POST", "/notes", {"name": "a", "text": text})[0], 400)
        self.assertFalse((DATA / "notes" / "a.md").exists())

    def test_a_form_that_is_too_large_is_refused(self):
        status, _headers, _page = ask("POST", "/notes", headers={"Content-Length": str(server.MAX_BODY + 1)}, body="")
        self.assertEqual(status, 413)
        self.assertEqual(ask("POST", "/notes", headers={"Content-Length": "abc"}, body="")[0], 413)

    def test_a_note_is_never_written_through_a_link(self):
        outside = Path(tempfile.mkdtemp(prefix="example-app-outside-"))
        (DATA / "notes").mkdir()
        (DATA / "notes" / "a.md").symlink_to(outside / "a.md")
        self.assertEqual(ask("POST", "/notes", {"name": "a", "text": "x"})[0], 400)
        self.assertFalse((outside / "a.md").exists())
        shutil.rmtree(DATA / "notes")
        (DATA / "notes").symlink_to(outside)
        self.assertEqual(ask("POST", "/notes", {"name": "b", "text": "x"})[0], 400)
        self.assertFalse((outside / "b.md").exists())

    def test_only_the_note_form_takes_a_post(self):
        for path in ("/", "/f/a", "/static/app.css", "/notes/x"):
            self.assertEqual(ask("POST", path, {"name": "a", "text": "x"})[0], 404, path)


class Start(unittest.TestCase):
    def test_it_starts_only_on_the_address_that_the_gateway_reaches(self):
        # The app has no login of its own: on another address anybody in the cluster could read it.
        for bind in ("0.0.0.0", "", "::"):
            done = subprocess.run([sys.executable, "-B", str(ROOT / "app" / "server.py")], capture_output=True, text=True,
                                  timeout=20, env={**os.environ, "APP_BIND": bind, "PORT": "0"})
            self.assertNotEqual(done.returncode, 0, bind)
            self.assertIn("127.0.0.1 only", done.stderr, bind)


if __name__ == "__main__":
    unittest.main()
