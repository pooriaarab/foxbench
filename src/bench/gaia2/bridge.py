# The ARE side of the gaia2 benchmark: its apps, events and judge are ARE's own
# code, run in this process; foxbench's pages only call the tools. One JSON
# request per line on stdin, one reply per line, in order: ops cases, start,
# call, notifications, oracle, judge. The soft rubric asks out as {"llm": {"id",
# "system", "prompt"}}; one reader thread takes the answer {"answer": id, "text"|"error"} from stdin.
import contextlib
import dataclasses
import json
import os
import queue
import sys
import threading
import uuid

# ARE prints and logs a lot; replies go to our own copy of stdout (G8).
replies = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
with contextlib.redirect_stdout(sys.stderr):
    import logging

    logging.disable(logging.CRITICAL)
    import pyarrow.parquet as pq
    from are.simulation.data_handler.importer import JsonScenarioImporter
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.notification_system import VerboseNotificationSystem
    from are.simulation.scenarios.config import MAX_SCENARIO_DURATION, MAX_TIME_SCENARIO_DURATION
    from are.simulation.scenarios.scenario_imported_from_json.utils import get_scenario_duration, preprocess_scenario
    from are.simulation.types import EnvironmentType, EventType
    from are.simulation.validation.configs import GraphPerEventJudgeConfig, ScriptedGraphPerEventJudgeConfig
    from are.simulation.validation.constants import TOOL_ARG_CHECKER_TYPE_REGISTRY, CheckerType

requests, answers, out, run = queue.Queue(), {}, threading.Lock(), {"env": None, "scenario": None, "asked": 0}
SOFT = {k for k, v in TOOL_ARG_CHECKER_TYPE_REGISTRY.items() if CheckerType.llm_checker in v.values()}

def reader():
    for line in sys.stdin:
        message = json.loads(line)
        (answers[message["answer"]] if "answer" in message else requests).put(message)
    requests.put(None)

def send(reply):
    with out:
        replies.write(json.dumps(reply) + "\n")

def engine(messages, additional_trace_tags=None):
    """ARE's judge engine, answered by foxbench's judge (Claude), not by ARE's default Llama (G7)."""
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    prompt = "\n\n".join(f"[{m['role']}]\n{m['content']}" for m in messages if m["role"] != "system")
    key = str(uuid.uuid4())
    waiting = answers[key] = queue.Queue()
    run["asked"] += 1
    send({"llm": {"id": key, "system": system, "prompt": prompt}})
    answer = waiting.get()
    del answers[key]
    if "error" in answer:
        raise RuntimeError(answer["error"])
    return answer["text"], {}

def plain(value):
    return json.loads(json.dumps(value, default=lambda o: dataclasses.asdict(o) if dataclasses.is_dataclass(o) else getattr(o, "value", str(o))))

def cases(files):
    found = []
    for config, path in files.items():
        for row in pq.read_table(path).to_pylist():
            events = json.loads(row["data"])["events"]
            soft = any(f"{e['action']['app']}__{e['action']['function']}" in SOFT for e in events if e["event_type"] == "AGENT")
            found.append({"id": row["id"], "config": config, "soft": soft})
    return {"cases": found}

def start(file, id, soft):
    if run["env"]:
        run["env"].stop()
    row = pq.read_table(file, filters=[("id", "=", id)]).to_pylist()[0]
    scenario, _, _ = JsonScenarioImporter().import_from_json_to_benchmark(row["data"], load_completed_events=True)
    config = (GraphPerEventJudgeConfig if soft else ScriptedGraphPerEventJudgeConfig)(engine=engine)
    preprocess_scenario(scenario, judge_config=config, max_scenario_duration=get_scenario_duration(scenario, MAX_TIME_SCENARIO_DURATION, MAX_SCENARIO_DURATION))
    settings = EnvironmentConfig(time_increment_in_seconds=scenario.time_increment_in_seconds, start_time=scenario.start_time or None)
    env = Environment(environment_type=EnvironmentType.CLI, config=settings, notification_system=VerboseNotificationSystem())
    env.run(scenario, wait_for_end=False)
    run.update(env=env, scenario=scenario, asked=0, tools={(t.app_name, t.func_name): t for t in env.get_tools()})
    return {"tools": [{"app": t.app_name, "name": t.func_name, "description": t.function_description, "write": bool(t.write_operation),
                       "args": [{"name": a.name, "type": str(a.arg_type), "description": a.description, "required": not a.has_default} for a in t.args]}
                      for t in run["tools"].values()]}

def call(app, tool, args):
    """Form text to the tool's types: JSON for all but strings; a blank optional argument is left out."""
    try:
        t, given = run["tools"][(app, tool)], {}
        for a in t.args:
            text = args.get(a.name)
            if text is None or (text == "" and a.has_default):
                continue
            try:
                given[a.name] = text if str(a.arg_type).startswith("str") else json.loads(text)
            except ValueError:
                given[a.name] = text
        return {"content": json.dumps(plain(t(**given))), "error": False}
    except Exception as error:  # a tool error is the agent's, not the harness's
        return {"content": f"{type(error).__name__}: {error}", "error": True}

def judge():
    result = run["scenario"].validate(run["env"])
    if result.exception:
        raise result.exception
    return {"success": bool(result.success), "rationale": str(result.rationale), "asked": run["asked"]}

OPS = {
    "cases": lambda r: cases(r["files"]),
    "start": lambda r: start(r["file"], r["id"], r["soft"]),
    "call": lambda r: call(r["app"], r["tool"], r["args"]),
    "notifications": lambda r: {"notifications": [{"type": m.message_type.value, "message": m.message, "at": m.timestamp.timestamp() - run["env"].start_time}
                                                  for m in run["env"].notification_system.message_queue.list_view()]},
    "oracle": lambda r: {"events": [{"app": e.action.app.name, "tool": e.action.function.__name__, "at": e.event_time - run["scenario"].start_time, "result": plain(e.metadata.return_value),
                                     "args": plain({k: v for k, v in e.get_args().items() if k != "self"})}
                                    for e in run["scenario"].oracle_run_event_log if e.event_type == EventType.AGENT]},
    "judge": lambda r: judge(),
}

def serve():
    threading.Thread(target=reader, daemon=True).start()
    while (request := requests.get()) is not None:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                reply = {"ok": True, **OPS[request["op"]](request)}
        except Exception as error:  # a bad request, not a tool error
            reply = {"ok": False, "message": f"{type(error).__name__}: {error}"}
        send(reply)

if __name__ == "__main__":
    serve()
