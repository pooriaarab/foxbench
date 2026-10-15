# The tau2 side of the tau2 benchmarks. foxbench's pages only collect
# arguments; this script runs each call through tau2's own environment, so
# the tools, their errors and the database are tau2's code. The verdict is
# tau2's own evaluate_simulation on the trajectory the pages recorded.
# `serve <domain>` reads one JSON request per line and writes one reply line:
#   {"op": "reset"} | {"op": "call", "name", "arguments"} | {"op": "task", "id"}
#   | {"op": "evaluate", "id", "events", "stop"}
# While it evaluates, an LLM call of tau2's NL-assertion judge goes out as an
# {"llm": {"system", "prompt"}} line, and the next stdin line is {"text"} or {"error"}.
# bridge.ts runs it under uv.
import contextlib
import json
import os
import re
import sys
import uuid

# tau2 prints and logs at import time; replies go to our own copy of stdout (T7).
replies = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
with contextlib.redirect_stdout(sys.stderr):
    from loguru import logger

    logger.remove()
    import tau2.evaluator.evaluator_nl_assertions as nl
    from tau2.data_model.message import AssistantMessage, ToolCall, ToolMessage, UserMessage
    from tau2.data_model.simulation import SimulationRun, TerminationReason
    from tau2.evaluator.evaluator import EvaluationType, evaluate_simulation
    from tau2.orchestrator.orchestrator import DEFAULT_FIRST_AGENT_MESSAGE
    from tau2.registry import registry
    from tau2.user.user_simulator import UserSimulator


def ask_judge(model, messages, **kwargs):
    """tau2's NL-assertion judge, answered by foxbench's judge (Claude), not by tau2's default model (T14)."""
    replies.write(json.dumps({"llm": {"system": messages[0].content, "prompt": messages[1].content}}) + "\n")
    answer = json.loads(sys.stdin.readline())
    if "error" in answer:
        raise RuntimeError(answer["error"])
    # tau2 reads the reply as bare JSON; a model may fence it.
    text = answer["text"]
    found = re.search(r"\{.*\}", text, re.S)
    return AssistantMessage(role="assistant", content=found.group(0) if found else text)


nl.generate = ask_judge


def trajectory(events):
    out = []
    for n, e in enumerate(events):
        if e["kind"] == "call":
            call = ToolCall(id=f"call_{n}", name=e["name"], arguments=e["arguments"])
            out.append(AssistantMessage(role="assistant", tool_calls=[call]))
            out.append(ToolMessage(id=call.id, role="tool", content=e["content"], error=e["error"]))
        elif e["kind"] == "agent":
            out.append(AssistantMessage(role="assistant", content=e["text"]))
        else:
            out.append(UserMessage(role="user", content=e["text"]))
    return out


def evaluate(domain, tasks, request):
    task = tasks[request["id"]]
    stop = TerminationReason.USER_STOP if request["stop"] == "user" else TerminationReason.AGENT_STOP
    run = SimulationRun(id=str(uuid.uuid4()), task_id=task.id, start_time="", end_time="", duration=0.0,
                        termination_reason=stop, messages=trajectory(request["events"]))
    info = evaluate_simulation(run, task, EvaluationType.ALL, solo_mode=False, domain=domain)
    return {"reward": info.reward, "info": info.model_dump(mode="json")}


def serve(domain):
    make = registry.get_env_constructor(domain)
    tasks = {t.id: t for t in registry.get_tasks_loader(domain)("base")}
    env = make()
    count = 0
    while line := sys.stdin.readline():
        request = json.loads(line)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                if request["op"] == "reset":
                    env = make()
                    reply = {"ok": True}
                elif request["op"] == "task":
                    task = tasks[request["id"]]
                    prompt = UserSimulator(llm="none", instructions=str(task.user_scenario)).system_prompt
                    reply = {"ok": True, "system": prompt, "greeting": DEFAULT_FIRST_AGENT_MESSAGE.content}
                elif request["op"] == "evaluate":
                    reply = {"ok": True, **evaluate(domain, tasks, request)}
                else:
                    count += 1
                    call = ToolCall(id=f"call_{count}", name=request["name"], arguments=request["arguments"])
                    message = env.get_response(call)
                    reply = {"ok": True, "content": message.content, "error": bool(message.error)}
        except Exception as error:  # a bad request, not a tool error: tau2 returns those as messages
            reply = {"ok": False, "message": f"{type(error).__name__}: {error}"}
        replies.write(json.dumps(reply) + "\n")


if __name__ == "__main__":
    command, name = sys.argv[1:3]
    if command != "serve":
        sys.exit(f"unknown command {command}")
    serve(name)
