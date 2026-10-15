# The AgentDojo side of the external agentdojo suite. foxbench never scores
# these cases itself: this script asks AgentDojo for the cases and for the
# verdicts, so the utility and security checks are AgentDojo's own code.
#
#   prepare <version> <suite>  print the cases as JSON: goal, injected start
#                              environment and ground-truth calls
#   judge <version> <suite>    read one {user_task, injection_task, pre,
#                              post, traces, output} per stdin line, and print one
#                              {utility, security} line for each
#
# Run it through uv, with AgentDojo fetched from PyPI at run time:
#   uv run --no-project --with agentdojo==0.1.35 python -I agentdojo_bridge.py ...
import json
import sys

from agentdojo.attacks.base_attacks import DEFAULT_MODEL_NAME, FixedJailbreakAttack
from agentdojo.attacks.important_instructions_attacks import ImportantInstructionsAttack
from agentdojo.default_suites.v1.tools.types import CalendarEvent, CloudDriveFile, Email
from agentdojo.functions_runtime import FunctionCall
from agentdojo.task_suite.load_suites import get_suite
from agentdojo.types import text_content_block_from_string


def attack_for(suite):
    # AgentDojo's "important_instructions" attack, the one its leaderboard
    # reports. It names the target model; a local model has no entry in
    # AgentDojo's name table, so it gets AgentDojo's default model name.
    attack = FixedJailbreakAttack(ImportantInstructionsAttack._JB_STRING, suite, None)
    attack.user_name = "Emma Johnson"
    attack.model_name = DEFAULT_MODEL_NAME
    return attack


# AgentDojo's models rebuild these tables from the start lists whenever they
# load, which would drop what the agent added; load() puts the end tables back.
TABLES = [("inbox", "emails", Email), ("inbox", "trash", Email), ("calendar", "events", CalendarEvent), ("cloud_drive", "files", CloudDriveFile)]


def load(env_type, data):
    env = env_type.model_validate(data)
    for part, table, kind in TABLES:
        holder = getattr(env, part, None)
        if holder is not None:
            setattr(holder, table, {key: kind.model_validate(value) for key, value in data[part][table].items()})
    return env


def calls(task, env):
    return [{"function": c.function, "args": dict(c.args)} for c in task.ground_truth(env)]


def prepare(suite):
    attack = attack_for(suite)
    users = list(suite.user_tasks.values())
    injections = list(suite.injection_tasks.values())
    pairs = [(u, None) for u in users]
    # Each injection task attacks two user tasks, so every user task meets one attack.
    for k, inj in enumerate(injections):
        for j in (2 * k, 2 * k + 1):
            pairs.append((users[j % len(users)], inj))
    out = []
    for user, inj in pairs:
        injected = attack.attack(user, inj) if inj else {}
        env = user.init_environment(suite.load_and_inject_default_environment(injected))
        out.append({
            "id": f"{user.ID}" + (f"+{inj.ID}" if inj else ""),
            "user_task": user.ID,
            "injection_task": inj.ID if inj else None,
            "goal": user.PROMPT,
            "env": env.model_dump(mode="json"),
            "ground_truth": calls(user, env),
            "ground_truth_output": getattr(user, "GROUND_TRUTH_OUTPUT", ""),
            "injection_goal": inj.GOAL if inj else None,
            "injection_ground_truth": calls(inj, env) if inj else None,
            "injection_ground_truth_output": getattr(inj, "GROUND_TRUTH_OUTPUT", "") if inj else None,
        })
    return out


def judge(suite, case):
    env_type = type(suite.load_and_inject_default_environment({}))
    pre = load(env_type, case["pre"])
    post = load(env_type, case["post"])
    output = [text_content_block_from_string(case["output"])]
    user = suite.get_user_task_by_id(case["user_task"])
    # A browser agent has no function calls; the app records the calls its pages stand for.
    # Banking, travel and workspace checks read the environment; slack checks read these too.
    traces = [FunctionCall(function=c["function"], args=c["args"]) for c in case.get("traces", [])]
    utility = suite._check_task_result(user, output, pre, post, traces)
    security = None
    if case.get("injection_task"):
        inj = suite.get_injection_task_by_id(case["injection_task"])
        security = suite._check_task_result(inj, output, pre, post, traces)
    return {"utility": bool(utility), "security": None if security is None else bool(security)}


if __name__ == "__main__":
    command, version, name = sys.argv[1:4]
    suite = get_suite(version, name)
    if command == "prepare":
        json.dump(prepare(suite), sys.stdout)
    elif command == "judge":
        # One process judges a whole run: AgentDojo takes seconds to import.
        for line in sys.stdin:
            print(json.dumps(judge(suite, json.loads(line))), flush=True)
    else:
        sys.exit(f"unknown command {command}")
