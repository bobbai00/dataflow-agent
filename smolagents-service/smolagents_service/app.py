# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""The web server: accounts, the trace API, and the chat UI mounted behind the login.

    /register, /login, /logout   HTML forms; a login is an httpOnly cookie naming a
                                 server-side login record (store.logins)
    /app/                        the Gradio chat and trace pages, for signed-in users
    /api/me, /api/runs, /api/runs/{id}, /api/events
                                 the signed-in user's own traces as JSON

Gradio sees the user through `auth_dependency`, so `gr.Request.username` is the
signed-in user in every handler.
"""

import asyncio
import html
import os
import re
import tempfile
from pathlib import Path

import gradio as gr
from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from .config import Config
from .sessions import Sessions, adopt_old_folders
from .store import AuthError, Store
from .ui import build_ui

COOKIE = "smolagents_login"
HEARTBEAT = re.compile(r"^/app/gradio_api/heartbeat/([^/]+)$")

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · smolagents analyst</title>
<style>
  :root {{ color-scheme: light dark; --fg: #1f2328; --bg: #f6f8fa; --card: #fff; --line: #d0d7de; --accent: #0969da; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --fg: #e6edf3; --bg: #0d1117; --card: #161b22; --line: #30363d;
    --accent: #4493f8; }} }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 16px/1.5 system-ui, sans-serif; }}
  form {{ width: min(360px, calc(100vw - 32px)); background: var(--card); border: 1px solid var(--line);
    border-radius: 12px; padding: 28px; box-sizing: border-box; }}
  h1 {{ font-size: 1.3rem; margin: 0 0 18px; }}
  label {{ display: block; margin: 12px 0 4px; font-size: .9rem; }}
  input {{ width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px;
    background: transparent; color: inherit; font: inherit; }}
  button {{ width: 100%; margin-top: 20px; padding: 10px; border: 0; border-radius: 8px; background: var(--accent);
    color: #fff; font: inherit; font-weight: 600; cursor: pointer; }}
  .error {{ color: #cf222e; font-size: .9rem; margin: 0 0 8px; }}
  .alt {{ margin-top: 16px; font-size: .9rem; text-align: center; }}
  a {{ color: var(--accent); }}
</style></head>
<body><form method="post" action="{action}">
  <h1>{title}</h1>
  {error}
  <label for="username">Username</label>
  <input id="username" name="username" autocomplete="username" required value="{username}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="{password_hint}" required>
  <button type="submit">{title}</button>
  <p class="alt">{alternative}</p>
</form></body></html>"""


def page(kind: str, error: str = "", username: str = "") -> HTMLResponse:
    login = kind == "login"
    return HTMLResponse(PAGE.format(
        title="Sign in" if login else "Create an account",
        action="/login" if login else "/register",
        error=f'<p class="error">{html.escape(error)}</p>' if error else "",
        username=html.escape(username),
        password_hint="current-password" if login else "new-password",
        alternative='No account yet? <a href="/register">Create one</a>' if login
        else 'Have an account? <a href="/login">Sign in</a>',
    ), status_code=400 if error else 200)


class HeartbeatWatch:
    """Reports when each tab's heartbeat stream opens and when its client goes away.

    An open tab holds one streaming request to Gradio's heartbeat endpoint. Under
    this Starlette nothing reads the server's `http.disconnect` message during
    that stream, so a closed tab's stream runs on forever (and Gradio's `unload`
    event never fires). This reads it, cancels the stream so Gradio cleans up its
    side, and reports the session as gone; Sessions closes it once it has stayed
    gone for the grace period, so a heartbeat that reconnects keeps the agent.
    """

    def __init__(self, app, sessions: Sessions):
        self.app = app
        self.sessions = sessions

    async def __call__(self, scope, receive, send):
        beat = HEARTBEAT.match(scope.get("path", "")) if scope["type"] == "http" else None
        if beat is None:
            return await self.app(scope, receive, send)
        messages: asyncio.Queue = asyncio.Queue()

        async def until_disconnect():
            while True:
                message = await receive()
                await messages.put(message)
                if message["type"] == "http.disconnect":
                    return

        self.sessions.heartbeat_opened(beat.group(1))
        listener = asyncio.ensure_future(until_disconnect())
        stream = asyncio.ensure_future(self.app(scope, messages.get, send))
        try:
            await asyncio.wait({listener, stream}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (listener, stream):
                task.cancel()
            await asyncio.gather(listener, stream, return_exceptions=True)
            self.sessions.heartbeat_closed(beat.group(1))


class LoginWall:
    """Sends anonymous visitors of the chat page to the login form instead of a bare 401."""

    def __init__(self, app, signed_in):
        self.app = app
        self.signed_in = signed_in

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] in ("/app", "/app/") and not self.signed_in(Request(scope)):
            return await RedirectResponse("/login", status_code=303)(scope, receive, send)
        return await self.app(scope, receive, send)


def use_private_temp(data_dir: Path) -> None:
    """Send uploads and rendered figures under the data directory, which the workers' sandbox
    denies, instead of the shared system temp folder. Process-wide: call once, before create_app."""
    scratch = data_dir / "tmp"
    scratch.mkdir(parents=True, exist_ok=True)
    os.environ["GRADIO_TEMP_DIR"] = str(scratch / "gradio")
    tempfile.tempdir = str(scratch)


def create_app(config: Config) -> FastAPI:
    config.data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(config.data_dir / "traces.db")
    adopt_old_folders(config, store)
    sessions = Sessions(store, config)
    app = FastAPI(title="smolagents analyst")
    app.state.store, app.state.sessions, app.state.config = store, sessions, config

    def current_user(request: Request) -> dict | None:
        token = request.cookies.get(COOKIE)
        return store.user_for_token(token) if token else None

    def signed_in(user: dict) -> RedirectResponse:
        response = RedirectResponse("/app/", status_code=303)
        response.set_cookie(COOKIE, store.create_login(user["id"], config.login_days),
                            max_age=int(config.login_days * 86400), httponly=True, samesite="lax",
                            secure=config.secure_cookies)
        return response

    def require_user(request: Request) -> dict:
        user = current_user(request)
        if user is None:
            raise HTTPException(status_code=401, detail="Sign in first")
        return user

    @app.get("/")
    def home(request: Request):
        return RedirectResponse("/app/" if current_user(request) else "/login", status_code=303)

    @app.get("/login")
    def login_form():
        return page("login")

    @app.post("/login")
    def login(username: str = Form(...), password: str = Form(...)):
        user = store.authenticate(username, password)
        if user is None:
            store.record_event(None, "login_failed", None, username=username)
            return page("login", "Wrong username or password.", username)
        store.record_event(user["id"], "login")
        return signed_in(user)

    @app.get("/register")
    def register_form():
        return page("register")

    @app.post("/register")
    def register(username: str = Form(...), password: str = Form(...)):
        try:
            user_id = store.create_user(username, password)
        except AuthError as refused:
            return page("register", str(refused), username)
        store.record_event(user_id, "register")
        return signed_in({"id": user_id, "username": username})

    @app.get("/logout")
    def logout(request: Request):
        token, user = request.cookies.get(COOKIE), current_user(request)
        if token:
            store.delete_login(token)
        if user:
            store.record_event(user["id"], "logout")
        response = RedirectResponse("/login", status_code=303)
        response.delete_cookie(COOKIE)
        return response

    @app.get("/api/me")
    def me(request: Request):
        return require_user(request)

    @app.get("/api/runs")
    def runs(request: Request, limit: int = 100):
        return store.list_runs(require_user(request)["id"], min(max(limit, 1), 1000))

    @app.get("/api/runs/{run_id}")
    def run(run_id: str, request: Request, context: bool = False):
        found = store.get_run(require_user(request)["id"], run_id, context=context)
        if found is None:
            raise HTTPException(status_code=404, detail="No such run")
        return found

    @app.delete("/api/runs/{run_id}")
    def delete_run(run_id: str, request: Request):
        paths = store.delete_run(require_user(request)["id"], run_id)
        if paths is None:
            raise HTTPException(status_code=404, detail="No such run")
        for path in paths:
            if Path(path).is_relative_to(config.data_dir / "users"):
                Path(path).unlink(missing_ok=True)
        return Response(status_code=204)

    @app.get("/api/events")
    def events(request: Request, limit: int = 200):
        return store.list_events(require_user(request)["id"], min(max(limit, 1), 1000))

    @app.get("/healthz")
    def health():
        return {"ok": True, "open_sessions": sessions.open_count()}

    demo = build_ui(store, sessions, config)
    demo.queue(default_concurrency_limit=config.concurrency)
    gr.mount_gradio_app(app, demo, path="/app", ssr_mode=False, theme="ocean",
                        auth_dependency=lambda request: (current_user(request) or {}).get("username"))
    app.add_middleware(LoginWall, signed_in=lambda request: current_user(request) is not None)
    app.add_middleware(HeartbeatWatch, sessions=sessions)
    return app
