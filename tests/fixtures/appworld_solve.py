# The scripted agents of tests/appworld-real.test.ts. It runs in the user's
# own AppWorld install: `perfect` runs a train or dev task's own solution
# (AppWorld's ground truth) with each API call made through the site's
# pages, as a browser agent would; `wrong` does the same but skips every
# write (a form that posts) except sign-ins and complete_task, whose
# answer it changes.
# Usage: appworld_solve.py <perfect|wrong> <task id> <site origin>. Nothing is written to disk.
import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.stdout = sys.stderr
from appworld.apps.api_lib import set_local_date_and_time  # noqa: E402
from appworld.task import Task  # noqa: E402

mode, task_id, origin = sys.argv[1:4]
RESULT = re.compile(r'<script type="application/json" id="result">(.*?)</script>', re.S)
ALERT = re.compile(r'<p role="alert">(.*?)</p>', re.S)
writes = {}
calls = []


def is_write(app, api):
    if (app, api) not in writes:
        writes[app, api] = 'method="post"' in urllib.request.urlopen(f"{origin}/{app}/{api}").read().decode()
    return writes[app, api]


def text(value):
    return json.dumps(value) if isinstance(value, (bool, list)) else str(value)


class Api:
    def __init__(self, app):
        self.app = app

    def __getattr__(self, api):
        def call(**args):
            calls.append(api)
            if len(calls) > 5000:  # a skipped write can make a solution loop
                sys.exit("too many calls")
            if mode == "wrong" and api == "complete_task":
                args = {**args, "answer": "none"} if args.get("answer") is not None else args
            elif mode == "wrong" and api != "login" and is_write(self.app, api):
                return {}
            body = urllib.parse.urlencode({k: text(v) for k, v in args.items() if v is not None}).encode()
            try:
                page = urllib.request.urlopen(f"{origin}/{self.app}/{api}", data=body).read().decode()
            except urllib.error.HTTPError as error:
                raise Exception(html.unescape(ALERT.search(error.read().decode()).group(1))) from None
            return json.loads(html.unescape(RESULT.search(page).group(1)))
        return call


class Apis:
    def __getattr__(self, app):
        return Api(app)


task = Task.load(task_id=task_id, ground_truth_mode="full")
set_local_date_and_time(task.datetime)  # the solution reads the clock, as in AppWorld, at the task's date
solution = task.ground_truth.compiled_solution_module().solution
try:
    solution(apis=Apis(), requester=None)
except Exception:
    if mode == "perfect":
        raise
