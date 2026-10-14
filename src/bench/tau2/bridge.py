# The tau2 side of the tau2 benchmarks. foxbench's pages only collect
# arguments; this script runs each call through tau2's own environment, so
# the tools, their errors and the database are tau2's code.
# `serve <domain>` reads one JSON request per line ({"op": "reset"} or
# {"op": "call", "name", "arguments"}) and writes one reply line. bridge.ts runs it under uv.
import contextlib
import json
import os
import sys

# tau2 prints and logs at import time; replies go to our own copy of stdout (T7).
replies = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
with contextlib.redirect_stdout(sys.stderr):
    from loguru import logger

    logger.remove()
    from tau2.data_model.message import ToolCall
    from tau2.registry import registry


def serve(domain):
    make = registry.get_env_constructor(domain)
    env = make()
    count = 0
    for line in sys.stdin:
        request = json.loads(line)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                if request["op"] == "reset":
                    env = make()
                    reply = {"ok": True}
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
