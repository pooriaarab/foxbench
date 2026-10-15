# The AppWorld side of the appworld benchmark, run in the user's own AppWorld
# install. Each task's world stays in memory: AppWorld's output folders, state
# saves and logs are turned off, and bridge.ts runs this with python -B, so
# nothing AppWorld decrypted is written to disk (AW1). Calls run through
# AppWorld's own APIs; AppWorld's own evaluator gives the verdict (AW4).
# `check` prints one JSON line. `serve` reads one JSON request per line and writes one reply line:
#   {"op": "tasks"} | {"op": "open", "id"} | {"op": "call", "app", "api", "args"} | {"op": "evaluate"}
import copy
import json
import os
import re
import sys

# Replies go to our own copy of stdout; AppWorld's prints go to stderr, which bridge.ts drops (AW1).
replies = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
sys.stdout = sys.stderr
VERSION = "0.1.3.post1"
SPLITS = ["train", "dev", "test_normal", "test_challenge"]
EXPERIMENT = "foxbench"


def check():
    try:
        import appworld
        from appworld.cli import verify_fully_installed
    except ImportError:
        return {"ready": False, "why": "missing"}
    try:
        verify_fully_installed()
    except Exception:
        return {"ready": False, "why": "unpacked"}
    return {"ready": appworld.__version__ == VERSION, "why": "version", "version": appworld.__version__}


def number(text):
    return int(text) if re.fullmatch(r"-?\d+", text) else float(text)


def convert(kind, text):
    """A form field's text as the value the API doc's type asks for (AW5)."""
    if kind.startswith("list["):
        items = json.loads(text) if text.lstrip().startswith("[") else [t.strip() for t in text.split(",") if t.strip()]
        return [convert(kind[5:-1], str(i)) for i in items]
    if kind == "boolean":
        if text.lower() not in ("true", "false"):
            raise ValueError("must be true or false")
        return text.lower() == "true"
    if kind in ("integer", "number"):
        return int(text) if kind == "integer" else number(text)
    if kind == "number | integer | string":
        try:
            return number(text)
        except ValueError:
            return text
    return text


def serve():
    from appworld import AppWorld, evaluator, load_task_ids
    from appworld.apps.model_lib import ModelHashHandler
    from appworld.collections import models
    from appworld.common.path_store import path_store

    for name in ("_prepare_directories", "_save_state", "save_logs"):
        setattr(AppWorld, name, lambda self, *args, **kwargs: None)
    now = {"world": None, "docs": {}, "tokens": {}}
    load = models.ModelCollection.load.__func__

    def load_in_memory(cls, to_db_home_path=None, from_db_home_path=None, **kwargs):
        # The evaluator reads the end state from the outputs on disk; here it is the open world's memory.
        # A load resets the model hashes that a save to disk would keep, so they are put back (AW4).
        world = now["world"]
        if not world or from_db_home_path != os.path.join(path_store.experiment_outputs, EXPERIMENT, "tasks", world.task_id, "dbs"):
            return load(cls, to_db_home_path=to_db_home_path, from_db_home_path=from_db_home_path, **kwargs)
        hashes = copy.deepcopy(ModelHashHandler.data[world.output_db_home_path_in_memory])
        collection = load(cls, to_db_home_path=to_db_home_path, from_db_home_path=world.output_db_home_path_in_memory, **kwargs)
        ModelHashHandler.data[to_db_home_path] = hashes
        return collection

    models.ModelCollection.load = classmethod(load_in_memory)

    def difficulty(task_id):
        with open(os.path.join(path_store.data, "tasks", task_id, "ground_truth", "metadata.json")) as f:
            return json.load(f)["difficulty"]

    def start(task_id):
        if now["world"]:
            now["world"].close()
        world = now["world"] = AppWorld(task_id=task_id, experiment_name=EXPERIMENT)
        docs = world.apis.api_docs
        now["docs"] = {app: {d["name"]: docs.show_api_doc(app_name=app, api_name=d["name"]) for d in docs.show_api_descriptions(app_name=app)}
                       for app in world.task.allowed_apps if app != "api_docs"}
        now["tokens"] = {}  # AW7
        return {"goal": world.task.instruction, "supervisor": world.task.supervisor,
                "apps": {app: [{"name": name, **{k: d[k] for k in ("description", "method", "parameters")}} for name, d in apis.items()] for app, apis in now["docs"].items()}}

    def call(app, api, args):
        world, values = now["world"], {}
        try:
            for p in now["docs"][app][api]["parameters"]:
                text = str(args.get(p["name"], ""))
                if not text.strip() and p["name"] == "access_token":
                    text = now["tokens"].get(app, "")  # AW6
                if text.strip():  # a string keeps its spaces; other types are parsed from the stripped text
                    values[p["name"]] = text if p["type"] == "string" else convert(p["type"], text.strip())
        except ValueError as error:
            return {"error": f"{p['name']} ({p['type']}): {error}", "completed": world.task_completed()}
        try:
            result = getattr(getattr(world.apis, app), api)(**values)
        except Exception as error:  # an API error: the agent sees it, as a code agent would
            return {"error": str(error), "completed": world.task_completed()}
        finally:
            world.requester.reset_request_count()  # one call is one interaction
        if isinstance(result, dict) and "access_token" in result:
            now["tokens"][app] = result["access_token"]
        # `json` is Python's own text of the result: a float such as 4.0 stays a float, which a JSON round trip through Node would make 4.
        return {"result": result, "json": json.dumps(result), "completed": world.task_completed()}

    def evaluate():
        world = now["world"]
        tracker = evaluator.evaluate_task(task_id=world.task_id, experiment_name=EXPERIMENT, suppress_errors=True, save_report=False)
        return {"success": bool(tracker.success), "passes": tracker.pass_count, "fails": tracker.fail_count, "completed": world.task_completed()}

    while line := sys.stdin.readline():
        request = json.loads(line)
        try:
            op = request["op"]
            if op == "tasks":
                out = {"tasks": [{"id": i, "split": s, "difficulty": difficulty(i)} for s in SPLITS for i in load_task_ids(s)]}
            else:
                out = start(request["id"]) if op == "open" else call(request["app"], request["api"], request["args"]) if op == "call" else evaluate()
            replies.write(json.dumps({"ok": True, **out}) + "\n")
        except Exception as error:  # a harness fault: its message can hold AppWorld text, so only the name goes out (AW1)
            replies.write(json.dumps({"ok": False, "message": type(error).__name__}) + "\n")


if __name__ == "__main__":
    if sys.argv[1] == "check":
        replies.write(json.dumps(check()) + "\n")
    else:
        serve()
