# A fake of the parts of the appworld package that foxbench's bridge uses,
# for tests: one notes app and the supervisor, three tasks, and an evaluator
# with two unit tests. No AppWorld code or data is in it.
import collections as collections_
import os
import sys
import types

__version__ = os.environ.get("FAKE_APPWORLD_VERSION", "0.1.3.post1")
TASKS = {"train": [], "dev": ["fake3_1"], "test_normal": ["fake1_1"], "test_challenge": ["fake2_1"]}
PASSWORD = "pw-<b>"
DOCS = {
    "supervisor": [("show_account_passwords", "GET", []), ("complete_task", "POST", [("answer", "string", False)])],
    "notes": [
        ("login", "POST", [("username", "string", True), ("password", "string", True)]),
        ("add_note", "POST", [("access_token", "string", True), ("title", "string", True), ("pinned", "boolean", False), ("tags", "list[string]", False), ("stars", "integer", False)]),
        ("show_notes", "GET", [("access_token", "string", True)]),
    ],
}
state = {"world": None}
path_store = types.SimpleNamespace(data=os.path.join(os.environ.get("APPWORLD_ROOT", "."), "data"), experiment_outputs=os.path.join(os.environ.get("APPWORLD_ROOT", "."), "experiments", "outputs"))

def verify_fully_installed():
    if os.environ.get("FAKE_APPWORLD_UNPACKED") == "0":
        raise Exception("The appworld package is not fully installed.")

def fail(code, message):
    raise Exception(f"Response status code is {code}:\n{{\"message\": \"{message}\"}}")

class Api:
    def __init__(self, world, app):
        self.world, self.app = world, app

    def __getattr__(self, api):
        def call(**args):
            w = self.world
            if self.app == "api_docs":
                return [{"name": n, "description": f"The {n} API."} for n, _, _ in DOCS[args["app_name"]]] if api == "show_api_descriptions" else \
                    next({"app_name": args["app_name"], "api_name": n, "path": f"/{n}", "method": m, "description": f"The {n} API.", "parameters": [{"name": p, "type": t, "required": r, "description": f"The {p}.", "default": None, "constraints": []} for p, t, r in ps], "response_schemas": {}} for n, m, ps in DOCS[args["app_name"]] if n == args["api_name"])
            if api == "show_account_passwords":
                return [{"account_name": "notes", "password": PASSWORD}]
            if api == "complete_task":
                w.completed = True
                return {"message": "Marked the active task complete."}
            if api == "login":
                return {"access_token": "token-1", "token_type": "Bearer"} if args.get("password") == PASSWORD else fail(401, "Invalid credentials")
            if args.get("access_token") != "token-1":
                fail(401, "Invalid token")
            if api == "add_note":
                w.notes.append({k: v for k, v in args.items() if k != "access_token"})
                ModelHashHandler.data[w.output_db_home_path_in_memory]["notes"] = len(w.notes)
                return {"message": "Note added.", "note_id": len(w.notes), "score": 4.0}
            return w.notes
        return call

class AppWorld:
    def __init__(self, task_id, experiment_name="default", **kwargs):
        if task_id not in sum(TASKS.values(), []):
            raise FileNotFoundError(f"The task {task_id} has no data.")
        self.task_id, self.experiment_name = task_id, experiment_name
        self.notes, self.completed = [], False
        self.task = types.SimpleNamespace(instruction=f"Task {task_id}: add a pinned note titled groceries, tagged milk and eggs.", allowed_apps=["api_docs", "supervisor", "notes"],
                                          supervisor={"first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com", "phone_number": "5550100"})
        self.output_db_home_path_in_memory = f":memory:{task_id}"
        self.apis = types.SimpleNamespace(**{a: Api(self, a) for a in self.task.allowed_apps})
        self.requester = types.SimpleNamespace(reset_request_count=lambda: None)
        # The real AppWorld writes outputs here; the bridge must turn these off.
        self._prepare_directories()
        self._save_state(os.path.join(path_store.experiment_outputs, experiment_name, "tasks", task_id, "dbs"))
        self.save_logs()
        state["world"] = self

    def _prepare_directories(self):
        os.makedirs(os.path.join(path_store.experiment_outputs, self.experiment_name, "tasks", self.task_id, "logs"), exist_ok=True)

    def _save_state(self, directory):
        os.makedirs(directory, exist_ok=True)
        open(os.path.join(directory, "notes.jsonl"), "w").write(repr(self.notes))

    def save_logs(self):
        open(os.path.join(path_store.experiment_outputs, self.experiment_name, "tasks", self.task_id, "logs", "api_calls.jsonl"), "w").write("")

    def task_completed(self):
        return self.completed

    def close(self):
        state["world"] = None

def load_task_ids(dataset_name):
    return TASKS[dataset_name]

class ModelHashHandler:
    data = collections_.defaultdict(dict)

class ModelCollection:
    @classmethod
    def load(cls, to_db_home_path=None, from_db_home_path=None, **kwargs):
        # As upstream: a path on disk must exist, an in-memory one is the open world's, and the hashes of `to` are reset.
        if not from_db_home_path.startswith(":memory:") and not os.path.exists(from_db_home_path):
            raise Exception("The from_db_home_path does not exist.")
        ModelHashHandler.data[to_db_home_path] = {}
        return state["world"]

def evaluate_task(task_id, experiment_name="default", suppress_errors=True, save_report=True):
    memory = f":memory:{task_id}"
    end = ModelCollection.load(to_db_home_path=memory, from_db_home_path=os.path.join(path_store.experiment_outputs, experiment_name, "tasks", task_id, "dbs"))
    want = {"title": "groceries", "pinned": True, "tags": ["milk", "eggs"]}
    added = any(all(n.get(k) == v for k, v in want.items()) for n in end.notes)
    # Like AppWorld's collateral-damage tests, this one reads the model hashes.
    results = [added and ModelHashHandler.data[memory].get("notes") == len(end.notes) == 1, end.completed]
    return types.SimpleNamespace(success=all(results), pass_count=sum(results), fail_count=len(results) - sum(results))

# The submodules the bridge imports.
for name, attrs in {"cli": {"verify_fully_installed": verify_fully_installed}, "evaluator": {"evaluate_task": evaluate_task}, "collections": {}, "collections.models": {"ModelCollection": ModelCollection},
                    "common": {}, "common.path_store": {"path_store": path_store}, "apps": {}, "apps.model_lib": {"ModelHashHandler": ModelHashHandler}}.items():
    sys.modules[f"appworld.{name}"] = sub = types.ModuleType(f"appworld.{name}")
    sub.__dict__.update(attrs)
    setattr(sys.modules[sub.__name__.rsplit(".", 1)[0]], name.rsplit(".", 1)[-1], sub)
